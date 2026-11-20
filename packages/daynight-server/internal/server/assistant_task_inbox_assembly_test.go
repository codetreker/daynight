package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

// The runtime assembly registers the inbox route only when the persistence
// type provides the inbound transaction.
var _ store.AssistantTaskInboundWriter = (*postgres.Store)(nil)

type inboxAssemblyStore struct {
	*httpTestStore
	calls int
}

func (s *inboxAssemblyStore) WriteAssistantTaskInbound(context.Context, func(store.AssistantTaskInboundScope) error) (store.Completion, error) {
	s.calls++
	return store.Completion{Outcome: store.TransactionNotCommitted}, &model.Fault{Code: "not_found", Message: "The assistant task inbox does not exist."}
}

func TestAssistantTaskInboxRouteIsPublicInRuntimeAssembly(t *testing.T) {
	cfg := configuredTestConfig()
	cfg.S2S.AllowedOrigin = browserAPIOrigin
	db := &inboxAssemblyStore{httpTestStore: newHTTPTestStore(t)}
	client, err := service.NewIdentityClient(cfg.UniAuth)
	if err != nil {
		t.Fatal(err)
	}
	app := service.NewModules(cfg, db, nil, attachmentTestFiles(t), client)
	if app.AssistantTaskInbox == nil {
		t.Fatal("assembly did not build the assistant task inbox")
	}
	app.CredentialUsage = unusedUsageRecorder(testLogger())
	witness := &rootIdentityWitness{IdentityOperations: app.Identity}
	app.Identity = witness
	root, err := New(app, cfg, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		root.BeginShutdown()
		if err := root.Shutdown(ctx); err != nil {
			t.Error(err)
		}
		if err := app.Engine.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	const path = "/api/v1/assistant-task-inbox/10000000-0000-4000-8000-000000000001"
	request := httptest.NewRequest("POST", path+"?token=unused", strings.NewReader(`{}`))
	request.Header = http.Header{"Origin": {browserAPIOrigin}, "Content-Type": {"application/json"}}
	w := httptest.NewRecorder()
	root.ServeHTTP(w, request)
	var body struct {
		Error struct{ Code, Message string }
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("inbox response body: %v %s", err, w.Body.String())
	}
	if w.Code != http.StatusNotFound || body.Error.Code != "not_found" || !strings.Contains(body.Error.Message, "assistant task inbox") || db.calls != 1 {
		t.Fatalf("inbox route not reached: %d %s calls=%d", w.Code, w.Body.String(), db.calls)
	}
	preflight := corsHTTP(t, root, "OPTIONS", path, http.Header{"Origin": {browserAPIOrigin}, "Access-Control-Request-Method": {"POST"}})
	if preflight.Code != http.StatusMethodNotAllowed || preflight.Header().Get("Allow") != "POST" {
		t.Fatalf("inbox preflight: %d %v", preflight.Code, preflight.Header())
	}
	for _, response := range []http.Header{w.Header(), preflight.Header()} {
		for name := range response {
			if strings.HasPrefix(name, "Access-Control-") {
				t.Fatalf("inbox response carries CORS header %s", name)
			}
		}
	}
	if witness.calls != 0 {
		t.Fatalf("inbox requests authenticated %d times", witness.calls)
	}
}
