package handler

import (
	"fmt"
	"math"
	"net/http"
	"sync"
	"sync/atomic"

	"github.com/opslane/opslane/packages/ingestion/notify"
)

// === Atomic counters for Prometheus-compatible metrics ===

var (
	eventsIngestedTotal  atomic.Int64
	jobsEnqueuedTotal    atomic.Int64
	stacklessEventsTotal atomic.Int64
	ingestErrorsTotal    struct {
		mu     sync.Mutex
		byType map[string]*atomic.Int64
	}

	// Histogram for ingest duration (seconds)
	ingestDuration struct {
		mu      sync.Mutex
		buckets []float64 // upper bounds
		counts  []atomic.Int64
		sum     atomic.Int64 // stored as nanoseconds for precision
		count   atomic.Int64
	}
)

func init() {
	ingestErrorsTotal.byType = make(map[string]*atomic.Int64)
	ingestDuration.buckets = []float64{0.01, 0.05, 0.1, 0.25, 0.5, 1.0}
	ingestDuration.counts = make([]atomic.Int64, len(ingestDuration.buckets))
}

// RecordEventIngested increments the events ingested counter.
func RecordEventIngested() {
	eventsIngestedTotal.Add(1)
}

// RecordJobEnqueued increments the jobs enqueued counter.
func RecordJobEnqueued() {
	jobsEnqueuedTotal.Add(1)
}

// RecordStacklessAccepted increments the counter of accepted events that arrived
// with no stack trace (cross-origin "Script error.", non-Error promise rejections).
// Tracks recovery volume after the stack-optional ingest change.
func RecordStacklessAccepted() {
	stacklessEventsTotal.Add(1)
}

// RecordIngestError increments the error counter for the given error type.
func RecordIngestError(errType string) {
	ingestErrorsTotal.mu.Lock()
	counter, ok := ingestErrorsTotal.byType[errType]
	if !ok {
		counter = &atomic.Int64{}
		ingestErrorsTotal.byType[errType] = counter
	}
	ingestErrorsTotal.mu.Unlock()
	counter.Add(1)
}

// RecordIngestDuration records a request duration for the histogram.
// durationSeconds is the elapsed time in seconds.
func RecordIngestDuration(durationSeconds float64) {
	ingestDuration.count.Add(1)
	// Store sum as microseconds (int64) for atomic safety
	microSeconds := int64(durationSeconds * 1e6)
	ingestDuration.sum.Add(microSeconds)

	for i, bound := range ingestDuration.buckets {
		if durationSeconds <= bound {
			ingestDuration.counts[i].Add(1)
			break // only increment the tightest bucket
		}
	}
}

// Metrics serves Prometheus-compatible text metrics at /metrics.
func Metrics(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")

	// opslane_events_ingested_total
	fmt.Fprintf(w, "# HELP opslane_events_ingested_total Total error events ingested\n")
	fmt.Fprintf(w, "# TYPE opslane_events_ingested_total counter\n")
	fmt.Fprintf(w, "opslane_events_ingested_total %d\n\n", eventsIngestedTotal.Load())

	// opslane_jobs_enqueued_total
	fmt.Fprintf(w, "# HELP opslane_jobs_enqueued_total Total jobs enqueued\n")
	fmt.Fprintf(w, "# TYPE opslane_jobs_enqueued_total counter\n")
	fmt.Fprintf(w, "opslane_jobs_enqueued_total %d\n\n", jobsEnqueuedTotal.Load())

	// opslane_stackless_events_total
	fmt.Fprintf(w, "# HELP opslane_stackless_events_total Total accepted events with no stack trace\n")
	fmt.Fprintf(w, "# TYPE opslane_stackless_events_total counter\n")
	fmt.Fprintf(w, "opslane_stackless_events_total %d\n\n", stacklessEventsTotal.Load())

	// opslane_ingest_errors_total
	fmt.Fprintf(w, "# HELP opslane_ingest_errors_total Total ingest errors by type\n")
	fmt.Fprintf(w, "# TYPE opslane_ingest_errors_total counter\n")
	ingestErrorsTotal.mu.Lock()
	for errType, counter := range ingestErrorsTotal.byType {
		fmt.Fprintf(w, "opslane_ingest_errors_total{error_type=%q} %d\n", errType, counter.Load())
	}
	ingestErrorsTotal.mu.Unlock()
	fmt.Fprintln(w)

	// opslane_ingest_duration_seconds histogram
	fmt.Fprintf(w, "# HELP opslane_ingest_duration_seconds Ingest request duration\n")
	fmt.Fprintf(w, "# TYPE opslane_ingest_duration_seconds histogram\n")

	cumulativeCount := int64(0)
	for i, bound := range ingestDuration.buckets {
		cumulativeCount += ingestDuration.counts[i].Load()
		fmt.Fprintf(w, "opslane_ingest_duration_seconds_bucket{le=\"%s\"} %d\n",
			formatFloat(bound), cumulativeCount)
	}
	totalCount := ingestDuration.count.Load()
	fmt.Fprintf(w, "opslane_ingest_duration_seconds_bucket{le=\"+Inf\"} %d\n", totalCount)

	sumMicro := ingestDuration.sum.Load()
	sumSeconds := float64(sumMicro) / 1e6
	fmt.Fprintf(w, "opslane_ingest_duration_seconds_sum %s\n", formatFloat(sumSeconds))
	fmt.Fprintf(w, "opslane_ingest_duration_seconds_count %d\n\n", totalCount)

	// opslane_notification_deliveries_total
	fmt.Fprintln(w, "# HELP opslane_notification_deliveries_total Total notification delivery attempts by destination type and outcome")
	fmt.Fprintln(w, "# TYPE opslane_notification_deliveries_total counter")
	for _, metric := range notify.DeliveryMetricsSnapshot() {
		fmt.Fprintf(w, "opslane_notification_deliveries_total{type=%q,outcome=%q} %d\n",
			metric.DestinationType, metric.Outcome, metric.Count)
	}
}

// formatFloat formats a float without trailing zeros.
func formatFloat(f float64) string {
	if f == math.Trunc(f) {
		return fmt.Sprintf("%.1f", f)
	}
	return fmt.Sprintf("%g", f)
}
