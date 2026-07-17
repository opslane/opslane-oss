package auth

import "context"

// AuthRequest carries the parameters needed to start a login. RedirectURI must
// come from configured application state, never from the request Host header.
type AuthRequest struct {
	State       string
	RedirectURI string
}

// Identity is the normalized result of authenticating with an identity provider.
type Identity struct {
	Provider        string
	ProviderSubject string
	Email           string
	EmailVerified   bool
	Name            string
	AvatarURL       string
	Username        string
}

// AuthProvider proves identity. Local Postgres remains the source of truth for
// users, organizations, memberships, and sessions.
type AuthProvider interface {
	Name() string
	AuthorizeURL(req AuthRequest) (string, error)
	ExchangeCode(ctx context.Context, code string) (Identity, error)
	SupportsLocalPasswordForm() bool
}
