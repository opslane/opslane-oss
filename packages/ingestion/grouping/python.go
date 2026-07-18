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
	rePyDeployPrefix = regexp.MustCompile(`^/?(?:app|srv|opt|usr/src)/|^/?home/[^/]+/`)
	rePyLibPath      = regexp.MustCompile(`(?:site-packages|dist-packages)/|/venv/|\.tox/|lib/python\d+(?:\.\d+)?/`)
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

// pythonFrames returns at most five unique application frames, newest first.
func pythonFrames(stack string) []string {
	segment := stack
	for _, marker := range pyChainMarkers {
		if i := strings.LastIndex(segment, marker); i >= 0 {
			segment = segment[i+len(marker):]
		}
	}

	matches := rePyFrame.FindAllStringSubmatch(segment, -1)
	frames := make([]string, 0, len(matches))
	seen := make(map[string]bool, len(matches))
	for _, match := range matches {
		file, function := match[1], match[2]
		if rePyLibPath.MatchString(file) {
			continue
		}

		// Advance an index past each anchored match instead of rebuilding the
		// string: paths are attacker-sized (bounded only by the request-body
		// cap), and per-iteration copies would make this quadratic.
		relative := file
		for {
			loc := rePyDeployPrefix.FindStringIndex(relative)
			if loc == nil || loc[1] == 0 {
				break
			}
			relative = relative[loc[1]:]
		}

		identity := relative + ":" + strings.TrimSpace(function)
		if seen[identity] {
			continue
		}
		seen[identity] = true
		frames = append(frames, identity)
	}

	for i, j := 0, len(frames)-1; i < j; i, j = i+1, j-1 {
		frames[i], frames[j] = frames[j], frames[i]
	}
	if len(frames) > 5 {
		frames = frames[:5]
	}
	return frames
}
