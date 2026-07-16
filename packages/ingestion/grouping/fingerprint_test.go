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

func TestFingerprint_CollapsesContentHash(t *testing.T) {
	a := Fingerprint("TypeError", "Failed to fetch dynamically imported module: https://app.example.com/assets/index-DbQ2xY9p.js", "")
	b := Fingerprint("TypeError", "Failed to fetch dynamically imported module: https://app.example.com/assets/index-Zz88Aa10.js", "")
	if a != b {
		t.Fatalf("expected same fingerprint across deploy hashes, got %s vs %s", a, b)
	}
}

func TestFingerprint_StripsHost(t *testing.T) {
	a := Fingerprint("Error", "Unable to preload CSS for https://app.example.com/assets/main-AbC12345.css", "")
	b := Fingerprint("Error", "Unable to preload CSS for /assets/main-Zx9Yq077.css", "")
	if a != b {
		t.Fatalf("expected host-independent fingerprint, got %s vs %s", a, b)
	}
}

func TestFingerprint_KeepsLogicalName(t *testing.T) {
	idx := Fingerprint("TypeError", "Failed to fetch dynamically imported module: /assets/index-AbC12345.js", "")
	vnd := Fingerprint("TypeError", "Failed to fetch dynamically imported module: /assets/vendor-AbC12345.js", "")
	if idx == vnd {
		t.Fatalf("expected index and vendor to stay distinct")
	}
}

func TestFingerprint_DoesNotCollapseOrdinaryNames(t *testing.T) {
	a := Fingerprint("TypeError", "Failed to import /assets/checkout-widget.js", "")
	b := Fingerprint("TypeError", "Failed to import /assets/checkout-button.js", "")
	if a == b {
		t.Fatalf("expected checkout-widget and checkout-button to stay distinct")
	}
}

func TestFingerprint_DoesNotCollapseLongLetterOnlyNames(t *testing.T) {
	a := Fingerprint("TypeError", "Failed to import /assets/checkout-widgetname.js", "")
	b := Fingerprint("TypeError", "Failed to import /assets/checkout-buttonname.js", "")
	if a == b {
		t.Fatalf("expected long suffixes without digits to stay distinct")
	}
}

func TestFingerprint_DropsHashedAssetQuery(t *testing.T) {
	a := Fingerprint("Error", "Unable to load /assets/main-AbC12345.js?cache=one", "")
	b := Fingerprint("Error", "Unable to load /assets/main-AbC12345.js?cache=two", "")
	if a != b {
		t.Fatalf("expected hashed asset queries to be ignored, got %s vs %s", a, b)
	}
}

func TestFingerprint_KeepsNonHashedAssetQuery(t *testing.T) {
	a := Fingerprint("Error", "Unable to load /assets/main.js?variant=one", "")
	b := Fingerprint("Error", "Unable to load /assets/main.js?variant=two", "")
	if a == b {
		t.Fatalf("expected non-hashed asset queries to stay distinct")
	}
}

func TestFingerprint_DoesNotManglePlainText(t *testing.T) {
	a := Fingerprint("Error", "Is the value correct? yes it was 5", "")
	b := Fingerprint("Error", "Is the value correct? no it was 9", "")
	if a == b {
		t.Fatalf("plain-text prose after '?' must remain part of the fingerprint")
	}
}

func TestFingerprint_NormalizesHashedFrameCoords(t *testing.T) {
	s1 := "at load (https://app.example.com/assets/index-DbQ2xY9p.js:1:100)\nat run (/assets/app-Abc12345.js:2:5)"
	s2 := "at load (https://app.example.com/assets/index-Zz88Aa10.js:9:842)\nat run (/assets/app-Zzz99999.js:7:311)"
	if Fingerprint("TypeError", "boom", s1) != Fingerprint("TypeError", "boom", s2) {
		t.Fatalf("expected hashed frame hash+coords to be normalized")
	}
}

func TestFingerprint_KeepsNonHashedFrameCoords(t *testing.T) {
	s1 := "at a (/src/app.js:42:1)"
	s2 := "at a (/src/app.js:99:1)"
	if Fingerprint("TypeError", "boom", s1) == Fingerprint("TypeError", "boom", s2) {
		t.Fatalf("expected non-hashed frames to keep line/col granularity")
	}
}
