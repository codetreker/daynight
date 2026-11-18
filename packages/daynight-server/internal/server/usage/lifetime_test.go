package usage

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
)

func TestUsageHTTPPropagatesCancellationAndDrainsInvokedOperation(t *testing.T) {
	const id = "10000000-0000-4000-8000-000000000001"
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	started, finished := make(chan struct{}), make(chan struct{})
	service := &controlledOperations{
		t: t, ctx: ctx, name: "records",
		args: []any{"", "", id, app.PageRequest{Kind: "measurement", Limit: 100}},
		err:  context.Canceled,
		onCall: func(actual context.Context) {
			close(started)
			<-actual.Done()
		},
	}
	mux := http.NewServeMux()
	registerRoutes(mux, service, fixedAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	go func() {
		defer close(finished)
		mux.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/test-sessions/"+id+"/usage/v1/records?kind=measurement", nil).WithContext(ctx))
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("business operation did not start")
	}
	cancel()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("request did not drain after cancellation")
	}
	if service.calls != 1 || service.principal != (model.Principal{}) {
		t.Fatal(service.calls)
	}
}
