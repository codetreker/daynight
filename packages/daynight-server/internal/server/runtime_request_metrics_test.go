package server

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
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
