package notify

import "testing"

func TestValidateSlackWebhookURL(t *testing.T) {
	cases := []struct {
		name  string
		url   string
		extra []string
		ok    bool
	}{
		{"valid", "https://hooks.slack.com/services/T0/B0/xyz", nil, true},
		{"valid explicit port", "https://hooks.slack.com:443/services/T0/B0/xyz", nil, true},
		{"http scheme", "http://hooks.slack.com/services/T0/B0/x", nil, false},
		{"wrong host", "https://evil.example.com/services/x", nil, false},
		{"subdomain trick", "https://hooks.slack.com.evil.com/x", nil, false},
		{"userinfo", "https://a:b@hooks.slack.com/services/x", nil, false},
		{"odd port", "https://hooks.slack.com:8443/services/x", nil, false},
		{"empty path", "https://hooks.slack.com", nil, false},
		{"not a url", "::::", nil, false},
		{"extra host http allowed", "http://host.docker.internal:9999/hook", []string{"host.docker.internal:9999"}, true},
		{"extra host wrong port", "http://host.docker.internal:1/hook", []string{"host.docker.internal:9999"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateSlackWebhookURL(tc.url, tc.extra)
			if (err == nil) != tc.ok {
				t.Fatalf("url %q extra %v: got err=%v want ok=%v", tc.url, tc.extra, err, tc.ok)
			}
		})
	}
}

func TestFingerprintURL(t *testing.T) {
	got := FingerprintURL("https://hooks.slack.com/services/T0/B0/secretpart")
	if want := "hooks.slack.com/…/****part"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
