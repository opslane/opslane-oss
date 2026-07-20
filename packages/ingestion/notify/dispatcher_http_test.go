package notify

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (f roundTripperFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func serverHost(server *httptest.Server) string {
	return strings.TrimPrefix(server.URL, "http://")
}

func TestNewDispatcherDefaults(t *testing.T) {
	d := New(nil, nil, Options{ExtraHosts: []string{"sink.test:9999"}})
	if d.opts.PollInterval != 5*time.Second || d.opts.BatchSize != 10 ||
		d.opts.HTTPTimeout != 10*time.Second || d.opts.LeaseDuration != 90*time.Second {
		t.Fatalf("unexpected defaults: %+v", d.opts)
	}
	if d.sender.Client.Timeout != 10*time.Second || len(d.sender.ExtraHosts) != 1 {
		t.Fatalf("unexpected sender defaults: %+v", d.sender)
	}
}

func TestSenderClassifiesHTTPResponses(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		retryAfter string
		wantClass  string
		wantRetry  bool
	}{
		{"success", 200, "", "delivered", false},
		{"bad request", 400, "", "permanent", false},
		{"not found", 404, "", "permanent", false},
		{"request timeout", 408, "", "retry", false},
		{"rate limited seconds", 429, "2", "retry", true},
		{"server error", 503, "", "retry", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if tc.retryAfter != "" {
					w.Header().Set("Retry-After", tc.retryAfter)
				}
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte("scripted response"))
			}))
			defer server.Close()
			sender := NewSender(time.Second, []string{serverHost(server)})
			outcome := sender.Send(context.Background(), "slack", server.URL+"/hook", samplePayload("boom", ""))
			if outcome.Class != tc.wantClass || outcome.StatusCode != tc.status {
				t.Fatalf("outcome = %+v", outcome)
			}
			if tc.wantRetry && outcome.RetryAfter != 2*time.Second {
				t.Fatalf("retry-after = %s, want 2s", outcome.RetryAfter)
			}
		})
	}
}

func TestSenderHonorsHTTPDateRetryAfterAndCapsAtOneHour(t *testing.T) {
	now := time.Now()
	dateServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", now.Add(3*time.Second).UTC().Format(http.TimeFormat))
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer dateServer.Close()
	outcome := NewSender(time.Second, []string{serverHost(dateServer)}).Send(
		context.Background(), "slack", dateServer.URL+"/hook", samplePayload("boom", ""))
	if outcome.RetryAfter < time.Second || outcome.RetryAfter > 3*time.Second {
		t.Fatalf("HTTP-date retry-after = %s", outcome.RetryAfter)
	}

	capServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Retry-After", "99999")
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer capServer.Close()
	outcome = NewSender(time.Second, []string{serverHost(capServer)}).Send(
		context.Background(), "slack", capServer.URL+"/hook", samplePayload("boom", ""))
	if outcome.RetryAfter != time.Hour {
		t.Fatalf("capped retry-after = %s", outcome.RetryAfter)
	}
}

func TestSenderRefusesRedirects(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/hook" {
			http.Redirect(w, r, "/target", http.StatusFound)
			return
		}
		t.Fatal("sender followed redirect")
	}))
	defer server.Close()
	outcome := NewSender(time.Second, []string{serverHost(server)}).Send(
		context.Background(), "slack", server.URL+"/hook", samplePayload("boom", ""))
	if outcome.Class != "permanent" || outcome.StatusCode != http.StatusFound {
		t.Fatalf("outcome = %+v", outcome)
	}
}

func TestSenderTimeoutAndNetworkErrorsNeverExposeWebhook(t *testing.T) {
	secretPath := "/services/T/B/super-secret-token"
	sender := &Sender{
		ExtraHosts: []string{"sink.test:9999"},
		Client: &http.Client{Transport: roundTripperFunc(func(request *http.Request) (*http.Response, error) {
			return nil, &url.Error{Op: "Post", URL: request.URL.String(), Err: errors.New("dial " + request.URL.String())}
		})},
	}
	outcome := sender.Send(context.Background(), "slack", "http://sink.test:9999"+secretPath, samplePayload("boom", ""))
	if outcome.Class != "retry" || strings.Contains(outcome.Reason, secretPath) || strings.Contains(outcome.Reason, "super-secret-token") {
		t.Fatalf("unsafe outcome = %+v", outcome)
	}

	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		time.Sleep(100 * time.Millisecond)
	}))
	defer server.Close()
	outcome = NewSender(20*time.Millisecond, []string{serverHost(server)}).Send(
		context.Background(), "slack", server.URL+"/timeout-secret", samplePayload("boom", ""))
	if outcome.Class != "retry" || outcome.Reason != "request_timeout" || strings.Contains(outcome.Reason, "timeout-secret") {
		t.Fatalf("timeout outcome = %+v", outcome)
	}
}

func TestSenderSanitizesAndCapsResponseReason(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = fmt.Fprintf(w, "%s %s", "http://"+r.Host+r.RequestURI, strings.Repeat("x", 1000))
	}))
	defer server.Close()
	outcome := NewSender(time.Second, []string{serverHost(server)}).Send(
		context.Background(), "slack", server.URL+"/secret-path", samplePayload("boom", ""))
	if len([]rune(outcome.Reason)) > maxReasonLength || strings.Contains(outcome.Reason, "secret-path") {
		t.Fatalf("unsafe reason (%d): %s", len([]rune(outcome.Reason)), outcome.Reason)
	}
}
