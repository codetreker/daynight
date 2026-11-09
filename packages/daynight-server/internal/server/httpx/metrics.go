package httpx

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// RequestMetrics owns the business HTTP collectors for one registry.
type RequestMetrics struct {
	requests *prometheus.CounterVec
	duration *prometheus.HistogramVec
	inFlight prometheus.Gauge
}

// NewRequestMetrics registers the collectors before the runtime binds listeners.
func NewRequestMetrics(registry prometheus.Registerer) (*RequestMetrics, error) {
	m := &RequestMetrics{
		requests: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "daynight_http_requests_total", Help: "Completed business HTTP handlers."}, []string{"method", "route", "mode", "status", "outcome"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "daynight_http_request_duration_seconds", Help: "Business HTTP handler lifetime in seconds.", Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300}}, []string{"method", "route", "mode"}),
		inFlight: prometheus.NewGauge(prometheus.GaugeOpts{Name: "daynight_http_requests_in_flight", Help: "Business HTTP handlers currently executing."}),
	}
	collectors := []prometheus.Collector{m.requests, m.duration, m.inFlight}
	for i, collector := range collectors {
		if err := registry.Register(collector); err != nil {
			for _, registered := range collectors[:i] {
				registry.Unregister(registered)
			}
			return nil, err
		}
	}
	return m, nil
}

func metricMethod(method string) string {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions, http.MethodConnect, http.MethodTrace:
		return method
	default:
		return "OTHER"
	}
}

func metricRoute(pattern string) string {
	if _, route, ok := strings.Cut(pattern, " "); ok {
		pattern = route
	}
	if pattern == "" {
		return "unrouted"
	}
	return pattern
}

func (m *RequestMetrics) observe(r *http.Request, w *ResponseRecorder, start time.Time, outcome string) {
	method, route, mode := metricMethod(r.Method), metricRoute(r.Pattern), w.mode()
	status := "none"
	if w.Status != 0 {
		status = strconv.Itoa(w.Status)
	} else if outcome == "returned" {
		status = "200"
	}
	m.requests.WithLabelValues(method, route, mode, status, outcome).Inc()
	m.duration.WithLabelValues(method, route, mode).Observe(time.Since(start).Seconds())
	m.inFlight.Dec()
}
