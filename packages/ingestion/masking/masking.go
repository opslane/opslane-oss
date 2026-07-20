package masking

import (
	"encoding/json"
	"regexp"
	"strings"
)

const redacted = "[REDACTED]"

// sensitiveHeaders is the set of HTTP header names whose values must be
// redacted before persistence. Comparison is case-insensitive.
var sensitiveHeaders = map[string]struct{}{
	"authorization":        {},
	"proxy-authorization":  {},
	"authentication":       {},
	"cookie":               {},
	"set-cookie":           {},
	"x-api-key":            {},
	"x-csrf-token":         {},
	"x-auth-token":         {},
	"x-access-token":       {},
	"x-amz-security-token": {},
}

// IsSensitiveHeader reports whether a header name (any case) must never be
// exposed or persisted in cleartext. It is the single source of truth for
// write-side redaction and read-side filtering.
func IsSensitiveHeader(name string) bool {
	_, ok := sensitiveHeaders[strings.ToLower(name)]
	return ok
}

// apiKeyPrefixRe matches well-known API key prefixes followed by
// alphanumeric characters (the key material).
var apiKeyPrefixRe = regexp.MustCompile(`(?i)(sk_live_|sk_test_|AKIA|ghp_|gho_|def_)[A-Za-z0-9]+`)

var urlCredRe = regexp.MustCompile(`(?i)(https?://)[^/@\s:]+(?::[^/@\s]+)?@`)

var urlSecretQueryRe = regexp.MustCompile(
	`(?i)([?&](?:access_token|refresh_token|token|api_key|apikey|key|secret|password|sig|signature)=)[^&\s"']+`)

// jwtRe matches a three-segment base64url JWT (header.payload.signature).
var jwtRe = regexp.MustCompile(`eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`)

// passwordFieldRe matches JSON key-value pairs where the key is a known
// sensitive field name. It captures the key portion so we can preserve it
// and only redact the value.
// Handles keys: password, passwd, secret, token (case-insensitive).
var passwordFieldRe = regexp.MustCompile(
	`(?i)("(?:password|passwd|secret|token)")\s*:\s*"[^"]*"`,
)

// RedactHeaders returns a copy of headers with sensitive header values
// replaced by "[REDACTED]". Keys are compared case-insensitively;
// non-sensitive headers are returned unchanged.
func RedactHeaders(headers map[string]string) map[string]string {
	out := make(map[string]string, len(headers))
	for k, v := range headers {
		if IsSensitiveHeader(k) {
			out[k] = redacted
		} else {
			out[k] = v
		}
	}
	return out
}

// RedactBody scans a string for known sensitive patterns and replaces
// them with "[REDACTED]".
//
// Two categories of patterns are handled:
//  1. API key prefixes (sk_live_, sk_test_, AKIA, ghp_, gho_, def_)
//     followed by alphanumeric characters.
//  2. JSON key-value pairs where the key is password, passwd, secret,
//     or token (case-insensitive) -- the value is redacted.
func RedactBody(body string) string {
	// Redact password-like JSON fields first (so the key is preserved).
	result := passwordFieldRe.ReplaceAllString(body, `$1:"[REDACTED]"`)
	// Then redact API key prefixes.
	result = apiKeyPrefixRe.ReplaceAllString(result, redacted)
	result = jwtRe.ReplaceAllString(result, redacted)
	return result
}

// RedactURL strips embedded basic-auth credentials and sensitive query-string
// values from any URLs found in s. Non-sensitive params are preserved.
func RedactURL(s string) string {
	out := urlCredRe.ReplaceAllString(s, `${1}[REDACTED]@`)
	out = urlSecretQueryRe.ReplaceAllString(out, `${1}[REDACTED]`)
	return out
}

var sensitiveContextKeys = map[string]struct{}{
	"password":      {},
	"passwd":        {},
	"secret":        {},
	"token":         {},
	"access_token":  {},
	"refresh_token": {},
	"api_key":       {},
	"apikey":        {},
}

// RedactContext redacts secrets inside an arbitrary JSON context object.
// Invalid/empty JSON is returned unchanged. Emails and other non-secret values
// are preserved because B2B identity relies on context.user.
func RedactContext(context []byte) []byte {
	if len(context) == 0 {
		return context
	}
	var v interface{}
	if err := json.Unmarshal(context, &v); err != nil {
		return context
	}
	v = redactValue(v)
	out, err := json.Marshal(v)
	if err != nil {
		return context
	}
	return out
}

// RedactRecording redacts secrets in a stored rrweb recording.json (or any JSON
// blob). When the bytes are valid JSON it walks the structure, redacting sensitive
// keys (e.g. nested Authorization / access_token) at any depth and scrubbing every
// string value via RedactBody + RedactURL. Non-JSON input falls back to string-level
// redaction so callers never get back something less redacted than before.
func RedactRecording(raw []byte) []byte {
	if len(raw) == 0 {
		return raw
	}
	if !json.Valid(raw) {
		return []byte(RedactURL(RedactBody(string(raw))))
	}
	return RedactContext(raw)
}

func redactValue(v interface{}) interface{} {
	switch val := v.(type) {
	case map[string]interface{}:
		for k, child := range val {
			lk := strings.ToLower(k)
			if IsSensitiveHeader(lk) {
				val[k] = redacted
				continue
			}
			if _, ok := sensitiveContextKeys[lk]; ok {
				val[k] = redacted
				continue
			}
			val[k] = redactValue(child)
		}
		return val
	case []interface{}:
		for i := range val {
			val[i] = redactValue(val[i])
		}
		return val
	case string:
		return RedactURL(RedactBody(val))
	default:
		return v
	}
}

// RedactBreadcrumbs parses a JSON-encoded breadcrumbs array, recursively
// redacts sensitive keys and string values throughout every breadcrumb, and
// returns the re-serialised JSON.
//
// If the input is nil, empty, or not valid JSON, it is returned as-is.
func RedactBreadcrumbs(breadcrumbs []byte) []byte {
	if len(breadcrumbs) == 0 {
		return breadcrumbs
	}

	var crumbs []interface{}
	if err := json.Unmarshal(breadcrumbs, &crumbs); err != nil {
		// Not valid JSON array -- return unchanged.
		return breadcrumbs
	}

	out, err := json.Marshal(redactValue(crumbs))
	if err != nil {
		return breadcrumbs
	}
	return out
}
