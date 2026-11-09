package server

import (
	"context"
	"crypto/rand"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// promhttp's Registry option otherwise panics or reuses an existing counter on
// registration failure. Capture the error so composition fails explicitly.
type metricsRegisterer struct {
	registry *prometheus.Registry
	err      error
}

func (r *metricsRegisterer) Register(c prometheus.Collector) error {
	r.err = errors.Join(r.err, r.registry.Register(c))
	return nil
}
func (r *metricsRegisterer) MustRegister(cs ...prometheus.Collector) {
	for _, c := range cs {
		_ = r.Register(c)
	}
}
func (r *metricsRegisterer) Unregister(c prometheus.Collector) bool { return r.registry.Unregister(c) }

type metricsErrorLog struct{ logger *slog.Logger }

type metricsResponse struct {
	*httpx.ResponseRecorder
	writeErr error
}

func (w *metricsResponse) Write(data []byte) (int, error) {
	n, err := w.ResponseRecorder.Write(data)
	if err == nil && n < len(data) {
		w.writeErr = errors.Join(w.writeErr, io.ErrShortWrite)
	} else {
		w.writeErr = errors.Join(w.writeErr, err)
	}
	return n, err
}

func (l metricsErrorLog) Println(values ...any) {
	phase := "encode"
	if len(values) > 0 && values[0] == "error gathering metrics:" {
		phase = "gather"
	}
	var cause error
	for _, value := range values {
		if err, ok := value.(error); ok {
			cause = errors.Join(cause, err)
		}
	}
	if cause == nil {
		cause = errors.New("metrics handler failed")
	}
	httpx.LogFailure(l.logger, context.Background(), "metrics", phase, cause)
}

func newMetricsHandler(registry *prometheus.Registry, logger *slog.Logger) (http.Handler, error) {
	registerer := &metricsRegisterer{registry: registry}
	gather := promhttp.HandlerFor(registry, promhttp.HandlerOpts{
		ErrorLog: metricsErrorLog{logger}, ErrorHandling: promhttp.HTTPErrorOnError,
		Registry: registerer, EnableOpenMetrics: true, MaxRequestsInFlight: 2,
	})
	if registerer.err != nil {
		return nil, registerer.err
	}
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/metrics" {
			http.NotFound(w, request)
			return
		}
		if request.Method != http.MethodGet && request.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		gather.ServeHTTP(w, request)
	}), nil
}

func metricsRequestLogging(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		id := request.Header.Get("X-Request-ID")
		if !httpx.ValidRequestID(id) {
			id = rand.Text()
		}
		request = request.WithContext(requestid.With(request.Context(), id))
		w.Header().Set("X-Request-ID", id)
		recorder := &metricsResponse{ResponseRecorder: &httpx.ResponseRecorder{ResponseWriter: w}}
		defer func() {
			if value := recover(); value != nil {
				httpx.LogFailure(logger, request.Context(), "metrics", "scrape", errors.New("metrics handler panicked"))
				panic(value)
			}
			if recorder.writeErr != nil {
				httpx.LogFailure(logger, request.Context(), "metrics", "write", recorder.writeErr)
			} else if recorder.Status >= 500 {
				httpx.LogFailure(logger, request.Context(), "metrics", "scrape", errors.New("metrics request failed"))
			}
		}()
		next.ServeHTTP(recorder, request)
	})
}
