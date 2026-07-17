package auth_test

import (
	"testing"

	"github.com/opslane/opslane/packages/ingestion/auth"
)

func TestSelectAuthProvider(t *testing.T) {
	tests := []struct {
		name      string
		config    auth.ProviderConfig
		wantName  string
		wantError bool
	}{
		{name: "default github", config: auth.ProviderConfig{}, wantName: "github"},
		{name: "explicit github", config: auth.ProviderConfig{Provider: "github"}, wantName: "github"},
		{name: "partial workos", config: auth.ProviderConfig{Provider: "workos", WorkOSAPIKey: "sk_test"}, wantError: true},
		{name: "workos", config: auth.ProviderConfig{Provider: "workos", WorkOSAPIKey: "sk_test", WorkOSClientID: "client_test"}, wantName: "workos"},
		{name: "unknown", config: auth.ProviderConfig{Provider: "other"}, wantError: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			provider, err := auth.SelectAuthProvider(tt.config)
			if tt.wantError {
				if err == nil {
					t.Fatal("expected error")
				}
				return
			}
			if err != nil || provider.Name() != tt.wantName {
				t.Fatalf("provider=%v err=%v", provider, err)
			}
		})
	}
}
