package auth

import (
	"context"
	"errors"
	"fmt"
	"strings"

	workos "github.com/workos/workos-go/v9"
)

type workOSClient interface {
	AuthorizationURL(AuthRequest) (string, error)
	AuthenticateCode(context.Context, string) (*workos.AuthenticateResponse, error)
	AuthenticatePassword(context.Context, string, string) (*workos.AuthenticateResponse, error)
	CreateUser(context.Context, string, string) error
	AuthenticateEmailVerification(context.Context, string, string) (*workos.AuthenticateResponse, error)
	StartPasswordReset(context.Context, string) error
	ConfirmPasswordReset(context.Context, string, string) (*workos.ResetPasswordResponse, error)
}

type workOSSDKClient struct {
	client *workos.Client
}

// workOSProviderParam maps public provider values to WorkOS SDK values. This is
// the only social-login boundary that uses WorkOS-specific vocabulary.
func workOSProviderParam(provider SocialProvider) (string, bool) {
	switch provider {
	case SocialProviderGoogle:
		return string(workos.SSOProviderGoogleOAuth), true
	case SocialProviderGitHub:
		return string(workos.SSOProviderGitHubOAuth), true
	default:
		return "", false
	}
}

func (c workOSSDKClient) AuthorizationURL(req AuthRequest) (string, error) {
	state := req.State
	// provider=authkit selects the AuthKit hosted UI. Without it WorkOS cannot
	// pick a connection and redirects to error.workos.com/sso/invalid-connection-selector.
	provider := "authkit"
	if req.SocialProvider != "" {
		mapped, ok := workOSProviderParam(req.SocialProvider)
		if !ok {
			return "", fmt.Errorf("unsupported social provider %q", req.SocialProvider)
		}
		provider = mapped
	}
	return c.client.GetAuthKitAuthorizationURL(workos.AuthKitAuthorizationURLParams{
		RedirectURI: req.RedirectURI,
		Provider:    &provider,
		State:       &state,
	})
}

func (c workOSSDKClient) AuthenticateCode(ctx context.Context, code string) (*workos.AuthenticateResponse, error) {
	return c.client.UserManagement().AuthenticateWithCode(ctx, &workos.UserManagementAuthenticateWithCodeParams{Code: code})
}

func (c workOSSDKClient) AuthenticatePassword(ctx context.Context, email, password string) (*workos.AuthenticateResponse, error) {
	return c.client.UserManagement().AuthenticateWithPassword(ctx, &workos.UserManagementAuthenticateWithPasswordParams{
		Email: email, Password: password,
	})
}

func (c workOSSDKClient) CreateUser(ctx context.Context, email, password string) error {
	_, err := c.client.UserManagement().Create(ctx, &workos.UserManagementCreateParams{
		Email: email,
		Password: workos.UserManagementPasswordPlaintext{
			Password: password,
		},
	})
	return err
}

func (c workOSSDKClient) AuthenticateEmailVerification(ctx context.Context, pendingToken, code string) (*workos.AuthenticateResponse, error) {
	return c.client.UserManagement().AuthenticateWithEmailVerification(ctx, &workos.UserManagementAuthenticateWithEmailVerificationParams{
		Code: code, PendingAuthenticationToken: pendingToken,
	})
}

func (c workOSSDKClient) StartPasswordReset(ctx context.Context, email string) error {
	_, err := c.client.UserManagement().ResetPassword(ctx, &workos.UserManagementResetPasswordParams{Email: email})
	return err
}

func (c workOSSDKClient) ConfirmPasswordReset(ctx context.Context, token, newPassword string) (*workos.ResetPasswordResponse, error) {
	return c.client.UserManagement().ConfirmPasswordReset(ctx, &workos.UserManagementConfirmPasswordResetParams{
		Token: token, NewPassword: newPassword,
	})
}

// WorkOSProvider uses AuthKit for identity proof while Opslane retains local
// authorization and session state.
type WorkOSProvider struct {
	client workOSClient
}

func NewWorkOSProvider(apiKey, clientID string) (*WorkOSProvider, error) {
	if strings.TrimSpace(apiKey) == "" || strings.TrimSpace(clientID) == "" {
		return nil, fmt.Errorf("WORKOS_API_KEY and WORKOS_CLIENT_ID are required")
	}
	client := workos.NewClient(apiKey, workos.WithClientID(clientID))
	return &WorkOSProvider{client: workOSSDKClient{client: client}}, nil
}

func newWorkOSProviderWithClient(client workOSClient) *WorkOSProvider {
	return &WorkOSProvider{client: client}
}

func (*WorkOSProvider) Name() string { return "workos" }

func (p *WorkOSProvider) AuthorizeURL(req AuthRequest) (string, error) {
	return p.client.AuthorizationURL(req)
}

func identityFromWorkOSUser(user *workos.User) Identity {
	name := ""
	if user.Name != nil {
		name = *user.Name
	} else {
		parts := make([]string, 0, 2)
		if user.FirstName != nil {
			parts = append(parts, *user.FirstName)
		}
		if user.LastName != nil {
			parts = append(parts, *user.LastName)
		}
		name = strings.Join(parts, " ")
	}
	avatarURL := ""
	if user.ProfilePictureURL != nil {
		avatarURL = *user.ProfilePictureURL
	}
	return Identity{
		Provider:        "workos",
		ProviderSubject: user.ID,
		Email:           user.Email,
		EmailVerified:   user.EmailVerified,
		Name:            name,
		AvatarURL:       avatarURL,
	}
}

func (p *WorkOSProvider) ExchangeCode(ctx context.Context, code string) (Identity, error) {
	response, err := p.client.AuthenticateCode(ctx, code)
	if err != nil {
		return Identity{}, err
	}
	if response == nil || response.User == nil {
		return Identity{}, fmt.Errorf("WorkOS authentication response did not include a user")
	}
	return identityFromWorkOSUser(response.User), nil
}

func (*WorkOSProvider) SupportsLocalPasswordForm() bool { return false }

func translateWorkOSError(err error) error {
	var apiErr *workos.APIError
	if !errors.As(err, &apiErr) {
		return err
	}
	code := apiErr.Code
	if code == "" {
		code = apiErr.ErrorCode
	}
	switch code {
	case workos.EmailVerificationRequiredCode:
		return &PendingVerificationError{
			PendingAuthenticationToken: apiErr.PendingAuthenticationToken,
			EmailVerificationID:        apiErr.EmailVerificationID,
		}
	case workos.MFAChallengeCode, workos.MFAEnrollmentCode,
		workos.OrganizationSelectionRequiredCode, workos.SSORequiredCode,
		workos.OrganizationAuthenticationMethodsRequiredCode:
		return fmt.Errorf("%w: %s", ErrUnsupportedChallenge, code)
	case "password_strength_error":
		return ErrWeakPassword
	}
	if apiErr.StatusCode == 401 || apiErr.StatusCode == 403 {
		return ErrInvalidCredentials
	}
	return err
}

func (p *WorkOSProvider) AuthenticateWithPassword(ctx context.Context, email, password string) (Identity, error) {
	response, err := p.client.AuthenticatePassword(ctx, email, password)
	if err != nil {
		return Identity{}, translateWorkOSError(err)
	}
	if response == nil || response.User == nil {
		return Identity{}, fmt.Errorf("WorkOS authentication response did not include a user")
	}
	return identityFromWorkOSUser(response.User), nil
}

func (p *WorkOSProvider) RegisterUser(ctx context.Context, email, password string) error {
	if err := p.client.CreateUser(ctx, email, password); err != nil {
		var apiErr *workos.APIError
		if errors.As(err, &apiErr) {
			if apiErr.Code == "email_not_available" {
				return ErrEmailTaken
			}
			if apiErr.Code == "password_strength_error" {
				return ErrWeakPassword
			}
		}
		return err
	}
	return nil
}

func (p *WorkOSProvider) VerifyEmail(ctx context.Context, pendingToken, code string) (Identity, error) {
	response, err := p.client.AuthenticateEmailVerification(ctx, pendingToken, code)
	if err != nil {
		return Identity{}, translateWorkOSError(err)
	}
	if response == nil || response.User == nil {
		return Identity{}, fmt.Errorf("WorkOS authentication response did not include a user")
	}
	return identityFromWorkOSUser(response.User), nil
}

func (p *WorkOSProvider) StartPasswordReset(ctx context.Context, email string) error {
	return p.client.StartPasswordReset(ctx, email)
}

func (p *WorkOSProvider) CompletePasswordReset(ctx context.Context, token, newPassword string) (Identity, error) {
	response, err := p.client.ConfirmPasswordReset(ctx, token, newPassword)
	if err != nil {
		return Identity{}, translateWorkOSError(err)
	}
	if response == nil || response.User == nil {
		return Identity{}, fmt.Errorf("WorkOS password reset response did not include a user")
	}
	return identityFromWorkOSUser(response.User), nil
}

var (
	_ PasswordAuthenticator = (*WorkOSProvider)(nil)
	_ UserRegistrar         = (*WorkOSProvider)(nil)
	_ EmailVerifier         = (*WorkOSProvider)(nil)
	_ PasswordResetter      = (*WorkOSProvider)(nil)
)
