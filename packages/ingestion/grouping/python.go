package grouping

import (
	"regexp"
	"strings"
)

// Python traceback parsing for fingerprinting (opslane-oss#87).
//
// Frame identity deliberately excludes line numbers and deployment roots.
// Both remain available in the stored raw traceback for display and source
// lookup, but including either here would fragment otherwise identical groups.

var (
	rePyFrame        = regexp.MustCompile(`(?m)^\s*File "([^"]+)", line \d+, in (.+)$`)
	// Deployment roots, matched whole in a single pass so nested roots like
	// /usr/src/app/ still reduce to the same relative path as a bare /app/.
	// Stripping iteratively would also eat a real leading package directory,
	// turning /app/app/main.py into main.py.
	rePyDeployPrefix = regexp.MustCompile(`^/?(?:usr/src/|home/[^/]+/)?(?:app|srv|opt)/|^/?home/[^/]+/`)
	rePyLibPath      = regexp.MustCompile(`(?:site-packages|dist-packages)/|/\.?venv/|\.tox/|lib/python\d+(?:\.\d+)?/`)
	// "<string>", "<frozen importlib._bootstrap>", "<stdin>" — never repo files.
	rePyPseudoPath = regexp.MustCompile(`^<.*>$`)
)

// Markers include surrounding newlines so exception messages that merely
// quote the marker text cannot accidentally segment a traceback.
var pyChainMarkers = []string{
	"\nDuring handling of the above exception, another exception occurred:\n",
	"\nThe above exception was the direct cause of the following exception:\n",
}

func isPythonTraceback(stack string) bool {
	return strings.HasPrefix(strings.TrimSpace(stack), "Traceback (most recent call last):")
}

// Python 3.11+ ExceptionGroup output has a distinct, indented shape. Batch 1
// deliberately fingerprints it through the raw-string fallback.
func isExceptionGroupTraceback(stack string) bool {
	return strings.Contains(stack, "Exception Group Traceback (most recent call last):")
}

// collectPythonFrames extracts "path:function" identities from one traceback
// segment, oldest first, skipping library and interpreter pseudo-frames.
func collectPythonFrames(segment string) []string {
	matches := rePyFrame.FindAllStringSubmatch(segment, -1)
	frames := make([]string, 0, len(matches))
	seen := make(map[string]bool, len(matches))
	for _, match := range matches {
		file, function := match[1], match[2]
		if rePyLibPath.MatchString(file) || rePyPseudoPath.MatchString(file) {
			continue
		}

		// Strip the deployment root exactly once. Repeating it would eat a real
		// leading package directory: "/app/app/main.py" must stay "app/main.py".
		relative := file
		if loc := rePyDeployPrefix.FindStringIndex(relative); loc != nil && loc[1] > 0 {
			relative = relative[loc[1]:]
		}

		identity := relative + ":" + strings.TrimSpace(function)
		if seen[identity] {
			continue
		}
		seen[identity] = true
		frames = append(frames, identity)
	}
	return frames
}

// pythonFrames returns at most five unique application frames, newest first.
func pythonFrames(stack string) []string {
	segment := stack
	for _, marker := range pyChainMarkers {
		if i := strings.LastIndex(segment, marker); i >= 0 {
			segment = segment[i+len(marker):]
		}
	}

	frames := collectPythonFrames(segment)
	// An exception message can quote a chain marker verbatim, which would
	// otherwise segment away every real frame. Fall back to the whole stack.
	if len(frames) == 0 && segment != stack {
		frames = collectPythonFrames(stack)
	}

	for i, j := 0, len(frames)-1; i < j; i, j = i+1, j-1 {
		frames[i], frames[j] = frames[j], frames[i]
	}
	if len(frames) > 5 {
		frames = frames[:5]
	}
	return frames
}
