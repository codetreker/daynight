package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestScopeRegistryRefusesUnclassifiedHandler(t *testing.T) {
	mux := http.NewServeMux()
	registry := newScopeRegistry(mux, "main")
	called := false
	registry.HandleFunc("GET /private", func(http.ResponseWriter, *http.Request) { called = true })
	if err := registry.validate(); err == nil || !strings.Contains(err.Error(), "GET /private") {
		t.Fatalf("missing route classification accepted: %v", err)
	}
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/private", nil))
	if called || response.Code != http.StatusServiceUnavailable {
		t.Fatalf("unclassified business handler ran: called=%v status=%d", called, response.Code)
	}
}

func TestScopeRegistryRecordsActualMethodsHostsAndFallbacks(t *testing.T) {
	mux := http.NewServeMux()
	registry := newScopeRegistry(mux, "main")
	registry.scoped("task-fields-and-projection").HandleFunc("GET /tasks", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	registry.fixed("explicit-method-refusal").HandleFunc("HEAD /tasks", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusMethodNotAllowed) })
	registry.fixed("authenticated-method-fallback").HandleFunc("/tasks", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusMethodNotAllowed) })
	if err := registry.validate(); err != nil {
		t.Fatal(err)
	}
	entries := registry.inventory()
	if len(entries) != 3 {
		t.Fatalf("inventory contains duplicated implicit HEAD: %#v", entries)
	}
	for _, entry := range entries {
		if entry.Host != "main" || entry.Admission == "" {
			t.Fatalf("incomplete classification: %#v", entry)
		}
		if entry.Pattern == "HEAD /tasks" && entry.Profile != "explicit-method-refusal" {
			t.Fatal("implicit HEAD replaced explicit HEAD")
		}
	}
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodHead, "/tasks", nil))
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("explicit HEAD handler changed: %d", response.Code)
	}
	defer func() {
		if recover() == nil {
			t.Error("registration after startup validation succeeded")
		}
	}()
	registry.fixed("public").HandleFunc("/late", func(http.ResponseWriter, *http.Request) {})
}

func TestProductionScopeInventory(t *testing.T) {
	application, err := newTestHandler(Dependencies{Store: newHTTPTestStore(t), Files: attachmentTestFiles(t)}, configuredTestConfig(), testLogger())
	if err != nil {
		t.Fatal(err)
	}
	handler := application.(*sessionApplication)
	t.Cleanup(func() {
		handler.BeginShutdown()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := handler.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	seen := map[string]bool{}
	for _, entry := range handler.scopeRoutes {
		key := entry.Host + " " + entry.Pattern
		if seen[key] || entry.Admission == "" || entry.Profile == "" {
			t.Fatalf("invalid actual production route classification: %#v", entry)
		}
		seen[key] = true
	}
	for _, key := range []string{"main /mcp", "main GET /api/v1/projects/{projectId}/tasks", "main HEAD /api/v1/projects/{projectId}/tasks", "main /api/v1/projects/{projectId}/tasks"} {
		if !seen[key] {
			t.Fatalf("actual production registration missing: %s", key)
		}
	}
	preview := false
	for _, entry := range handler.scopeRoutes {
		if entry.Host == "task-preview" {
			preview = true
			if entry.Profile != "preview-cookie-only" {
				t.Fatalf("preview accepted a user API profile: %#v", entry)
			}
		}
	}
	if !preview {
		t.Fatal("task preview registrations were omitted")
	}
	if len(handler.scopeDetails) == 0 {
		t.Fatal("domain operation classifications were omitted")
	}
	encoded, err := json.Marshal(struct {
		Routes     []routeClassification
		Operations []json.RawMessage
	}{handler.scopeRoutes, handler.scopeDetails})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("production route inventory: %s", encoded)
}
