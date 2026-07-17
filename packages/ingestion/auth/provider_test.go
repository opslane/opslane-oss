package auth_test

import (
	"context"
	"testing"

	"github.com/opslane/opslane/packages/ingestion/auth"
)

type stubProvider struct{}

func (stubProvider) Name() string { return "stub" }
func (stubProvider) AuthorizeURL(req auth.AuthRequest) (string, error) {
	return "https://idp.example/authorize?state=" + req.State, nil
}
func (stubProvider) ExchangeCode(context.Context, string) (auth.Identity, error) {
	return auth.Identity{Provider: "stub", ProviderSubject: "s1", Email: "a@b.com", EmailVerified: true}, nil
}
func (stubProvider) SupportsLocalPasswordForm() bool { return false }

func TestAuthProviderInterface(t *testing.T) {
	var provider auth.AuthProvider = stubProvider{}
	identity, err := provider.ExchangeCode(context.Background(), "code")
	if err != nil || !identity.EmailVerified || identity.Email != "a@b.com" {
		t.Fatalf("unexpected identity: %+v err=%v", identity, err)
	}
}
