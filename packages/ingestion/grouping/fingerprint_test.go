package grouping

import (
	"strings"
	"testing"
)

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
	fp1 := Fingerprint("javascript", "TypeError", "Cannot read property of user 123", "at foo.js:1\nat bar.js:2")
	fp2 := Fingerprint("javascript", "TypeError", "Cannot read property of user 456", "at foo.js:1\nat bar.js:2")
	if fp1 != fp2 {
		t.Errorf("fingerprints should match: %s != %s", fp1, fp2)
	}
}

func TestFingerprint_DifferentErrorTypesDiffer(t *testing.T) {
	fp1 := Fingerprint("javascript", "TypeError", "msg", "at foo.js:1")
	fp2 := Fingerprint("javascript", "RangeError", "msg", "at foo.js:1")
	if fp1 == fp2 {
		t.Errorf("different error types should produce different fingerprints")
	}
}

func TestFingerprint_CollapsesContentHash(t *testing.T) {
	a := Fingerprint("javascript", "TypeError", "Failed to fetch dynamically imported module: https://app.example.com/assets/index-DbQ2xY9p.js", "")
	b := Fingerprint("javascript", "TypeError", "Failed to fetch dynamically imported module: https://app.example.com/assets/index-Zz88Aa10.js", "")
	if a != b {
		t.Fatalf("expected same fingerprint across deploy hashes, got %s vs %s", a, b)
	}
}

func TestFingerprint_StripsHost(t *testing.T) {
	a := Fingerprint("javascript", "Error", "Unable to preload CSS for https://app.example.com/assets/main-AbC12345.css", "")
	b := Fingerprint("javascript", "Error", "Unable to preload CSS for /assets/main-Zx9Yq077.css", "")
	if a != b {
		t.Fatalf("expected host-independent fingerprint, got %s vs %s", a, b)
	}
}

func TestFingerprint_KeepsLogicalName(t *testing.T) {
	idx := Fingerprint("javascript", "TypeError", "Failed to fetch dynamically imported module: /assets/index-AbC12345.js", "")
	vnd := Fingerprint("javascript", "TypeError", "Failed to fetch dynamically imported module: /assets/vendor-AbC12345.js", "")
	if idx == vnd {
		t.Fatalf("expected index and vendor to stay distinct")
	}
}

func TestFingerprint_DoesNotCollapseOrdinaryNames(t *testing.T) {
	a := Fingerprint("javascript", "TypeError", "Failed to import /assets/checkout-widget.js", "")
	b := Fingerprint("javascript", "TypeError", "Failed to import /assets/checkout-button.js", "")
	if a == b {
		t.Fatalf("expected checkout-widget and checkout-button to stay distinct")
	}
}

func TestFingerprint_DoesNotCollapseLongLetterOnlyNames(t *testing.T) {
	a := Fingerprint("javascript", "TypeError", "Failed to import /assets/checkout-widgetname.js", "")
	b := Fingerprint("javascript", "TypeError", "Failed to import /assets/checkout-buttonname.js", "")
	if a == b {
		t.Fatalf("expected long suffixes without digits to stay distinct")
	}
}

func TestFingerprint_DropsHashedAssetQuery(t *testing.T) {
	a := Fingerprint("javascript", "Error", "Unable to load /assets/main-AbC12345.js?cache=one", "")
	b := Fingerprint("javascript", "Error", "Unable to load /assets/main-AbC12345.js?cache=two", "")
	if a != b {
		t.Fatalf("expected hashed asset queries to be ignored, got %s vs %s", a, b)
	}
}

func TestFingerprint_KeepsNonHashedAssetQuery(t *testing.T) {
	a := Fingerprint("javascript", "Error", "Unable to load /assets/main.js?variant=one", "")
	b := Fingerprint("javascript", "Error", "Unable to load /assets/main.js?variant=two", "")
	if a == b {
		t.Fatalf("expected non-hashed asset queries to stay distinct")
	}
}

func TestFingerprint_DoesNotManglePlainText(t *testing.T) {
	a := Fingerprint("javascript", "Error", "Is the value correct? yes it was 5", "")
	b := Fingerprint("javascript", "Error", "Is the value correct? no it was 9", "")
	if a == b {
		t.Fatalf("plain-text prose after '?' must remain part of the fingerprint")
	}
}

func TestFingerprint_NormalizesHashedFrameCoords(t *testing.T) {
	s1 := "at load (https://app.example.com/assets/index-DbQ2xY9p.js:1:100)\nat run (/assets/app-Abc12345.js:2:5)"
	s2 := "at load (https://app.example.com/assets/index-Zz88Aa10.js:9:842)\nat run (/assets/app-Zzz99999.js:7:311)"
	if Fingerprint("javascript", "TypeError", "boom", s1) != Fingerprint("javascript", "TypeError", "boom", s2) {
		t.Fatalf("expected hashed frame hash+coords to be normalized")
	}
}

func TestFingerprint_KeepsNonHashedFrameCoords(t *testing.T) {
	s1 := "at a (/src/app.js:42:1)"
	s2 := "at a (/src/app.js:99:1)"
	if Fingerprint("javascript", "TypeError", "boom", s1) == Fingerprint("javascript", "TypeError", "boom", s2) {
		t.Fatalf("expected non-hashed frames to keep line/col granularity")
	}
}

func TestFingerprint_PlatformPreventsCollision(t *testing.T) {
	js := Fingerprint("javascript", "ValueError", "No row was found", "")
	py := Fingerprint("python", "ValueError", "No row was found", "")
	if js == py {
		t.Fatal("same-type errors on different platforms must not collide")
	}
}

func TestFingerprint_PythonUsesParsedFrames(t *testing.T) {
	a := Fingerprint("python", "ValueError", "No row was found", pyStandard)
	b := Fingerprint("python", "ValueError", "No row was found", strings.ReplaceAll(pyStandard, "/app/", "/srv/"))
	if a != b {
		t.Fatal("fingerprint not invariant across deployment roots")
	}
}

func TestFingerprint_PythonLibraryOnlyFramesFallBackToRawString(t *testing.T) {
	libOnly := "Traceback (most recent call last):\n" +
		"  File \"/app/venv/lib/python3.12/site-packages/celery/worker.py\", line 10, in run\n" +
		"    task()\n" +
		"  File \"/app/venv/lib/python3.12/site-packages/celery/task.py\", line 20, in task\n" +
		"    raise ValueError()\nValueError: boom"
	if got := pythonFrames(libOnly); len(got) != 0 {
		t.Fatalf("expected no app frames, got %v", got)
	}
	a := Fingerprint("python", "ValueError", "boom", libOnly)
	b := Fingerprint("python", "ValueError", "boom", strings.ReplaceAll(libOnly, "line 10", "line 11"))
	if a == b {
		t.Fatal("library-only tracebacks must fall back to raw-string fingerprinting")
	}
}

func TestFingerprint_PythonMalformedFallsBackToRawString(t *testing.T) {
	a := Fingerprint("python", "ValueError", "x", "Traceback (most recent call last):\ngarbage-A")
	b := Fingerprint("python", "ValueError", "x", "Traceback (most recent call last):\ngarbage-B")
	if a == b {
		t.Fatal("raw-string fallback must distinguish different raw stacks")
	}
}

func TestFingerprint_PythonExceptionGroupFallsBackToRawString(t *testing.T) {
	a := Fingerprint("python", "ExceptionGroup", "many", "  + Exception Group Traceback (most recent call last):\n  | ValueError: A")
	b := Fingerprint("python", "ExceptionGroup", "many", "  + Exception Group Traceback (most recent call last):\n  | ValueError: B")
	if a == b {
		t.Fatal("ExceptionGroup raw-string fallback must distinguish different stacks")
	}
}

func TestFingerprint_EmptyPlatformDefaultsToJavascript(t *testing.T) {
	a := Fingerprint("", "TypeError", "boom", "at fn (/src/app.js:1:1)")
	b := Fingerprint("javascript", "TypeError", "boom", "at fn (/src/app.js:1:1)")
	if a != b {
		t.Fatal("empty platform did not default to javascript")
	}
}
