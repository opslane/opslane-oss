package auth

import (
	"fmt"
	"strings"
)

// SocialProvider is a public, provider-agnostic social login identifier used by
// handlers and the dashboard. The WorkOS-specific spelling lives in workos.go.
type SocialProvider string

const (
	SocialProviderGoogle SocialProvider = "google"
	SocialProviderGitHub SocialProvider = "github"
)

// DecodeSocialProvider maps external input to a known SocialProvider. It trims
// and lowercases, and returns ok=false for anything not in the fixed set, so raw
// request input never becomes a provider value.
func DecodeSocialProvider(raw string) (SocialProvider, bool) {
	switch SocialProvider(strings.ToLower(strings.TrimSpace(raw))) {
	case SocialProviderGoogle:
		return SocialProviderGoogle, true
	case SocialProviderGitHub:
		return SocialProviderGitHub, true
	default:
		return "", false
	}
}

// SocialProviderConfig is the deployment's enabled social logins. It holds an
// order-stable slice for API responses and a set for O(1) validation, so the
// buttons rendered and the ?provider= values accepted can never drift.
type SocialProviderConfig struct {
	ordered []SocialProvider
	set     map[SocialProvider]struct{}
}

// ParseSocialProviders parses AUTH_WORKOS_SOCIAL ("google,github"). It trims,
// lowercases, and dedupes, preserving first-appearance order. An unrecognized
// value is an error so a typo fails the process at boot instead of silently
// disabling a button.
func ParseSocialProviders(raw string) (SocialProviderConfig, error) {
	cfg := SocialProviderConfig{
		ordered: []SocialProvider{},
		set:     map[SocialProvider]struct{}{},
	}
	for _, part := range strings.Split(raw, ",") {
		if strings.TrimSpace(part) == "" {
			continue
		}
		provider, ok := DecodeSocialProvider(part)
		if !ok {
			return SocialProviderConfig{}, fmt.Errorf("unknown social provider %q in AUTH_WORKOS_SOCIAL", strings.TrimSpace(part))
		}
		if _, exists := cfg.set[provider]; exists {
			continue
		}
		cfg.set[provider] = struct{}{}
		cfg.ordered = append(cfg.ordered, provider)
	}
	return cfg, nil
}

// Allows reports whether provider is enabled.
func (c SocialProviderConfig) Allows(provider SocialProvider) bool {
	_, ok := c.set[provider]
	return ok
}

// Ordered returns the enabled providers as public strings for API responses,
// always as a non-nil slice.
func (c SocialProviderConfig) Ordered() []string {
	out := make([]string, 0, len(c.ordered))
	for _, provider := range c.ordered {
		out = append(out, string(provider))
	}
	return out
}
