package grouping

import (
	"crypto/sha256"
	"fmt"
	"regexp"
	"strings"
)

// Pre-compiled regexps for message normalization.
var (
	reHex        = regexp.MustCompile(`0x[0-9a-fA-F]+`)
	reUUID       = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	rePathNum    = regexp.MustCompile(`/\d+`)
	reNum        = regexp.MustCompile(`\b\d+\b`)
	reQuoted     = regexp.MustCompile(`"[^"]*"`)
	reSpaces     = regexp.MustCompile(`\s+`)
	reURL        = regexp.MustCompile(`https?://[^/\s]+`)
	reAssetToken = regexp.MustCompile(`([A-Za-z0-9_.]+)-([A-Za-z0-9_]+)\.(js|mjs|cjs|css|map)(\?[^\s:'")]*)?(:\d+:\d+)?`)
)

// Fingerprint generates a stable fingerprint for error grouping.
// Algorithm: first 128 bits of
// SHA256(platform | error_type | normalized_message | frames).
// Python tracebacks use stable, prefix-stripped file:function identities;
// malformed and ExceptionGroup tracebacks fall back to the raw stack string.
func Fingerprint(platform, errorType, errorMessage, stackTrace string) string {
	if platform == "" {
		platform = "javascript"
	}
	template := normalizeMessage(errorMessage)

	var frames []string
	if platform == "python" {
		if isPythonTraceback(stackTrace) && !isExceptionGroupTraceback(stackTrace) {
			frames = pythonFrames(stackTrace)
		}
		if len(frames) == 0 && stackTrace != "" {
			frames = []string{stackTrace}
		}
	} else {
		frames = topFrames(stackTrace, 5)
	}

	input := fmt.Sprintf("%s|%s|%s|%s", platform, errorType, template, strings.Join(frames, "|"))
	hash := sha256.Sum256([]byte(input))
	return fmt.Sprintf("%x", hash[:16])
}

// normalizeMessage strips deploy-varying URLs and asset hashes along with the
// existing variable values to produce stable grouping templates.
func normalizeMessage(msg string) string {
	result := normalizeVolatile(msg)
	result = reHex.ReplaceAllString(result, "0xN")
	result = reUUID.ReplaceAllString(result, "<UUID>")
	result = rePathNum.ReplaceAllString(result, "/N")
	result = reNum.ReplaceAllString(result, "N")
	result = reQuoted.ReplaceAllString(result, `"..."`)
	result = reSpaces.ReplaceAllString(result, " ")
	return strings.ToLower(strings.TrimSpace(result))
}

// normalizeVolatile removes deploy-varying URL and hashed-asset content while
// leaving ordinary filenames and prose untouched.
func normalizeVolatile(s string) string {
	s = reURL.ReplaceAllString(s, "")
	return reAssetToken.ReplaceAllStringFunc(s, func(match string) string {
		parts := reAssetToken.FindStringSubmatch(match)
		if !looksLikeHash(parts[2]) {
			return match
		}
		return parts[1] + "-<HASH>." + parts[3]
	})
}

// looksLikeHash rejects short or letter-only suffixes used in ordinary names.
func looksLikeHash(s string) bool {
	if len(s) < 8 {
		return false
	}
	for _, r := range s {
		if r >= '0' && r <= '9' {
			return true
		}
	}
	return false
}

func topFrames(stack string, n int) []string {
	lines := strings.Split(stack, "\n")
	if len(lines) > n {
		lines = lines[:n]
	}
	for i, line := range lines {
		lines[i] = normalizeVolatile(line)
	}
	return lines
}
