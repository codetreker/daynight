package prompt

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const userID = "11111111-1111-4111-8111-111111111111"
const resourceID = "abcdefab-cdef-4abc-8def-abcdefabcdef"

type fakePrompts struct {
	gets, puts                   int
	scope                        model.PromptScope
	id, expected, revision, text string
	err                          error
}

func (f *fakePrompts) Get(_ context.Context, _ model.Principal, scope model.PromptScope, id string) (model.PromptResource, error) {
	f.gets++
	f.scope, f.id = scope, id
	if f.err != nil {
		return model.PromptResource{}, f.err
	}
	return model.PromptResource{Scope: scope, ScopeID: id, Revision: "0", Text: ""}, nil
}
func (f *fakePrompts) Put(_ context.Context, _ model.Principal, scope model.PromptScope, id, expected, revision, text string) (model.PromptResource, error) {
	f.puts++
	f.scope, f.id, f.expected, f.revision, f.text = scope, id, expected, revision, text
	if f.err != nil {
		return model.PromptResource{}, f.err
	}
	return model.PromptResource{Scope: scope, ScopeID: id, Revision: revision, Text: text}, nil
}

func requestResource(f *fakePrompts, method, path, body string, scope model.PromptScope, pathKey, id string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if pathKey != "" {
		r.SetPathValue(pathKey, id)
	}
	w := httptest.NewRecorder()
	h := handler{prompts: f, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	h.resource(w, r, model.Principal{UserID: userID}, scope)
	return w
}

func TestPromptResourcePathsAndHead(t *testing.T) {
	for _, tc := range []struct {
		scope         model.PromptScope
		key, id, want string
	}{
		{model.PromptScopeUser, "", "", userID},
		{model.PromptScopeProject, "projectId", strings.ToUpper(resourceID), resourceID},
		{model.PromptScopeWorker, "workerId", strings.ToUpper(resourceID), resourceID},
	} {
		f := &fakePrompts{}
		w := requestResource(f, http.MethodGet, "/", "", tc.scope, tc.key, tc.id)
		if w.Code != 200 || f.gets != 1 || f.scope != tc.scope || f.id != tc.want {
			t.Fatalf("GET: %d %s %+v", w.Code, w.Body, f)
		}
		var value map[string]any
		if json.Unmarshal(w.Body.Bytes(), &value) != nil || len(value) != 5 || value["scopeId"] != tc.want || value["revision"] != "0" || value["text"] != "" || value["updatedAt"] != nil {
			t.Fatalf("resource: %s", w.Body)
		}
		w = requestResource(f, http.MethodHead, "/", "", tc.scope, tc.key, tc.id)
		if w.Code != 200 || w.Body.Len() != 0 || f.gets != 2 {
			t.Fatalf("HEAD: %d %s", w.Code, w.Body)
		}
	}
}

func TestPromptPutStrictInputAndLimit(t *testing.T) {
	valid := fmt.Sprintf(`{"expectedUserId":%q,"revision":"0","text":"line\n<&>"}`, userID)
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"missing", `{"revision":"0","text":""}`, 400},
		{"null", fmt.Sprintf(`{"expectedUserId":%q,"revision":"0","text":null}`, userID), 400},
		{"numeric revision", fmt.Sprintf(`{"expectedUserId":%q,"revision":0,"text":""}`, userID), 400},
		{"duplicate", fmt.Sprintf(`{"expectedUserId":%q,"revision":"0","text":"","text":""}`, userID), 400},
		{"unknown", fmt.Sprintf(`{"expectedUserId":%q,"revision":"0","text":"","x":0}`, userID), 400},
		{"trailing", valid + ` {}`, 400},
		{"surrogate", fmt.Sprintf(`{"expectedUserId":%q,"revision":"0","text":"\ud800"}`, userID), 400},
		{"invalid utf8", valid + string([]byte{0xff}), 400},
		{"oversized", valid + strings.Repeat(" ", httpx.MaxJSONBody), 413},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakePrompts{}
			w := requestResource(f, http.MethodPut, "/", tc.body, model.PromptScopeUser, "", "")
			if w.Code != tc.status || f.puts != 0 {
				t.Fatalf("status=%d body=%s calls=%d", w.Code, w.Body, f.puts)
			}
		})
	}
	f := &fakePrompts{}
	w := requestResource(f, http.MethodPut, "/", valid, model.PromptScopeUser, "", "")
	if w.Code != 200 || f.puts != 1 || f.expected != userID || f.id != userID || f.revision != "0" || f.text != "line\n<&>" {
		t.Fatalf("PUT: %d %s %+v", w.Code, w.Body, f)
	}
	f = &fakePrompts{}
	w = requestResource(f, http.MethodGet, "/?", "", model.PromptScopeUser, "", "")
	if w.Code != 400 || f.gets != 0 {
		t.Fatalf("query: %d %s", w.Code, w.Body)
	}
	w = requestResource(f, http.MethodGet, "/", "", model.PromptScopeProject, "projectId", "bad")
	if w.Code != 400 || f.gets != 0 {
		t.Fatalf("path: %d %s", w.Code, w.Body)
	}
}

func TestPromptPutAtBodyLimitProducesCompleteBoundedResource(t *testing.T) {
	prefix := fmt.Sprintf(`{"expectedUserId":%q,"revision":"0","text":"`, userID)
	const suffix = `"}`
	text := strings.Repeat("<", httpx.MaxJSONBody-len(prefix)-len(suffix))
	f := &fakePrompts{}
	w := requestResource(f, http.MethodPut, "/", prefix+text+suffix, model.PromptScopeUser, "", "")
	if w.Code != http.StatusOK || f.text != text {
		t.Fatalf("full request: %d %d", w.Code, len(f.text))
	}
	if w.Body.Len() > 6*(1<<20)+4096 {
		t.Fatalf("response exceeds budget: %d", w.Body.Len())
	}
	var resource model.PromptResource
	if err := json.Unmarshal(w.Body.Bytes(), &resource); err != nil || resource.Text != text {
		t.Fatalf("response truncated: %v", err)
	}
}

type failedBody struct{}

func (failedBody) Read([]byte) (int, error) { return 0, errors.New("read failed") }
func (failedBody) Close() error             { return nil }

func TestPromptInputMediaAndReadFailure(t *testing.T) {
	for _, media := range []string{"", "text/plain", "application/json; charset=latin-1"} {
		r := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{}`))
		r.Header.Set("Content-Type", media)
		if _, err := decodePut(httptest.NewRecorder(), r); err == nil {
			t.Fatalf("accepted media %q", media)
		}
	}
	r := httptest.NewRequest(http.MethodPut, "/", nil)
	r.Header.Set("Content-Type", "application/json; charset=UTF-8")
	r.Body = failedBody{}
	if _, err := decodePut(httptest.NewRecorder(), r); err == nil {
		t.Fatal("accepted failed body read")
	}
}

func TestPromptServiceErrors(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		f := &fakePrompts{err: &model.Fault{Code: "version_conflict", Message: "The prompt revision has changed."}}
		body := fmt.Sprintf(`{"expectedUserId":%q,"revision":"0","text":"secret"}`, userID)
		w := requestResource(f, method, "/", body, model.PromptScopeUser, "", "")
		if w.Code != http.StatusConflict || strings.Contains(w.Body.String(), "secret") || !strings.Contains(w.Body.String(), "version_conflict") {
			t.Fatalf("%s: %d %s", method, w.Code, w.Body)
		}
	}
}

type fakeAuth struct{}

func (fakeAuth) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { next(w, r, model.Principal{UserID: userID}) }
}

func TestPromptRouteRegistration(t *testing.T) {
	mux := http.NewServeMux()
	f := &fakePrompts{}
	RegisterRoutes(mux, f, fakeAuth{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	for _, path := range []string{"/api/v1/me/worker-prompt", "/api/v1/me/projects/" + resourceID + "/worker-prompt", "/api/v1/me/workers/" + resourceID + "/prompt"} {
		for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPut, http.MethodDelete} {
			r := httptest.NewRequest(method, path, strings.NewReader(fmt.Sprintf(`{"expectedUserId":%q,"revision":"0","text":""}`, userID)))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if method == http.MethodDelete {
				if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD, PUT" {
					t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body)
				}
			} else if w.Code != http.StatusOK {
				t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body)
			}
		}
	}
}
