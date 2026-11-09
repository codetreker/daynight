package httpx

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"
)

func requestMetricsFixture(t *testing.T, handler http.Handler) (*prometheus.Registry, http.Handler) {
	t.Helper()
	registry := prometheus.NewRegistry()
	metrics, err := NewRequestMetrics(registry)
	if err != nil {
		t.Fatal(err)
	}
	return registry, RequestLoggingWithMetrics(quietLogger(), handler, metrics)
}

func metricFamilies(t *testing.T, registry *prometheus.Registry) map[string]*dto.MetricFamily {
	t.Helper()
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	result := make(map[string]*dto.MetricFamily, len(families))
	for _, family := range families {
		result[family.GetName()] = family
	}
	return result
}

func metricLabels(metric *dto.Metric) map[string]string {
	labels := make(map[string]string, len(metric.Label))
	for _, label := range metric.Label {
		labels[label.GetName()] = label.GetValue()
	}
	return labels
}

func findMetric(t *testing.T, family *dto.MetricFamily, labels map[string]string) *dto.Metric {
	t.Helper()
	if family == nil {
		t.Fatalf("missing family for labels %v", labels)
	}
	for _, metric := range family.Metric {
		if reflect.DeepEqual(metricLabels(metric), labels) {
			return metric
		}
	}
	t.Fatalf("missing labels %v in %s: %v", labels, family.GetName(), family.Metric)
	return nil
}

func assertCompleted(t *testing.T, registry *prometheus.Registry, labels map[string]string) {
	t.Helper()
	families := metricFamilies(t, registry)
	counter := families["daynight_http_requests_total"]
	if counter == nil || counter.GetType() != dto.MetricType_COUNTER || len(counter.Metric) != 1 || findMetric(t, counter, labels).GetCounter().GetValue() != 1 {
		t.Fatalf("unexpected counter: %v", counter)
	}
	histogram := families["daynight_http_request_duration_seconds"]
	histLabels := map[string]string{"method": labels["method"], "route": labels["route"], "mode": labels["mode"]}
	if histogram == nil || histogram.GetType() != dto.MetricType_HISTOGRAM || len(histogram.Metric) != 1 {
		t.Fatalf("unexpected histogram: %v", histogram)
	}
	h := findMetric(t, histogram, histLabels).GetHistogram()
	if h.GetSampleCount() != 1 || h.GetSampleSum() < 0 {
		t.Fatalf("unexpected duration: %v", h)
	}
	buckets := make([]float64, 0, len(h.Bucket))
	for _, bucket := range h.Bucket {
		buckets = append(buckets, bucket.GetUpperBound())
	}
	want := []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300}
	if !reflect.DeepEqual(buckets, want) {
		t.Fatalf("buckets %v, want %v", buckets, want)
	}
	gauge := families["daynight_http_requests_in_flight"]
	if gauge == nil || gauge.GetType() != dto.MetricType_GAUGE || len(gauge.Metric) != 1 || len(gauge.Metric[0].Label) != 0 || gauge.Metric[0].GetGauge().GetValue() != 0 {
		t.Fatalf("unexpected in-flight gauge: %v", gauge)
	}
}

type metricFaultWriter struct {
	header    http.Header
	n         int
	err       error
	flushErr  error
	hijackErr error
}

func (w *metricFaultWriter) Header() http.Header         { return w.header }
func (w *metricFaultWriter) WriteHeader(int)             {}
func (w *metricFaultWriter) Write(p []byte) (int, error) { return w.n, w.err }
func (w *metricFaultWriter) FlushError() error           { return w.flushErr }
func (w *metricFaultWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return nil, nil, w.hijackErr
}

func TestRequestMetricsCompletionMatrix(t *testing.T) {
	failure := errors.New("transport error")
	cases := []struct {
		name            string
		cancel          bool
		writer          func() http.ResponseWriter
		handler         func(http.ResponseWriter, *http.Request)
		status, outcome string
		panics          bool
	}{
		{"empty", false, nil, func(http.ResponseWriter, *http.Request) {}, "200", "returned", false},
		{"implicit write", false, nil, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) }, "200", "returned", false},
		{"first final", false, nil, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204); w.WriteHeader(500) }, "204", "returned", false},
		{"informational", false, nil, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(103); w.WriteHeader(201) }, "201", "returned", false},
		{"informational without final", false, nil, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(103) }, "200", "returned", false},
		{"switching protocols", false, nil, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(101); w.WriteHeader(500) }, "101", "returned", false},
		{"canceled before commit", true, nil, func(http.ResponseWriter, *http.Request) {}, "none", "canceled", false},
		{"canceled after commit", true, nil, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(408) }, "408", "canceled", false},
		{"write error before commit", false, func() http.ResponseWriter { return &metricFaultWriter{header: make(http.Header), err: failure} }, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("hello")) }, "none", "write_error", false},
		{"short write", false, func() http.ResponseWriter { return &metricFaultWriter{header: make(http.Header), n: 1} }, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("hello")) }, "200", "write_error", false},
		{"flush error", false, func() http.ResponseWriter { return &metricFaultWriter{header: make(http.Header), flushErr: failure} }, func(w http.ResponseWriter, _ *http.Request) { _ = http.NewResponseController(w).Flush() }, "none", "write_error", false},
		{"hijack error", false, func() http.ResponseWriter { return &metricFaultWriter{header: make(http.Header), hijackErr: failure} }, func(w http.ResponseWriter, _ *http.Request) { _, _, _ = http.NewResponseController(w).Hijack() }, "none", "write_error", false},
		{"write error overrides cancellation", true, func() http.ResponseWriter { return &metricFaultWriter{header: make(http.Header), err: failure} }, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("hello")) }, "none", "write_error", false},
		{"write error after commit", false, func() http.ResponseWriter { return &metricFaultWriter{header: make(http.Header), err: failure} }, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(202); _, _ = w.Write([]byte("hello")) }, "202", "write_error", false},
		{"abort overrides write error", false, func() http.ResponseWriter { return &metricFaultWriter{header: make(http.Header), err: failure} }, func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte("hello"))
			panic(http.ErrAbortHandler)
		}, "none", "aborted", true},
		{"abort", false, nil, func(http.ResponseWriter, *http.Request) { panic(http.ErrAbortHandler) }, "none", "aborted", true},
		{"abort after commit", false, nil, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(413); panic(http.ErrAbortHandler) }, "413", "aborted", true},
		{"panic overrides abort", false, nil, func(http.ResponseWriter, *http.Request) { panic("private panic") }, "none", "panic", true},
		{"panic overrides write error", false, func() http.ResponseWriter { return &metricFaultWriter{header: make(http.Header), err: failure} }, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("hello")); panic("private panic") }, "none", "panic", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			registry, handler := requestMetricsFixture(t, http.HandlerFunc(tc.handler))
			request := httptest.NewRequest(http.MethodGet, "/private?id=secret", nil)
			if tc.cancel {
				ctx, cancel := context.WithCancel(request.Context())
				cancel()
				request = request.WithContext(ctx)
			}
			var writer http.ResponseWriter = httptest.NewRecorder()
			if tc.writer != nil {
				writer = tc.writer()
			}
			func() {
				defer func() {
					value := recover()
					if tc.panics && value != http.ErrAbortHandler {
						t.Errorf("panic = %v, want ErrAbortHandler", value)
					}
					if !tc.panics && value != nil {
						t.Errorf("unexpected panic: %v", value)
					}
				}()
				handler.ServeHTTP(writer, request)
			}()
			assertCompleted(t, registry, map[string]string{"method": "GET", "route": "unrouted", "mode": "http", "status": tc.status, "outcome": tc.outcome})
		})
	}
}

func TestRequestMetricsRouteAndMethodCardinality(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /projects/{projectId}", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	registry, handler := requestMetricsFixture(t, mux)
	for _, target := range []string{"/projects/first?token=one", "/projects/second?token=two"} {
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, target, nil))
	}
	for _, target := range []string{"/unknown/first?token=one", "/unknown/second?token=two"} {
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("CUSTOM", target, nil))
	}
	families := metricFamilies(t, registry)
	counter := families["daynight_http_requests_total"]
	if len(counter.Metric) != 2 {
		t.Fatalf("unexpected cardinality: %v", counter)
	}
	for _, tc := range []struct {
		labels map[string]string
		count  float64
	}{
		{map[string]string{"method": "GET", "route": "/projects/{projectId}", "mode": "http", "status": "204", "outcome": "returned"}, 2},
		{map[string]string{"method": "OTHER", "route": "unrouted", "mode": "http", "status": "404", "outcome": "returned"}, 2},
	} {
		if got := findMetric(t, counter, tc.labels).GetCounter().GetValue(); got != tc.count {
			t.Fatalf("counter for %v = %v, want %v", tc.labels, got, tc.count)
		}
	}
}

func TestRequestMetricsInFlightConcurrentCancellation(t *testing.T) {
	const requests = 4
	entered := make(chan struct{}, requests)
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	registry, handler := requestMetricsFixture(t, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		entered <- struct{}{}
		<-release
		<-r.Context().Done()
	}))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{}, requests)
	for range requests {
		go func() {
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil).WithContext(ctx))
			done <- struct{}{}
		}()
	}
	defer cancel()
	for range requests {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("handler did not enter")
		}
	}
	gauge := metricFamilies(t, registry)["daynight_http_requests_in_flight"]
	if got := gauge.Metric[0].GetGauge().GetValue(); got != requests {
		t.Fatalf("in flight = %v", got)
	}
	cancel()
	releaseOnce.Do(func() { close(release) })
	for range requests {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("handler did not exit")
		}
	}
	families := metricFamilies(t, registry)
	counter := findMetric(t, families["daynight_http_requests_total"], map[string]string{"method": "GET", "route": "unrouted", "mode": "http", "status": "none", "outcome": "canceled"})
	if counter.GetCounter().GetValue() != requests || families["daynight_http_requests_in_flight"].Metric[0].GetGauge().GetValue() != 0 {
		t.Fatalf("completion counter or in-flight gauge incorrect: %v", families)
	}
}

func TestRequestMetricsRealStreamingAndWebSocket(t *testing.T) {
	entered := make(chan string, 2)
	release := make(chan struct{})
	var releaseOnce sync.Once
	completed := make(chan struct{}, 2)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /mcp", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("stream") == "1" {
			w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
			if _, err := w.Write([]byte("data: ready\n\n")); err != nil {
				t.Errorf("SSE write: %v", err)
				return
			}
			if err := http.NewResponseController(w).Flush(); err != nil {
				t.Errorf("SSE flush: %v", err)
				return
			}
			entered <- "sse"
			<-release
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		controller := http.NewResponseController(w)
		if err := controller.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
			t.Errorf("write deadline: %v", err)
			return
		}
		if err := controller.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
			t.Errorf("read deadline: %v", err)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("websocket accept: %v", err)
			return
		}
		defer conn.CloseNow()
		entered <- "websocket"
		<-r.Context().Done()
	})
	registry, wrapped := requestMetricsFixture(t, mux)
	ctx, cancel := context.WithCancel(context.Background())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() { completed <- struct{}{} }()
		wrapped.ServeHTTP(w, r.WithContext(ctx))
	}))
	defer server.Close()
	defer releaseOnce.Do(func() { close(release) })
	defer cancel()
	client := server.Client()
	client.Timeout = 5 * time.Second
	response, err := client.Get(server.URL + "/mcp")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || string(body) != `{"ok":true}` {
		t.Fatalf("JSON response %q: %v", body, err)
	}
	stream, err := client.Get(server.URL + "/mcp?stream=1")
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(stream.Body)
	line, err := reader.ReadString('\n')
	if err != nil || line != "data: ready\n" {
		t.Fatalf("stream was not flushed: %q, %v", line, err)
	}
	ws, _, err := websocket.Dial(ctx, strings.Replace(server.URL, "http://", "ws://", 1)+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	seen := []string{}
	for range 2 {
		select {
		case mode := <-entered:
			seen = append(seen, mode)
		case <-time.After(5 * time.Second):
			t.Fatal("stream handler did not enter")
		}
	}
	sort.Strings(seen)
	if !reflect.DeepEqual(seen, []string{"sse", "websocket"}) {
		t.Fatalf("entered %v", seen)
	}
	gauge := metricFamilies(t, registry)["daynight_http_requests_in_flight"]
	if got := gauge.Metric[0].GetGauge().GetValue(); got != 2 {
		t.Fatalf("in flight = %v", got)
	}
	cancel()
	releaseOnce.Do(func() { close(release) })
	stream.Body.Close()
	for range 3 {
		select {
		case <-completed:
		case <-time.After(5 * time.Second):
			t.Fatal("handler did not complete")
		}
	}
	families := metricFamilies(t, registry)
	counter := families["daynight_http_requests_total"]
	for _, labels := range []map[string]string{
		{"method": "GET", "route": "/mcp", "mode": "http", "status": "200", "outcome": "returned"},
		{"method": "GET", "route": "/mcp", "mode": "sse", "status": "200", "outcome": "canceled"},
		{"method": "GET", "route": "/ws", "mode": "websocket", "status": "101", "outcome": "canceled"},
	} {
		if count := findMetric(t, counter, labels).GetCounter().GetValue(); count != 1 {
			t.Fatalf("%v count = %v", labels, count)
		}
	}
	if got := families["daynight_http_requests_in_flight"].Metric[0].GetGauge().GetValue(); got != 0 {
		t.Fatalf("in flight after completion = %v", got)
	}
}

func TestRequestMetricsRegistrationConflict(t *testing.T) {
	registry := prometheus.NewRegistry()
	if _, err := NewRequestMetrics(registry); err != nil {
		t.Fatal(err)
	}
	if _, err := NewRequestMetrics(registry); err == nil {
		t.Fatal("duplicate metrics registration succeeded")
	}
}

func TestRequestMetricsExpositionParsed(t *testing.T) {
	registry, handler := requestMetricsFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/", nil))
	scrape := httptest.NewRecorder()
	promhttp.HandlerFor(registry, promhttp.HandlerOpts{}).ServeHTTP(scrape, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if scrape.Code != http.StatusOK {
		t.Fatalf("scrape status %d", scrape.Code)
	}
	parser := expfmt.NewTextParser(model.UTF8Validation)
	families, err := parser.TextToMetricFamilies(strings.NewReader(scrape.Body.String()))
	if err != nil {
		t.Fatal(err)
	}
	counter := families["daynight_http_requests_total"]
	labels := map[string]string{"method": "POST", "route": "unrouted", "mode": "http", "status": "202", "outcome": "returned"}
	if counter == nil || counter.GetType() != dto.MetricType_COUNTER || findMetric(t, counter, labels).GetCounter().GetValue() != 1 {
		t.Fatalf("counter: %v", counter)
	}
	histogram := families["daynight_http_request_duration_seconds"]
	if histogram == nil || histogram.GetType() != dto.MetricType_HISTOGRAM || findMetric(t, histogram, map[string]string{"method": "POST", "route": "unrouted", "mode": "http"}).GetHistogram().GetSampleCount() != 1 {
		t.Fatalf("histogram: %v", histogram)
	}
	if !strings.Contains(scrape.Body.String(), `le="+Inf"`) {
		t.Fatalf("missing +Inf bucket: %s", scrape.Body.String())
	}
	gauge := families["daynight_http_requests_in_flight"]
	if gauge == nil || gauge.GetType() != dto.MetricType_GAUGE || len(gauge.Metric) != 1 || len(gauge.Metric[0].Label) != 0 || gauge.Metric[0].GetGauge().GetValue() != 0 {
		t.Fatalf("gauge: %v", gauge)
	}
}

func TestResponseRecorderTransportErrorsPassThrough(t *testing.T) {
	failure := errors.New("underlying transport failure")
	underlying := &metricFaultWriter{header: make(http.Header), n: 1, err: failure, flushErr: failure, hijackErr: failure}
	recorder := &ResponseRecorder{ResponseWriter: underlying}
	if recorder.Unwrap() != underlying {
		t.Fatal("Unwrap did not retain original response writer")
	}
	if n, err := recorder.Write([]byte("data")); n != 1 || err != failure {
		t.Fatalf("Write returned %d, %v", n, err)
	}
	if err := http.NewResponseController(recorder).Flush(); err != failure {
		t.Fatalf("Flush returned %v", err)
	}
	if _, _, err := http.NewResponseController(recorder).Hijack(); err != failure {
		t.Fatalf("Hijack returned %v", err)
	}
}

func TestRequestMetricsStandardFlush(t *testing.T) {
	registry, handler := requestMetricsFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.(http.Flusher).Flush()
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))
	if !response.Flushed || response.Code != http.StatusOK {
		t.Fatalf("standard Flush did not reach underlying writer: %+v", response)
	}
	assertCompleted(t, registry, map[string]string{"method": "GET", "route": "unrouted", "mode": "sse", "status": "200", "outcome": "returned"})
}

func TestRequestMetricsFiniteMethods(t *testing.T) {
	registry, handler := requestMetricsFixture(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	methods := []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT", "TRACE", "CUSTOM", "get"}
	for _, method := range methods {
		handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(method, "/", nil))
	}
	counter := metricFamilies(t, registry)["daynight_http_requests_total"]
	if len(counter.Metric) != 10 {
		t.Fatalf("unexpected method cardinality: %v", counter)
	}
	for _, method := range methods[:9] {
		labels := map[string]string{"method": method, "route": "unrouted", "mode": "http", "status": "200", "outcome": "returned"}
		if count := findMetric(t, counter, labels).GetCounter().GetValue(); count != 1 {
			t.Fatalf("%s count %v", method, count)
		}
	}
	labels := map[string]string{"method": "OTHER", "route": "unrouted", "mode": "http", "status": "200", "outcome": "returned"}
	if count := findMetric(t, counter, labels).GetCounter().GetValue(); count != 2 {
		t.Fatalf("OTHER count %v", count)
	}
}

func TestRequestMetricsSSEUsesCommittedContentType(t *testing.T) {
	for _, tc := range []struct{ committed, after, mode string }{
		{"text/event-stream; charset=utf-8", "application/json", "sse"},
		{"application/json", "text/event-stream", "http"},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			registry, handler := requestMetricsFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", tc.committed)
				w.WriteHeader(http.StatusOK)
				w.Header().Set("Content-Type", tc.after)
			}))
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/", nil))
			assertCompleted(t, registry, map[string]string{"method": "GET", "route": "unrouted", "mode": tc.mode, "status": "200", "outcome": "returned"})
		})
	}
}

type metricBareWriter struct{ target *httptest.ResponseRecorder }

func (w *metricBareWriter) Header() http.Header         { return w.target.Header() }
func (w *metricBareWriter) WriteHeader(status int)      { w.target.WriteHeader(status) }
func (w *metricBareWriter) Write(p []byte) (int, error) { return w.target.Write(p) }

func TestRequestMetricsUnsupportedWebSocketAndFlush(t *testing.T) {
	t.Run("websocket handshake", func(t *testing.T) {
		registry, handler := requestMetricsFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, ok := w.(http.Hijacker); ok {
				t.Error("writer exposed unsupported Hijacker")
			}
			conn, err := websocket.Accept(w, r, nil)
			if err == nil || conn != nil {
				t.Errorf("unsupported handshake returned %v, %v", conn, err)
			}
		}))
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "/ws", nil)
		request.Header.Set("Connection", "Upgrade")
		request.Header.Set("Upgrade", "websocket")
		request.Header.Set("Sec-WebSocket-Version", "13")
		request.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNotImplemented {
			t.Fatalf("unsupported handshake status = %d, want 501", response.Code)
		}
		assertCompleted(t, registry, map[string]string{"method": "GET", "route": "unrouted", "mode": "http", "status": "501", "outcome": "returned"})
	})
	t.Run("flush", func(t *testing.T) {
		registry, handler := requestMetricsFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			if _, ok := w.(http.Flusher); ok {
				t.Error("writer exposed unsupported Flusher")
			}
			if err := http.NewResponseController(w).Flush(); !errors.Is(err, http.ErrNotSupported) {
				t.Errorf("Flush = %v, want ErrNotSupported", err)
			}
		}))
		response := httptest.NewRecorder()
		handler.ServeHTTP(&metricBareWriter{target: response}, httptest.NewRequest(http.MethodGet, "/", nil))
		if response.Flushed {
			t.Fatal("unsupported writer flushed")
		}
		assertCompleted(t, registry, map[string]string{"method": "GET", "route": "unrouted", "mode": "http", "status": "none", "outcome": "write_error"})
	})
}

func TestRequestMetricsExposedTransportErrorReturns(t *testing.T) {
	failure := errors.New("underlying transport failure")
	for _, operation := range []string{"write", "flush", "hijack"} {
		t.Run(operation, func(t *testing.T) {
			registry, handler := requestMetricsFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				switch operation {
				case "write":
					if n, err := w.Write([]byte("data")); n != 0 || err != failure {
						t.Errorf("Write = %d, %v", n, err)
					}
				case "flush":
					if _, ok := w.(http.Flusher); ok {
						t.Error("FlushError-only writer exposed http.Flusher")
					}
					if err := http.NewResponseController(w).Flush(); err != failure {
						t.Errorf("Flush = %v", err)
					}
				case "hijack":
					hijacker, ok := w.(http.Hijacker)
					if !ok {
						t.Error("writer lost Hijacker")
						return
					}
					if _, _, err := hijacker.Hijack(); err != failure {
						t.Errorf("Hijack = %v", err)
					}
				}
			}))
			writer := &metricFaultWriter{header: make(http.Header), err: failure, flushErr: failure, hijackErr: failure}
			handler.ServeHTTP(writer, httptest.NewRequest(http.MethodGet, "/", nil))
			assertCompleted(t, registry, map[string]string{"method": "GET", "route": "unrouted", "mode": "http", "status": "none", "outcome": "write_error"})
		})
	}
}

type metricFlushErrorOnlyWriter struct {
	*metricBareWriter
	flushed bool
}

func (w *metricFlushErrorOnlyWriter) FlushError() error {
	w.flushed = true
	return nil
}

func TestRequestMetricsFlushErrorOnlyCapability(t *testing.T) {
	registry, handler := requestMetricsFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if _, ok := w.(http.Flusher); ok {
			t.Error("FlushError-only writer exposed http.Flusher")
		}
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Errorf("ResponseController.Flush = %v", err)
		}
	}))
	writer := &metricFlushErrorOnlyWriter{metricBareWriter: &metricBareWriter{target: httptest.NewRecorder()}}
	handler.ServeHTTP(writer, httptest.NewRequest(http.MethodGet, "/", nil))
	if !writer.flushed {
		t.Fatal("ResponseController.Flush did not reach underlying FlushError")
	}
	assertCompleted(t, registry, map[string]string{"method": "GET", "route": "unrouted", "mode": "http", "status": "200", "outcome": "returned"})
}

type metricFlusherFaultWriter struct {
	*metricFaultWriter
	flushes int
}

func (w *metricFlusherFaultWriter) Flush()            { w.flushes++ }
func (w *metricFlusherFaultWriter) FlushError() error { w.flushes++; return w.flushErr }

func TestRequestMetricsStandardFlusherError(t *testing.T) {
	failure := errors.New("underlying flush failure")
	for _, viaController := range []bool{false, true} {
		t.Run(fmt.Sprintf("controller=%v", viaController), func(t *testing.T) {
			registry, handler := requestMetricsFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				flusher, ok := w.(http.Flusher)
				if !ok {
					t.Error("writer lost http.Flusher")
					return
				}
				if viaController {
					if err := http.NewResponseController(w).Flush(); err != failure {
						t.Errorf("Flush = %v", err)
					}
				} else {
					flusher.Flush()
				}
			}))
			writer := &metricFlusherFaultWriter{metricFaultWriter: &metricFaultWriter{header: make(http.Header), flushErr: failure}}
			handler.ServeHTTP(writer, httptest.NewRequest(http.MethodGet, "/", nil))
			if writer.flushes != 1 {
				t.Fatalf("underlying flush calls = %d", writer.flushes)
			}
			assertCompleted(t, registry, map[string]string{"method": "GET", "route": "unrouted", "mode": "http", "status": "none", "outcome": "write_error"})
		})
	}
}
