package attachment

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func TestMainPreviewRedirectAndHead(t *testing.T) {
	const project = "f36af519-4b3b-4bb9-877c-cae8ead38301"
	const task = "92dab496-4ec1-4ad9-9700-22219a90bf37"
	path := "/api/v1/projects/" + project + "/tasks/" + task + "/preview/docs/a%20b.html"
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	opens, auths := 0, 0
	h := &attachmentHandler{logger: logger, attachments: attachmentOperations{Open: func(_ context.Context, _ model.Principal, p, id, name string) (model.Attachment, filestorage.Object, error) {
		opens++
		if p != project || id != task || name != "docs/a b.html" {
			t.Fatalf("opened %s/%s/%s", p, id, name)
		}
		return model.Attachment{Path: name, ContentType: "text/html"}, filestorage.Object{Body: io.NopCloser(strings.NewReader("abc")), Info: filestorage.FileInfo{Size: 3}}, nil
	}}}
	require := func(next httpx.AuthenticatedHandler) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			auths++
			if r.Header.Get("Authorization") == "" {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			next(w, r, model.Principal{})
		}
	}
	mux := http.NewServeMux()
	h.registerRoutes(mux, require, "https://preview.daynight.test")
	handler := PathGuard(mux, logger)
	for _, host := range []string{"daynight.test", "alias.daynight.test"} {
		r := httptest.NewRequest(http.MethodGet, "https://"+host+path+"?v=%2F&x=1", nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		want := "https://" + task + ".preview.daynight.test" + path + "?v=%2F&x=1"
		if w.Code != http.StatusFound || w.Header().Get("Location") != want || auths != 0 || opens != 0 {
			t.Fatalf("redirect: %d %q auth=%d opens=%d", w.Code, w.Header().Get("Location"), auths, opens)
		}
	}
	query := "x=%2F&" + strings.Repeat("q", transport.MaxRawQueryBytes-len("x=%2F&"))
	longPath := path + strings.Repeat("a", transport.MaxRequestTargetBytes-len(path)-1-len(query))
	rawTarget := longPath + "?" + query
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "https://daynight.test"+rawTarget, nil))
	if len(rawTarget) != transport.MaxRequestTargetBytes || w.Code != http.StatusFound || w.Header().Get("Location") != "https://"+task+".preview.daynight.test"+rawTarget {
		t.Fatalf("boundary target: size=%d status=%d", len(rawTarget), w.Code)
	}
	for _, authorized := range []bool{false, true} {
		r := httptest.NewRequest(http.MethodHead, "https://daynight.test"+path, nil)
		if authorized {
			r.Header.Set("Authorization", "Bearer test")
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if !authorized && w.Code != http.StatusUnauthorized || authorized && (w.Code != http.StatusOK || w.Header().Get("Content-Length") != "3" || w.Body.Len() != 0) {
			t.Fatalf("HEAD authorized=%v: %d %v", authorized, w.Code, w.Header())
		}
	}
	if auths != 2 || opens != 1 {
		t.Fatalf("HEAD auth=%d opens=%d", auths, opens)
	}
	for _, bad := range []string{strings.Replace(path, task, "not-a-uuid", 1), path + "/../private"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "https://daynight.test"+bad, nil))
		if w.Code != http.StatusBadRequest || w.Header().Get("Location") != "" {
			t.Fatalf("invalid preview path: %d %q", w.Code, w.Header().Get("Location"))
		}
	}
}
