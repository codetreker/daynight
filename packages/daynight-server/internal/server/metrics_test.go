package server

import (
	"bytes"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
)

type testMetricsCollector struct {
	desc    *prometheus.Desc
	entered chan struct{}
	release <-chan struct{}
	failure error
}

type failedMetricsWrite struct {
	header http.Header
	status int
	short  bool
}

func (w *failedMetricsWrite) Header() http.Header    { return w.header }
func (w *failedMetricsWrite) WriteHeader(status int) { w.status = status }
func (w *failedMetricsWrite) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	if w.short {
		return 0, nil
	}
	return 0, errors.New("sensitive transport failure")
}

func TestMetricsWriteFailureLogsRequestID(t *testing.T) {
	for _, short := range []bool{false, true} {
		var logs bytes.Buffer
		logger := slog.New(slog.NewJSONHandler(&logs, nil))
		registry := prometheus.NewRegistry()
		registry.MustRegister(&testMetricsCollector{desc: prometheus.NewDesc("test_write", "test", nil, nil)})
		handler, err := newMetricsHandler(registry, logger)
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest("GET", "/metrics", nil)
		request.Header.Set("X-Request-ID", "scrape-123")
		writer := &failedMetricsWrite{header: make(http.Header), short: short}
		metricsRequestLogging(logger, handler).ServeHTTP(writer, request)
		if writer.status != http.StatusOK || !strings.Contains(logs.String(), `"phase":"write"`) || !strings.Contains(logs.String(), `"request_id":"scrape-123"`) || strings.Contains(logs.String(), "sensitive transport failure") {
			t.Fatalf("failed write not safely associated with request: status=%d log=%s", writer.status, logs.String())
		}
	}
}

func (c *testMetricsCollector) Describe(ch chan<- *prometheus.Desc) { ch <- c.desc }
func (c *testMetricsCollector) Collect(ch chan<- prometheus.Metric) {
	if c.entered != nil {
		c.entered <- struct{}{}
	}
	if c.release != nil {
		<-c.release
	}
	if c.failure != nil {
		ch <- prometheus.NewInvalidMetric(c.desc, c.failure)
		return
	}
	ch <- prometheus.MustNewConstMetric(c.desc, prometheus.GaugeValue, 42)
}
