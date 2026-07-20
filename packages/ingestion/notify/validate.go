package notify

import (
	"fmt"
	"net/url"
)

const slackWebhookHost = "hooks.slack.com"

// ValidateSlackWebhookURL enforces the Slack destination allowlist. Extra
// hosts are an exact host[:port] development/test escape hatch.
func ValidateSlackWebhookURL(raw string, extraHosts []string) error {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return fmt.Errorf("invalid URL")
	}
	if u.User != nil {
		return fmt.Errorf("URL must not contain credentials")
	}
	if u.Path == "" || u.Path == "/" {
		return fmt.Errorf("missing webhook path")
	}
	for _, host := range extraHosts {
		if host != "" && u.Host == host && (u.Scheme == "http" || u.Scheme == "https") {
			return nil
		}
	}
	if u.Scheme != "https" {
		return fmt.Errorf("scheme must be https")
	}
	if u.Hostname() != slackWebhookHost {
		return fmt.Errorf("host must be %s", slackWebhookHost)
	}
	if port := u.Port(); port != "" && port != "443" {
		return fmt.Errorf("unexpected port")
	}
	return nil
}

// FingerprintURL returns a non-secret display form for a webhook URL.
func FingerprintURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "invalid"
	}
	tail := raw
	if len(tail) > 4 {
		tail = tail[len(tail)-4:]
	}
	return u.Host + "/…/****" + tail
}
