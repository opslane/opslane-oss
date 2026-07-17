package auth

import (
	"context"
	"net/url"
	"testing"

	workos "github.com/workos/workos-go/v9"
)

type fakeWorkOSClient struct {
	response *workos.AuthenticateResponse
}

func (f fakeWorkOSClient) AuthorizationURL(req AuthRequest) (string, error) {
	values := url.Values{"state": {req.State}, "redirect_uri": {req.RedirectURI}}
	return "https://auth.example/authorize?" + values.Encode(), nil
}

func (f fakeWorkOSClient) AuthenticateCode(context.Context, string) (*workos.AuthenticateResponse, error) {
	return f.response, nil
}

func TestWorkOSProviderMapsIdentity(t *testing.T) {
	name := "Ada Lovelace"
	avatar := "https://images.example/ada.png"
	provider := newWorkOSProviderWithClient(fakeWorkOSClient{response: &workos.AuthenticateResponse{
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
