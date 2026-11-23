package preview

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	attachmenthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const taskID = "92dab496-4ec1-4ad9-9700-22219a90bf37"
const taskPath = "/api/v1/projects/f36af519-4b3b-4bb9-877c-cae8ead38301/tasks/" + taskID + "/preview/a.html"
const taskOrigin = "http://" + taskID + ".preview.daynight.test"

func taskFixture(t *testing.T, ops *operations, next httpx.AuthenticatedHandler) (*Routes, http.Handler) {
	t.Helper()
	h, _, _ := fixture(t, ops, false)
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/projects/{projectId}/tasks/{taskId}/preview/{path...}", h.Require(next))
	mux.HandleFunc("/api/v1/projects/{projectId}/tasks/{taskId}/preview/{path...}", h.Require(httpx.ResourceMethodNotAllowed(h.logger, "GET, HEAD")))
	return h, h.Wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusAccepted) }), attachmenthttp.PathGuard(mux, h.logger))
}

func TestDirectNavigationPreservesTransportBoundaries(t *testing.T) {
	var got string
	var calls int
	ops := &operations{create: func(_ context.Context, target string) (model.PreviewSSOLogin, error) {
		calls++
		got = target
		return model.PreviewSSOLogin{ID: "record"}, nil
	}}
	h, taskHandler := taskFixture(t, ops, func(http.ResponseWriter, *http.Request, model.Principal) { t.Fatal("unexpected content") })
	handler := httpx.LimitRequestTarget(h.logger, taskHandler)
	queryPrefix := "a=%2F&b="
	query := queryPrefix + strings.Repeat("q", transport.MaxRawQueryBytes-len(queryPrefix))
	targets := []struct {
		target string
		status int
	}{
		{taskPath + "?" + query, 303},
		{taskPath + "?" + query + "q", 414},
		{taskPath + strings.Repeat("x", transport.MaxRequestTargetBytes-len(taskPath)), 303},
		{taskPath + strings.Repeat("x", transport.MaxRequestTargetBytes-len(taskPath)+1), 414},
	}
	for _, tc := range targets {
		before := calls
		r := httptest.NewRequest("GET", tc.target, nil)
		r.Host = taskID + ".preview.daynight.test"
		r.Header.Set("Sec-Fetch-Mode", "navigate")
		r.Header.Set("Sec-Fetch-Dest", "document")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.status {
			t.Fatalf("target length %d = %d, want %d", len(tc.target), w.Code, tc.status)
		}
		if tc.status == 303 {
			if calls != before+1 || got != taskOrigin+tc.target || w.Header().Get("Location") != "http://preview.daynight.test/auth/sso/start?login=record" {
				t.Fatalf("target not preserved at length %d", len(tc.target))
			}
		} else if calls != before {
			t.Fatalf("oversized target created a login at length %d", len(tc.target))
		}
	}
}

func taskRequest(handler http.Handler, method, target, destination string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, nil)
	if destination != "" {
		r.Header.Set("Sec-Fetch-Mode", "navigate")
		r.Header.Set("Sec-Fetch-Dest", destination)
	}
	for _, cookie := range cookies {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func TestTaskHostDirectNavigationAndAuthentication(t *testing.T) {
	principal := model.Principal{Kind: model.SessionCredential, UserID: "user", CredentialID: "session"}
	var target string
	var authenticated, served int
	ops := &operations{
		create: func(_ context.Context, got string) (model.PreviewSSOLogin, error) {
			target = got
			return model.PreviewSSOLogin{ID: "record"}, nil
		},
		authenticate: func(_ context.Context, value string) (model.Principal, time.Time, error) {
			authenticated++
			if value == "valid" {
				return principal, time.Time{}, nil
			}
			return model.Principal{}, time.Time{}, model.Unauthenticated(nil)
		},
	}
	h, handler := taskFixture(t, ops, func(w http.ResponseWriter, r *http.Request, got model.Principal) {
		served++
		if got != principal || r.PathValue("path") != "a.html" {
			t.Fatalf("unexpected principal or path: %#v %q", got, r.PathValue("path"))
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("original"))
	})
	for _, destination := range []string{"document", "iframe"} {
		w := taskRequest(handler, "GET", taskOrigin+taskPath+"?a=%2F&b=1", destination)
		if w.Code != 303 || w.Header().Get("Location") != "http://preview.daynight.test/auth/sso/start?login=record" || target != taskOrigin+taskPath+"?a=%2F&b=1" {
			t.Fatalf("navigation = %d %v target %q", w.Code, w.Header(), target)
		}
	}
	good := &http.Cookie{Name: h.SessionCookieName(), Value: "valid"}
	w := taskRequest(handler, "GET", taskOrigin+taskPath, "document", good)
	if w.Code != 200 || w.Body.String() != "original" || w.Header().Get("Origin-Agent-Cluster") != "?1" || served != 1 || authenticated != 1 {
		t.Fatalf("valid = %d %q %v", w.Code, w.Body, w.Header())
	}
	bad := &http.Cookie{Name: h.SessionCookieName(), Value: "expired"}
	w = taskRequest(handler, "GET", taskOrigin+taskPath, "iframe", bad)
	if w.Code != 303 || served != 1 || authenticated != 2 {
		t.Fatalf("expired = %d", w.Code)
	}
	for _, tc := range []struct{ method, destination string }{{"HEAD", "document"}, {"GET", ""}, {"GET", "image"}} {
		w = taskRequest(handler, tc.method, taskOrigin+taskPath, tc.destination)
		if w.Code != 401 || strings.Contains(w.Header().Get("Content-Type"), "text/html") || w.Header().Get("Location") != "" || !strings.Contains(w.Header().Get("Link"), "/auth/sso/start") {
			t.Fatalf("subresource = %d %v", w.Code, w.Header())
		}
		if tc.method == "HEAD" && w.Body.Len() != 0 {
			t.Fatalf("HEAD error wrote body: %q", w.Body)
		}
	}
	w = taskRequest(handler, "POST", taskOrigin+taskPath, "", good)
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("method refusal = %d %v", w.Code, w.Header())
	}
	if served != 1 {
		t.Fatalf("unauthenticated requests invoked content %d times", served)
	}
}

func TestTaskHostRejectsAliasesAndMismatchBeforeAuthentication(t *testing.T) {
	ops := &operations{}
	_, handler := taskFixture(t, ops, func(http.ResponseWriter, *http.Request, model.Principal) { t.Fatal("unexpected content") })
	for _, host := range []string{strings.ToUpper(taskID) + ".preview.daynight.test", taskID + ".preview.daynight.test.", taskID + ".preview.daynight.test:80", "x." + taskID + ".preview.daynight.test", "00000000-0000-0000-0000-000000000000.preview.daynight.test"} {
		w := taskRequest(handler, "GET", "http://"+host+taskPath, "")
		if w.Code != 404 {
			t.Fatalf("host %q = %d", host, w.Code)
		}
	}
	wrong := strings.Replace(taskPath, taskID, "1624a880-b44b-41fd-9ac7-f6486b09386d", 1)
	w := taskRequest(handler, "GET", taskOrigin+wrong, "document")
	if w.Code != 404 || !strings.Contains(w.Body.String(), "Preview unavailable") {
		t.Fatalf("mismatch = %d %q", w.Code, w.Body)
	}
}

func TestTaskDocumentErrorsAndFailures(t *testing.T) {
	status := 403
	ops := &operations{authenticate: func(context.Context, string) (model.Principal, time.Time, error) {
		return model.Principal{UserID: "user"}, time.Time{}, nil
	}}
	h, handler := taskFixture(t, ops, func(w http.ResponseWriter, _ *http.Request, _ model.Principal) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", "5")
		w.WriteHeader(status)
		_, _ = w.Write([]byte("error"))
	})
	cookie := &http.Cookie{Name: h.SessionCookieName(), Value: "valid"}
	for _, status = range []int{401, 403, 404, 500} {
		w := taskRequest(handler, "GET", taskOrigin+taskPath+"?x=1", "iframe", cookie)
		if w.Code != status || !strings.Contains(w.Body.String(), `href=""`) || !strings.Contains(w.Body.String(), "Request ID") || !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'self' http://daynight.test") || strings.Contains(w.Body.String(), ">error<") {
			t.Fatalf("error %d = %d %q %v", status, w.Code, w.Body, w.Header())
		}
		if strings.Contains(w.Body.String(), "Sign in in a new tab") != (status == 401) {
			t.Fatalf("login action for %d: %s", status, w.Body)
		}
		hash := sha256.Sum256([]byte(retryScript))
		if !strings.Contains(w.Body.String(), "<script>"+retryScript+"</script>") || !strings.Contains(w.Header().Get("Content-Security-Policy"), "'sha256-"+base64.StdEncoding.EncodeToString(hash[:])+"'") {
			t.Fatal("retry script is not allowed by its CSP")
		}
		w = taskRequest(handler, "GET", taskOrigin+taskPath, "", cookie)
		if w.Code != status || w.Body.String() != "error" || w.Header().Get("Content-Type") != "application/json" {
			t.Fatalf("subresource %d = %d %q", status, w.Code, w.Body)
		}
	}
	w := taskRequest(handler, "GET", taskOrigin+strings.Replace(taskPath, "/preview/", "/preview/../", 1), "document")
	if w.Code != 400 || !strings.Contains(w.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("path guard = %d %q", w.Code, w.Body)
	}
	broken := &operations{authenticate: func(context.Context, string) (model.Principal, time.Time, error) {
		return model.Principal{}, time.Time{}, errors.New("storage failed")
	}}
	h2, handler2 := taskFixture(t, broken, func(http.ResponseWriter, *http.Request, model.Principal) { t.Fatal("unexpected content") })
	w = taskRequest(handler2, "GET", taskOrigin+taskPath, "document", &http.Cookie{Name: h2.SessionCookieName(), Value: "x"})
	if w.Code != 500 || w.Header().Get("Location") != "" {
		t.Fatalf("auth failure = %d %v", w.Code, w.Header())
	}
	ops2 := &operations{create: func(context.Context, string) (model.PreviewSSOLogin, error) {
		return model.PreviewSSOLogin{}, errors.New("storage failed")
	}}
	_, handler3 := taskFixture(t, ops2, func(http.ResponseWriter, *http.Request, model.Principal) { t.Fatal("unexpected content") })
	r := httptest.NewRequest("GET", taskOrigin+taskPath, nil)
	r.Header.Set("Sec-Fetch-Mode", "navigate")
	r.Header.Set("Sec-Fetch-Dest", "iframe")
	r.Header.Set("Accept-Language", "zh-CN")
	w = httptest.NewRecorder()
	handler3.ServeHTTP(w, r)
	if w.Code != 500 || w.Header().Get("Location") != "" || !strings.Contains(w.Body.String(), "暂时无法打开文件预览") {
		t.Fatalf("create error = %d %q", w.Code, w.Body)
	}
}
