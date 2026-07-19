package auth

import (
	"context"
	"errors"
	"net/url"
	"testing"

	workos "github.com/workos/workos-go/v9"
)

type fakeWorkOSClient struct {
	response      *workos.AuthenticateResponse
	err           error
	createErr     error
	createdEmail  string
	resetResponse *workos.ResetPasswordResponse
}

func (f *fakeWorkOSClient) AuthorizationURL(req AuthRequest) (string, error) {
	values := url.Values{"state": {req.State}, "redirect_uri": {req.RedirectURI}}
	return "https://auth.example/authorize?" + values.Encode(), nil
}

func (f *fakeWorkOSClient) AuthenticateCode(context.Context, string) (*workos.AuthenticateResponse, error) {
	return f.response, f.err
}

func (f *fakeWorkOSClient) AuthenticatePassword(context.Context, string, string) (*workos.AuthenticateResponse, error) {
	return f.response, f.err
}

func (f *fakeWorkOSClient) CreateUser(_ context.Context, email, _ string) error {
	f.createdEmail = email
	return f.createErr
}

func (f *fakeWorkOSClient) AuthenticateEmailVerification(context.Context, string, string) (*workos.AuthenticateResponse, error) {
	return f.response, f.err
}

func (f *fakeWorkOSClient) StartPasswordReset(context.Context, string) error { return f.err }

func (f *fakeWorkOSClient) ConfirmPasswordReset(context.Context, string, string) (*workos.ResetPasswordResponse, error) {
	return f.resetResponse, f.err
}

func TestWorkOSProviderMapsIdentity(t *testing.T) {
	name := "Ada Lovelace"
	avatar := "https://images.example/ada.png"
	provider := newWorkOSProviderWithClient(&fakeWorkOSClient{response: &workos.AuthenticateResponse{
		User: &workos.User{
			ID:                "user_123",
			Email:             "Ada@Example.com",
			EmailVerified:     true,
			Name:              &name,
			ProfilePictureURL: &avatar,
		},
	}})

	authorizeURL, err := provider.AuthorizeURL(AuthRequest{State: "state-1", RedirectURI: "https://app.example/auth/callback"})
	if err != nil {
		t.Fatalf("AuthorizeURL: %v", err)
	}
	parsed, _ := url.Parse(authorizeURL)
	if parsed.Query().Get("state") != "state-1" || parsed.Query().Get("redirect_uri") != "https://app.example/auth/callback" {
		t.Fatalf("unexpected authorize URL: %s", authorizeURL)
	}

	identity, err := provider.ExchangeCode(context.Background(), "code")
	if err != nil {
		t.Fatalf("ExchangeCode: %v", err)
	}
	if identity.Provider != "workos" || identity.ProviderSubject != "user_123" ||
		identity.Email != "Ada@Example.com" || !identity.EmailVerified ||
		identity.Name != name || identity.AvatarURL != avatar {
		t.Fatalf("unexpected identity: %+v", identity)
	}
}

func TestAuthenticateWithPasswordMapsIdentity(t *testing.T) {
	provider := newWorkOSProviderWithClient(&fakeWorkOSClient{response: &workos.AuthenticateResponse{
		User: &workos.User{ID: "user_9", Email: "a@b.co", EmailVerified: true},
	}})
	identity, err := provider.AuthenticateWithPassword(context.Background(), "a@b.co", "hunter22")
	if err != nil {
		t.Fatalf("AuthenticateWithPassword: %v", err)
	}
	if identity.ProviderSubject != "user_9" || identity.Provider != "workos" {
		t.Fatalf("unexpected identity: %+v", identity)
	}
}

func TestAuthenticateWithPasswordTranslatesErrors(t *testing.T) {
	cases := []struct {
		name   string
		sdkErr error
		check  func(*testing.T, error)
	}{
		{
			name: "email verification pending",
			sdkErr: &workos.APIError{ErrorCode: workos.EmailVerificationRequiredCode,
				PendingAuthenticationToken: "pat_1", EmailVerificationID: "ev_1"},
			check: func(t *testing.T, err error) {
				var pending *PendingVerificationError
				if !errors.As(err, &pending) || pending.PendingAuthenticationToken != "pat_1" {
					t.Fatalf("want pending verification with token, got %v", err)
				}
			},
		},
		{
			name:   "bad password",
			sdkErr: &workos.AuthenticationError{APIError: &workos.APIError{StatusCode: 401, ErrorCode: "invalid_credentials"}},
			check: func(t *testing.T, err error) {
				if !errors.Is(err, ErrInvalidCredentials) {
					t.Fatalf("want ErrInvalidCredentials, got %v", err)
				}
			},
		},
		{
			name:   "mfa challenge unsupported",
			sdkErr: &workos.APIError{ErrorCode: workos.MFAChallengeCode, PendingAuthenticationToken: "pat_2"},
			check: func(t *testing.T, err error) {
				if !errors.Is(err, ErrUnsupportedChallenge) {
					t.Fatalf("want ErrUnsupportedChallenge, got %v", err)
				}
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			provider := newWorkOSProviderWithClient(&fakeWorkOSClient{err: tc.sdkErr})
			_, err := provider.AuthenticateWithPassword(context.Background(), "a@b.co", "x")
			tc.check(t, err)
		})
	}
}

func TestRegisterUserTranslatesProviderValidation(t *testing.T) {
	tests := []struct {
		name string
		code string
		want error
	}{
		{name: "email taken", code: "email_not_available", want: ErrEmailTaken},
		{name: "weak password", code: "password_strength_error", want: ErrWeakPassword},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			provider := newWorkOSProviderWithClient(&fakeWorkOSClient{
				createErr: &workos.UnprocessableEntityError{APIError: &workos.APIError{StatusCode: 422, Code: tc.code}},
			})
			if err := provider.RegisterUser(context.Background(), "a@b.co", "password"); !errors.Is(err, tc.want) {
				t.Fatalf("want %v, got %v", tc.want, err)
			}
		})
	}
}

func TestVerifyEmailMapsIdentity(t *testing.T) {
	provider := newWorkOSProviderWithClient(&fakeWorkOSClient{response: &workos.AuthenticateResponse{
		User: &workos.User{ID: "user_7", Email: "a@b.co", EmailVerified: true},
	}})
	identity, err := provider.VerifyEmail(context.Background(), "pat_1", "123456")
	if err != nil || identity.ProviderSubject != "user_7" {
		t.Fatalf("identity=%+v err=%v", identity, err)
	}
}

func TestCompletePasswordResetReturnsConfirmedIdentity(t *testing.T) {
	provider := newWorkOSProviderWithClient(&fakeWorkOSClient{resetResponse: &workos.ResetPasswordResponse{
		User: &workos.User{ID: "user_8", Email: "confirmed@example.com", EmailVerified: true},
	}})
	identity, err := provider.CompletePasswordReset(context.Background(), "tok", "NewPassw0rd!")
	if err != nil || identity.Email != "confirmed@example.com" || identity.ProviderSubject != "user_8" {
		t.Fatalf("identity=%+v err=%v", identity, err)
	}
}

func TestCompletePasswordResetTranslatesBadToken(t *testing.T) {
	provider := newWorkOSProviderWithClient(&fakeWorkOSClient{
		err: &workos.APIError{StatusCode: 403, Code: "password_reset_token_expired"},
	})
	_, err := provider.CompletePasswordReset(context.Background(), "tok", "NewPassw0rd!")
	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("want ErrInvalidCredentials, got %v", err)
	}
}

func TestCompletePasswordResetTranslatesWeakPassword(t *testing.T) {
	provider := newWorkOSProviderWithClient(&fakeWorkOSClient{
		err: &workos.UnprocessableEntityError{APIError: &workos.APIError{StatusCode: 422, Code: "password_strength_error"}},
	})
	_, err := provider.CompletePasswordReset(context.Background(), "tok", "weak")
	if !errors.Is(err, ErrWeakPassword) {
		t.Fatalf("want ErrWeakPassword, got %v", err)
	}
}

// The real SDK omits provider unless we set it. Without provider=authkit WorkOS
// cannot select a login method and redirects to invalid-connection-selector, so
// this exercises the true URL builder (not the fake) to lock the parameter in.
func TestWorkOSSDKAuthorizationURLRequestsAuthKit(t *testing.T) {
	client := workos.NewClient("sk_test_dummy", workos.WithClientID("client_dummy"))
	sdk := workOSSDKClient{client: client}
	got, err := sdk.AuthorizationURL(AuthRequest{State: "state-xyz", RedirectURI: "https://app.example/auth/callback"})
	if err != nil {
		t.Fatalf("AuthorizationURL: %v", err)
	}
	parsed, err := url.Parse(got)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	q := parsed.Query()
	if q.Get("provider") != "authkit" {
		t.Fatalf("provider=%q, want authkit — AuthKit hosted UI will not render otherwise. URL=%s", q.Get("provider"), got)
	}
	if q.Get("redirect_uri") != "https://app.example/auth/callback" || q.Get("state") != "state-xyz" {
		t.Fatalf("unexpected authorize URL: %s", got)
	}
}

func TestWorkOSAuthorizeURLUsesSocialProvider(t *testing.T) {
	provider, err := NewWorkOSProvider("sk_test", "client_test")
	if err != nil {
		t.Fatalf("NewWorkOSProvider: %v", err)
	}
	raw, err := provider.AuthorizeURL(AuthRequest{
		State:          "s",
		RedirectURI:    "https://app.example/auth/callback",
		SocialProvider: SocialProviderGoogle,
	})
	if err != nil {
		t.Fatalf("AuthorizeURL: %v", err)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got := parsed.Query().Get("provider"); got != "GoogleOAuth" {
		t.Fatalf("provider=%q, want GoogleOAuth", got)
	}

	raw, err = provider.AuthorizeURL(AuthRequest{
		State:          "s",
		RedirectURI:    "https://app.example/auth/callback",
		SocialProvider: SocialProviderGitHub,
	})
	if err != nil {
		t.Fatalf("AuthorizeURL for GitHub: %v", err)
	}
	parsed, err = url.Parse(raw)
	if err != nil {
		t.Fatalf("parse GitHub URL: %v", err)
	}
	if got := parsed.Query().Get("provider"); got != "GitHubOAuth" {
		t.Fatalf("provider=%q, want GitHubOAuth", got)
	}

	raw, err = provider.AuthorizeURL(AuthRequest{State: "s", RedirectURI: "https://app.example/auth/callback"})
	if err != nil {
		t.Fatalf("AuthorizeURL without social provider: %v", err)
	}
	parsed, err = url.Parse(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got := parsed.Query().Get("provider"); got != "authkit" {
		t.Fatalf("empty SocialProvider must default to authkit, got %q", got)
	}
}

func TestWorkOSAuthorizeURLRejectsUnknownSocialProvider(t *testing.T) {
	provider, err := NewWorkOSProvider("sk_test", "client_test")
	if err != nil {
		t.Fatalf("NewWorkOSProvider: %v", err)
	}
	if _, err := provider.AuthorizeURL(AuthRequest{
		State:          "s",
		RedirectURI:    "https://app.example/auth/callback",
		SocialProvider: SocialProvider("myspace"),
	}); err == nil {
		t.Fatal("expected error for unmapped social provider")
	}
}
