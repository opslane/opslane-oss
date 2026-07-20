package notify

import "testing"

func TestBuildIncidentURL(t *testing.T) {
	cases := []struct {
		name string
		base string
		want string
	}{
		{"https", "https://app.example.com/base/?old=1#fragment", "https://app.example.com/base/incidents/group%2F1?project_id=project%2F1"},
		{"http private host", "http://dashboard.internal", "http://dashboard.internal/incidents/group%2F1?project_id=project%2F1"},
		{"empty", "", ""},
		{"loopback hostname", "http://localhost:3000", ""},
		{"loopback ipv4", "http://127.0.0.1:3000", ""},
		{"loopback ipv6", "http://[::1]:3000", ""},
		{"credentials", "https://user:pass@app.example.com", ""},
		{"wrong scheme", "ftp://app.example.com", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := BuildIncidentURL(tc.base, "group/1", "project/1"); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}
