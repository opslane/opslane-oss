package auth

import (
	"reflect"
	"testing"
)

func TestDecodeSocialProvider(t *testing.T) {
	cases := []struct {
		in   string
		want SocialProvider
		ok   bool
	}{
		{"google", SocialProviderGoogle, true},
		{"github", SocialProviderGitHub, true},
		{"GOOGLE", SocialProviderGoogle, true},
		{" github ", SocialProviderGitHub, true},
		{"facebook", "", false},
		{"", "", false},
	}
	for _, testCase := range cases {
		got, ok := DecodeSocialProvider(testCase.in)
		if ok != testCase.ok || got != testCase.want {
			t.Fatalf("DecodeSocialProvider(%q) = (%q, %v), want (%q, %v)", testCase.in, got, ok, testCase.want, testCase.ok)
		}
	}
}

func TestParseSocialProviders(t *testing.T) {
	cfg, err := ParseSocialProviders("google, github ,GOOGLE")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got := cfg.Ordered(); !reflect.DeepEqual(got, []string{"google", "github"}) {
		t.Fatalf("Ordered() = %v", got)
	}
	if !cfg.Allows(SocialProviderGoogle) || !cfg.Allows(SocialProviderGitHub) {
		t.Fatal("expected google and github allowed")
	}
}

func TestParseSocialProvidersEmptyIsNonNil(t *testing.T) {
	cfg, err := ParseSocialProviders("   ")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got := cfg.Ordered()
	if got == nil || len(got) != 0 {
		t.Fatalf("Ordered() = %#v, want non-nil empty slice", got)
	}
	if cfg.Allows(SocialProviderGoogle) {
		t.Fatal("empty config must allow nothing")
	}
}

func TestParseSocialProvidersRejectsUnknown(t *testing.T) {
	if _, err := ParseSocialProviders("google,facebook"); err == nil {
		t.Fatal("expected error for unknown provider")
	}
}
