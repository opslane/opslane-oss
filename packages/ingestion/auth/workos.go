package auth

import (
	"context"
	"fmt"
	"strings"

	workos "github.com/workos/workos-go/v9"
)

type workOSClient interface {
	AuthorizationURL(AuthRequest) (string, error)
	AuthenticateCode(context.Context, string) (*workos.AuthenticateResponse, error)
}

type workOSSDKClient struct {
	client *workos.Client
}

func (c workOSSDKClient) AuthorizationURL(req AuthRequest) (string, error) {
	state := req.State
	// provider=authkit selects the AuthKit hosted UI. Without it WorkOS cannot
	// pick a connection and redirects to error.workos.com/sso/invalid-connection-selector.
	provider := "authkit"
	return c.client.GetAuthKitAuthorizationURL(workos.AuthKitAuthorizationURLParams{
		RedirectURI: req.RedirectURI,
		Provider:    &provider,
		State:       &state,
	})
}

func (c workOSSDKClient) AuthenticateCode(ctx context.Context, code string) (*workos.AuthenticateResponse, error) {
	return c.client.UserManagement().AuthenticateWithCode(ctx, &workos.UserManagementAuthenticateWithCodeParams{Code: code})
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

func (p *WorkOSProvider) ExchangeCode(ctx context.Context, code string) (Identity, error) {
	response, err := p.client.AuthenticateCode(ctx, code)
	if err != nil {
		return Identity{}, err
	}
	if response == nil || response.User == nil {
		return Identity{}, fmt.Errorf("WorkOS authentication response did not include a user")
	}
	user := response.User
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
	}, nil
}

func (*WorkOSProvider) SupportsLocalPasswordForm() bool { return false }
