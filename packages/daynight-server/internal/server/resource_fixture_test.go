package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type resourceTestHandler struct {
	http.Handler
	token     string
	principal model.Principal
}

func resourceTestServer(t *testing.T, database store.Transactions, files filestorage.Storage, output io.Writer) *resourceTestHandler {
	return resourceTestServerForPrincipal(t, database, files, output, defaultHTTPPrincipal())
}

func resourceTestServerForPrincipal(t *testing.T, database store.Transactions, files filestorage.Storage, output io.Writer, principal model.Principal) *resourceTestHandler {
	t.Helper()
	logger := slog.New(slog.NewJSONHandler(output, nil))
	handler, err := newTestHandler(Dependencies{Store: database, Files: files}, configuredTestConfig(), logger)
	if err != nil {
		t.Fatal(err)
	}
	application := handler.(Handler)
	t.Cleanup(func() {
		application.BeginShutdown()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := application.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	return &resourceTestHandler{Handler: httpx.RequestLogging(logger, handler), token: httpTestToken(principal.Kind), principal: principal}
}

func authorizeResourceRequest(handler http.Handler, request *http.Request) {
	if resource, ok := handler.(*resourceTestHandler); ok {
		request.Header.Set("Authorization", "Bearer "+resource.token)
	}
}
