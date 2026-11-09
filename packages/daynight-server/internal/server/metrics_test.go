package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
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

func startMetricsRuntime(t *testing.T, registry *prometheus.Registry, shutdown time.Duration, handler http.Handler, closeApp func(context.Context) error) *Runtime {
	t.Helper()
	r, err := Start(context.Background(), "127.0.0.1:0", time.Second, shutdown, testLogger(), handler, nil, nil, nil, closeApp, MetricsEndpoint{Address: "127.0.0.1:0", Registry: registry})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func fetchMetrics(t *testing.T, method, url string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := (&http.Client{Timeout: 4 * time.Second}).Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestMetricsEndpointSocketContract(t *testing.T) {
	registry := prometheus.NewRegistry()
	registry.MustRegister(&testMetricsCollector{desc: prometheus.NewDesc("test_runtime_metric", "test", nil, nil)})
	r := startMetricsRuntime(t, registry, time.Second, http.NotFoundHandler(), nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- r.Run(ctx) }()
	defer func() {
		cancel()
		if err := await(t, done); err != nil {
			t.Error(err)
		}
	}()
	for _, tc := range []struct {
		method, address, path string
		status                int
		body                  bool
	}{
		{"GET", r.MetricsAddress(), "/metrics", 200, true},
		{"HEAD", r.MetricsAddress(), "/metrics", 200, false},
		{"POST", r.MetricsAddress(), "/metrics", 405, false},
		{"GET", r.MetricsAddress(), "/metrics/", 404, false},
		{"GET", r.Address(), "/metrics", 404, false},
	} {
		res := fetchMetrics(t, tc.method, "http://"+tc.address+tc.path)
		body, err := io.ReadAll(res.Body)
		_ = res.Body.Close()
		if err != nil || res.StatusCode != tc.status {
			t.Fatalf("%s %s: %d %v", tc.method, tc.path, res.StatusCode, err)
		}
		if tc.method == "HEAD" && len(body) != 0 {
			t.Fatalf("HEAD returned body %q", body)
		}
		if tc.body && !strings.Contains(string(body), "test_runtime_metric 42") {
			t.Fatalf("missing metric: %s", body)
		}
		if tc.status == 405 && res.Header.Get("Allow") != "GET, HEAD" {
			t.Fatalf("Allow: %q", res.Header.Get("Allow"))
		}
	}
	req, _ := http.NewRequest("GET", "http://"+r.MetricsAddress()+"/metrics", nil)
	req.Header.Set("Accept", "application/openmetrics-text; version=1.0.0")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if !strings.HasPrefix(res.Header.Get("Content-Type"), "application/openmetrics-text") || !strings.Contains(string(body), "# EOF") {
		t.Fatalf("openmetrics negotiation: %s %s", res.Header.Get("Content-Type"), body)
	}
}

func TestMetricsRegistrationAndGatherFailures(t *testing.T) {
	_, err := Start(context.Background(), "127.0.0.1:0", time.Second, time.Second, testLogger(), http.NotFoundHandler(), nil, nil, nil, nil, MetricsEndpoint{Address: "127.0.0.1:0"})
	var failure *httpx.RuntimeError
	if !errors.As(err, &failure) || failure.Component != "metrics" || failure.Phase != "composition" {
		t.Fatalf("missing registry: %v", err)
	}
	registry := prometheus.NewRegistry()
	if _, err := newMetricsHandler(registry, testLogger()); err != nil {
		t.Fatal(err)
	}
	_, err = Start(context.Background(), "127.0.0.1:0", time.Second, time.Second, testLogger(), http.NotFoundHandler(), nil, nil, nil, nil, MetricsEndpoint{Address: "127.0.0.1:0", Registry: registry})
	if !errors.As(err, &failure) || failure.Component != "metrics" || failure.Phase != "composition" {
		t.Fatalf("duplicate registration was accepted: %v", err)
	}
	registry = prometheus.NewRegistry()
	registry.MustRegister(&testMetricsCollector{desc: prometheus.NewDesc("broken", "test", nil, nil), failure: errors.New("test gather failed")})
	r := startMetricsRuntime(t, registry, time.Second, http.NotFoundHandler(), nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- r.Run(ctx) }()
	res := fetchMetrics(t, "GET", "http://"+r.MetricsAddress()+"/metrics")
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if res.StatusCode != 500 || !strings.Contains(string(body), "test gather failed") {
		t.Fatalf("gather did not fail: %d %s", res.StatusCode, body)
	}
	cancel()
	if err := await(t, done); err != nil {
		t.Fatal(err)
	}
}

func TestMetricsSecondBindRollback(t *testing.T) {
	metrics, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer metrics.Close()
	// Use a known free address to verify rollback of the first bind.
	business, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := business.Addr().String()
	_ = business.Close()
	_, err = Start(context.Background(), address, time.Second, time.Second, testLogger(), http.NotFoundHandler(), nil, nil, nil, nil, MetricsEndpoint{Address: metrics.Addr().String(), Registry: prometheus.NewRegistry()})
	var failure *httpx.RuntimeError
	if !errors.As(err, &failure) || failure.Component != "metrics" || failure.Phase != "listen" {
		t.Fatalf("bind failure lost attribution: %v", err)
	}
	listener, err := net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("business listener retained: %v", err)
	}
	_ = listener.Close()
}

func TestMetricsServeFailuresStopBothListeners(t *testing.T) {
	for _, target := range []string{"server", "metrics"} {
		t.Run(target, func(t *testing.T) {
			r := startMetricsRuntime(t, prometheus.NewRegistry(), time.Second, http.NotFoundHandler(), nil)
			if target == "server" {
				_ = r.listener.Close()
			} else {
				_ = r.metrics.listener.Close()
			}
			err := r.Run(context.Background())
			var failure *httpx.RuntimeError
			if !errors.Is(err, net.ErrClosed) || !errors.As(err, &failure) || failure.Component != target || failure.Phase != "serve" {
				t.Fatalf("serve failure: %v", err)
			}
			for _, addr := range []string{r.Address(), r.MetricsAddress()} {
				ln, err := net.Listen("tcp", addr)
				if err != nil {
					t.Fatalf("listener %s retained: %v", addr, err)
				}
				_ = ln.Close()
			}
		})
	}
}

func TestMetricsConcurrencyAndDrainRetry(t *testing.T) {
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	registry := prometheus.NewRegistry()
	registry.MustRegister(&testMetricsCollector{desc: prometheus.NewDesc("blocking", "test", nil, nil), entered: entered, release: release})
	var closes atomic.Int32
	r := startMetricsRuntime(t, registry, 40*time.Millisecond, http.NotFoundHandler(), func(context.Context) error { closes.Add(1); return nil })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- r.Run(ctx) }()
	clients := make(chan struct{}, 2)
	for range 2 {
		go func() {
			defer func() { clients <- struct{}{} }()
			res, err := (&http.Client{Timeout: 4 * time.Second}).Get("http://" + r.MetricsAddress() + "/metrics")
			if err == nil {
				_ = res.Body.Close()
			}
		}()
	}
	await(t, entered)
	await(t, entered)
	res := fetchMetrics(t, "GET", "http://"+r.MetricsAddress()+"/metrics")
	_ = res.Body.Close()
	if res.StatusCode != 503 {
		t.Fatalf("concurrency limit: %d", res.StatusCode)
	}
	cancel()
	if err := await(t, done); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected timeout: %v", err)
	}
	if closes.Load() != 0 {
		t.Fatal("application closed with active collectors")
	}
	retry, stop := context.WithTimeout(context.Background(), 20*time.Millisecond)
	err := r.Close(retry)
	stop()
	if !errors.Is(err, context.DeadlineExceeded) || closes.Load() != 0 {
		t.Fatalf("retry did not retain active collector: %v", err)
	}
	close(release)
	if err := r.Close(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lost original timeout: %v", err)
	}
	if closes.Load() != 1 {
		t.Fatalf("application close count %d", closes.Load())
	}
	await(t, clients)
	await(t, clients)
	for _, address := range []string{r.Address(), r.MetricsAddress()} {
		ln, err := net.Listen("tcp", address)
		if err != nil {
			t.Fatal(fmt.Errorf("listener retained: %w", err))
		}
		_ = ln.Close()
	}
}

func TestEarlyServerCloseRemainsFailureDuringConcurrentShutdown(t *testing.T) {
	for _, target := range []string{"server", "metrics"} {
		t.Run(target, func(t *testing.T) {
			r := startMetricsRuntime(t, prometheus.NewRegistry(), time.Second, http.NotFoundHandler(), nil)
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() { done <- r.Run(ctx) }()
			address, server := r.Address(), r.http
			if target == "metrics" {
				address, server = r.MetricsAddress(), r.metrics.http
			}
			res := fetchMetrics(t, "GET", "http://"+address+"/metrics")
			_ = res.Body.Close()
			if err := server.Close(); err != nil {
				t.Fatal(err)
			}
			cancel()
			err := await(t, done)
			var failure *httpx.RuntimeError
			if !errors.Is(err, http.ErrServerClosed) || !errors.As(err, &failure) || failure.Component != target || failure.Phase != "serve" {
				t.Fatalf("early close was treated as coordinated shutdown: %v", err)
			}
		})
	}
}

func TestBothListenersStopWhileHandlersDrain(t *testing.T) {
	businessEntered, businessRelease := make(chan struct{}), make(chan struct{})
	metricsEntered, metricsRelease := make(chan struct{}, 1), make(chan struct{})
	registry := prometheus.NewRegistry()
	registry.MustRegister(&testMetricsCollector{desc: prometheus.NewDesc("parallel_drain", "test", nil, nil), entered: metricsEntered, release: metricsRelease})
	var closes atomic.Int32
	r := startMetricsRuntime(t, registry, 3*time.Second, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		close(businessEntered)
		<-businessRelease
	}), func(context.Context) error { closes.Add(1); return nil })
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- r.Run(ctx) }()
	clients := make(chan struct{}, 2)
	for _, addr := range []string{r.Address(), r.MetricsAddress()} {
		go func(addr string) {
			defer func() { clients <- struct{}{} }()
			res, err := (&http.Client{Timeout: 4 * time.Second}).Get("http://" + addr + "/metrics")
			if err == nil {
				_ = res.Body.Close()
			}
		}(addr)
	}
	await(t, businessEntered)
	await(t, metricsEntered)
	cancel()
	deadline := time.Now().Add(time.Second)
	for _, address := range []string{r.Address(), r.MetricsAddress()} {
		for {
			conn, err := net.DialTimeout("tcp", address, 50*time.Millisecond)
			if err != nil {
				break
			}
			_ = conn.Close()
			if time.Now().After(deadline) {
				t.Fatalf("listener %s remained open while both handlers drained", address)
			}
			time.Sleep(time.Millisecond)
		}
	}
	if closes.Load() != 0 {
		t.Fatal("application closed before handlers finished")
	}
	close(businessRelease)
	close(metricsRelease)
	await(t, clients)
	await(t, clients)
	if err := await(t, done); err != nil {
		t.Fatalf("graceful shutdown: %v", err)
	}
	if closes.Load() != 1 {
		t.Fatalf("application close count: %d", closes.Load())
	}
}
