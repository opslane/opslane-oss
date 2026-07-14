package grouping

import (
	"crypto/sha256"
	"fmt"
	"regexp"
	"strings"
)

// Pre-compiled regexps for message normalization.
var (
	reHex     = regexp.MustCompile(`0x[0-9a-fA-F]+`)
	reUUID    = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	rePathNum = regexp.MustCompile(`/\d+`)
	reNum     = regexp.MustCompile(`\b\d+\b`)
	reQuoted  = regexp.MustCompile(`"[^"]*"`)
	reSpaces  = regexp.MustCompile(`\s+`)
)

// Fingerprint generates a stable fingerprint for error grouping.
// Algorithm: hash(error_type + normalized_top_5_frames + error_message_template)
func Fingerprint(errorType, errorMessage, stackTrace string) string {
	template := normalizeMessage(errorMessage)
	frames := topFrames(stackTrace, 5)
	input := fmt.Sprintf("%s|%s|%s", errorType, template, strings.Join(frames, "|"))
	hash := sha256.Sum256([]byte(input))
	return fmt.Sprintf("%x", hash[:16])
}

// normalizeMessage strips variable content (hex addresses, UUIDs, path numbers,
// quoted strings) from error messages to produce stable grouping templates.
func normalizeMessage(msg string) string {
	result := reHex.ReplaceAllString(msg, "0xN")
	result = reUUID.ReplaceAllString(result, "<UUID>")
	result = rePathNum.ReplaceAllString(result, "/N")
	result = reNum.ReplaceAllString(result, "N")
	result = reQuoted.ReplaceAllString(result, `"..."`)
	result = reSpaces.ReplaceAllString(result, " ")
	return strings.ToLower(strings.TrimSpace(result))
}

func topFrames(stack string, n int) []string {
	lines := strings.Split(stack, "\n")
	if len(lines) > n {
		lines = lines[:n]
	}
	return lines
}
