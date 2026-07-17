package auth

import (
	"fmt"
	"strings"
)

type ProviderConfig struct {
	Provider           string
	GitHubClientID     string
	GitHubClientSecret string
	WorkOSAPIKey       string
	WorkOSClientID     string
}

// SelectAuthProvider chooses the configured provider explicitly and fails closed
// for unknown or partially configured cloud modes.
func SelectAuthProvider(config ProviderConfig) (AuthProvider, error) {
	switch strings.ToLower(strings.TrimSpace(config.Provider)) {
	case "", "github":
		return GitHubProvider{ClientID: config.GitHubClientID, ClientSecret: config.GitHubClientSecret}, nil
	case "workos":
		return NewWorkOSProvider(config.WorkOSAPIKey, config.WorkOSClientID)
	default:
		return nil, fmt.Errorf("unsupported AUTH_PROVIDER %q", config.Provider)
	}
}
