package grouping

import "testing"

func TestNormalizeMessage(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"hex addresses", "error at 0x7fff5fbff8c8", "error at 0xn"},
		{"uuids", "user a1b2c3d4-e5f6-7890-abcd-ef1234567890 not found", "user <uuid> not found"},
		{"path numbers", "/users/123/posts/456", "/users/n/posts/n"},
		{"quoted strings", `Cannot read "foo" of undefined`, `cannot read "..." of undefined`},
		{"combined", `Error 0xAB at /api/users/42: "timeout"`, `error 0xn at /api/users/n: "..."`},
		{"already clean", "typeerror: cannot read properties of undefined", "typeerror: cannot read properties of undefined"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := normalizeMessage(tt.input)
			if got != tt.want {
				t.Errorf("normalizeMessage(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestFingerprint_StableAcrossVariableContent(t *testing.T) {
	fp1 := Fingerprint("TypeError", "Cannot read property of user 123", "at foo.js:1\nat bar.js:2")
	fp2 := Fingerprint("TypeError", "Cannot read property of user 456", "at foo.js:1\nat bar.js:2")
	if fp1 != fp2 {
		t.Errorf("fingerprints should match: %s != %s", fp1, fp2)
	}
}

func TestFingerprint_DifferentErrorTypesDiffer(t *testing.T) {
	fp1 := Fingerprint("TypeError", "msg", "at foo.js:1")
	fp2 := Fingerprint("RangeError", "msg", "at foo.js:1")
	if fp1 == fp2 {
		t.Errorf("different error types should produce different fingerprints")
	}
}
