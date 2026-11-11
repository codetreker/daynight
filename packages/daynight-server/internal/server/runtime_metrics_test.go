package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

func TestRuntimeRequestMetricsRegistrationPrecedesListen(t *testing.T) {
	registry := prometheus.NewRegistry()
	_, err := httpx.NewRequestMetrics(registry)
	if err != nil {
		t.Fatal(err)
	}
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	_, err = Start(context.Background(), occupied.Addr().String(), time.Second, time.Second, testLogger(), http.NotFoundHandler(), nil, nil, nil, nil, MetricsEndpoint{Address: "127.0.0.1:0", Registry: registry})
	var failure *httpx.RuntimeError
	if !errors.As(err, &failure) || failure.Component != "metrics" || failure.Phase != "composition" {
		t.Fatalf("registration conflict did not precede binding: %v", err)
	}
}

func TestRuntimeRequestMetricsRoutingAndIsolation(t *testing.T) {
	registry := prometheus.NewRegistry()
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	mux.HandleFunc("GET /items/{id}", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	r := startMetricsRuntime(t, registry, time.Second, mux, nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- r.Run(ctx) }()
	defer func() {
		cancel()
		if err := await(t, done); err != nil {
			t.Error(err)
		}
	}()

	for _, path := range []string{"/healthz", "/items/alpha?token=one", "/items/beta?token=two", "/missing/secret"} {
		res := fetchMetrics(t, "GET", "http://"+r.Address()+path)
		_, err := io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	// Requests rejected before routing still pass through the same instrumentation.
	request := httptest.NewRequest("GET", "/?"+strings.Repeat("q", transport.MaxRawQueryBytes+1), nil)
	response := httptest.NewRecorder()
	r.http.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusRequestURITooLong {
		t.Fatalf("URI rejection status = %d", response.Code)
	}
	r.stopAdmission()
	response = httptest.NewRecorder()
	r.http.Handler.ServeHTTP(response, httptest.NewRequest("GET", "/healthz", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("shutdown rejection status = %d", response.Code)
	}
	// A metrics scrape must not create another business request observation.
	for range 2 {
		res := fetchMetrics(t, "GET", "http://"+r.MetricsAddress()+"/metrics")
		_, err := io.Copy(io.Discard, res.Body)
		_ = res.Body.Close()
		if err != nil || res.StatusCode != http.StatusOK {
			t.Fatalf("scrape status %d: %v", res.StatusCode, err)
		}
	}
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	var requests *dto.MetricFamily
	var inFlight *dto.MetricFamily
	for _, family := range families {
		switch family.GetName() {
		case "daynight_http_requests_total":
			requests = family
		case "daynight_http_requests_in_flight":
			inFlight = family
		}
	}
	if requests == nil || inFlight == nil || inFlight.GetMetric()[0].GetGauge().GetValue() != 0 {
		t.Fatalf("missing requests or nonzero in-flight: %v %v", requests, inFlight)
	}
	observed := map[string]float64{}
	for _, metric := range requests.GetMetric() {
		labels := map[string]string{}
		for _, label := range metric.GetLabel() {
			labels[label.GetName()] = label.GetValue()
		}
		if len(labels) != 5 || labels["method"] != "GET" || labels["mode"] != "http" || labels["outcome"] != "returned" {
			t.Fatalf("unexpected labels: %v", labels)
		}
		observed[labels["route"]+":"+labels["status"]] = metric.GetCounter().GetValue()
	}
	want := map[string]float64{"/healthz:204": 1, "/items/{id}:204": 2, "unrouted:404": 1, "unrouted:414": 1, "unrouted:503": 1}
	if len(observed) != len(want) {
		t.Fatalf("request series = %v, want %v", observed, want)
	}
	for key, value := range want {
		if observed[key] != value {
			t.Fatalf("request series = %v, want %v", observed, want)
		}
	}
}

func TestRuntimeRequestMetricsCancelAndDrain(t *testing.T) {
	registry := prometheus.NewRegistry()
	entered := make(chan struct{})
	canceled := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
	closed := make(chan struct{})
	shutdownEntered := make(chan struct{})
	r := startMetricsRuntime(t, registry, 3*time.Second, http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		close(entered)
		<-request.Context().Done()
		close(canceled)
		<-release
	}), func(context.Context) error { close(closed); return nil })
	r.beginShutdown = func() { close(shutdownEntered) }
	served := make(chan error, 1)
	go func() { served <- r.http.Serve(r.listener) }()
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		_ = r.Close(context.Background())
	})
	requestContext, cancelRequest := context.WithCancel(context.Background())
	defer cancelRequest()
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		request, err := http.NewRequestWithContext(requestContext, "GET", "http://"+r.Address()+"/stream", nil)
		if err != nil {
			return
		}
		response, err := (&http.Client{Timeout: 4 * time.Second}).Do(request)
		if err == nil {
			_ = response.Body.Close()
		}
	}()
	await(t, entered)
	assertRuntimeInFlight(t, registry, 1)
	cancelRequest()
	await(t, canceled)
	// The canceled handler deliberately remains active until released.
	assertRuntimeInFlight(t, registry, 1)
	closing := make(chan error, 1)
	go func() { closing <- r.Close(context.Background()) }()
	await(t, shutdownEntered)
	select {
	case <-closed:
		t.Fatal("application closed before the handler exited")
	default:
	}
	releaseOnce.Do(func() { close(release) })
	if err := await(t, closing); err != nil {
		t.Fatalf("close: %v", err)
	}
	await(t, closed)
	await(t, clientDone)
	if err := await(t, served); !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("serve: %v", err)
	}
	assertRuntimeInFlight(t, registry, 0)
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range families {
		if family.GetName() != "daynight_http_requests_total" {
			continue
		}
		metrics := family.GetMetric()
		if len(metrics) != 1 || metrics[0].GetCounter().GetValue() != 1 {
			t.Fatalf("completion metrics: %v", metrics)
		}
		labels := make(map[string]string)
		for _, label := range metrics[0].GetLabel() {
			labels[label.GetName()] = label.GetValue()
		}
		if labels["outcome"] != "canceled" || labels["status"] != "none" || labels["route"] != "unrouted" {
			t.Fatalf("canceled completion labels: %v", labels)
		}
		return
	}
	t.Fatal("missing request completion")
}

func assertRuntimeInFlight(t *testing.T, registry *prometheus.Registry, want float64) {
	t.Helper()
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range families {
		if family.GetName() == "daynight_http_requests_in_flight" {
			if got := family.GetMetric()[0].GetGauge().GetValue(); got != want {
				t.Fatalf("in-flight = %v, want %v", got, want)
			}
			return
		}
	}
	t.Fatal("missing in-flight gauge")
}

func TestRuntimeRequestMetricsCommittedBeforeSocketWriteFailure(t *testing.T) {
	for _, operation := range []string{"write", "flush"} {
		t.Run(operation, func(t *testing.T) {
			registry := prometheus.NewRegistry()
			operationDone := make(chan error, 1)
			r := startMetricsRuntime(t, registry, time.Second, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
				controller := http.NewResponseController(w)
				if err := controller.SetWriteDeadline(time.Now().Add(-time.Second)); err != nil {
					operationDone <- err
					return
				}
				if operation == "flush" {
					operationDone <- controller.Flush()
				} else {
					_, err := w.Write(make([]byte, 64<<10))
					operationDone <- err
				}
			}), nil)
			served := make(chan error, 1)
			go func() { served <- r.http.Serve(r.listener) }()
			t.Cleanup(func() { _ = r.Close(context.Background()) })
			clientDone := make(chan struct{})
			go func() {
				defer close(clientDone)
				response, err := (&http.Client{Timeout: 4 * time.Second}).Get("http://" + r.Address() + "/stream")
				if err == nil {
					_ = response.Body.Close()
				}
			}()
			var netErr net.Error
			if err := await(t, operationDone); !errors.As(err, &netErr) || !netErr.Timeout() {
				t.Fatalf("expected real socket deadline failure, got %v", err)
			}
			await(t, clientDone)
			if err := r.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
			if err := await(t, served); !errors.Is(err, http.ErrServerClosed) {
				t.Fatalf("serve: %v", err)
			}
			families, err := registry.Gather()
			if err != nil {
				t.Fatal(err)
			}
			for _, family := range families {
				if family.GetName() != "daynight_http_requests_total" {
					continue
				}
				metrics := family.GetMetric()
				if len(metrics) != 1 || metrics[0].GetCounter().GetValue() != 1 {
					t.Fatalf("completion metrics: %v", metrics)
				}
				labels := make(map[string]string)
				for _, label := range metrics[0].GetLabel() {
					labels[label.GetName()] = label.GetValue()
				}
				if labels["status"] != "200" || labels["mode"] != "sse" || labels["outcome"] != "write_error" {
					t.Fatalf("failed response labels: %v", labels)
				}
				return
			}
			t.Fatal("missing request completion")
		})
	}
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
func TestRuntimeMetricsRejectionRetainsLogging(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, time.Second, logger, http.NotFoundHandler(), nil, nil, nil, nil,
		MetricsEndpoint{Address: "127.0.0.1:0", Registry: prometheus.NewRegistry()})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := runtime.Close(context.Background()); err != nil {
			t.Error(err)
		}
	}()
	runtime.metrics.stopAdmission()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	request.Header.Set("X-Request-ID", "metrics-rejection")
	runtime.metrics.http.Handler.ServeHTTP(response, request)
	var event struct {
		Component string `json:"component"`
		Phase     string `json:"phase"`
		RequestID string `json:"request_id"`
	}
	if response.Code != http.StatusServiceUnavailable || json.Unmarshal(output.Bytes(), &event) != nil || event.Component != "metrics" || event.Phase != "scrape" || event.RequestID != "metrics-rejection" {
		t.Fatalf("metrics rejection lost diagnostic: status=%d log=%s", response.Code, output.String())
	}
}
