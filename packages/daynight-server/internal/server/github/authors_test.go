package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

func TestAuthorDirectoryResponse(t *testing.T) {
	c, _ := fixture()
	c.Revision = 9007199254740993
	s := &readerStub{authorsPage: coregithub.AuthorsPage{Connection: c, Items: []githubpr.Author{{ID: 9007199254740995, Login: "Name", LoginAmbiguous: true}}, NextCursor: pointer("next")}}
	m := newMux(s)
	path := "/api/v1/projects/" + strings.ToUpper(projectID) + "/pull-request-authors?q=Ab%25&limit=1&cursor=token"
	w := call(m, http.MethodGet, path)
	var page api.PullRequestAuthorPage
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || w.Code != http.StatusOK {
		t.Fatalf("response %d %s: %v", w.Code, w.Body, err)
	}
	if s.calls != 1 || s.id != projectID || s.principal.UserID != userID || s.authorsInput != (coregithub.AuthorsRequest{Query: "Ab%", Limit: 1, Cursor: "token"}) {
		t.Fatalf("incorrect request: %+v", s)
	}
	if page.ProjectID != projectID || page.Revision != "9007199254740993" || len(page.Items) != 1 || page.Items[0] != (api.PullRequestDirectoryAuthor{ID: "9007199254740995", Login: "Name", LoginAmbiguous: true}) || page.NextCursor == nil || *page.NextCursor != "next" || strings.Contains(w.Body.String(), "total") {
		t.Fatalf("incorrect response: %s", w.Body)
	}
	if w.Header().Get("Daynight-User-ID") != userID || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Header())
	}
	s.authorsPage = coregithub.AuthorsPage{Connection: c}
	w = call(m, http.MethodHead, "/api/v1/projects/"+projectID+"/pull-request-authors?q=")
	if w.Code != http.StatusOK || s.authorsInput != (coregithub.AuthorsRequest{Limit: 50}) {
		t.Fatalf("empty HEAD: %d %s %+v", w.Code, w.Body, s.authorsInput)
	}
	w = call(m, http.MethodGet, "/api/v1/projects/"+projectID+"/pull-request-authors")
	if !strings.Contains(w.Body.String(), `"items":[]`) || !strings.Contains(w.Body.String(), `"nextCursor":null`) {
		t.Fatalf("empty GET: %d %s", w.Code, w.Body)
	}
}

func TestAuthorDirectoryRejectsInvalidQueryAndMethod(t *testing.T) {
	s := &readerStub{}
	m := newMux(s)
	base := "/api/v1/projects/" + projectID + "/pull-request-authors"
	for _, query := range []string{"?q=%00", "?q=%FF", "?q=%GG", "?q=" + strings.Repeat("a", 1025), "?q=a&q=b", "?cursor=", "?cursor=a&cursor=b", "?limit=", "?limit=0", "?limit=101", "?limit=01", "?limit=+1", "?limit=x", "?limit=1&limit=2", "?state=all", "?unknown=x"} {
		w := call(m, http.MethodGet, base+query)
		if w.Code != http.StatusBadRequest || s.calls != 0 {
			t.Errorf("%q: %d %s calls %d", query, w.Code, w.Body, s.calls)
		}
	}
	w := call(m, http.MethodGet, base+"?q="+strings.Repeat("a", 70000))
	if w.Code != http.StatusRequestURITooLong || s.calls != 0 {
		t.Fatalf("long query: %d, calls %d", w.Code, s.calls)
	}
	w = call(m, http.MethodPost, base)
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD" || w.Header().Get("Daynight-User-ID") != userID || w.Header().Get("Cache-Control") != "no-store" || s.calls != 0 {
		t.Fatalf("method: %d %v calls %d", w.Code, w.Header(), s.calls)
	}
}

func TestAuthorDirectoryFailuresAreDistinctAndRedacted(t *testing.T) {
	var log bytes.Buffer
	s := &readerStub{}
	m := http.NewServeMux()
	RegisterPullRequestRoutes(m, s, authStub{}, slog.New(slog.NewJSONHandler(&log, nil)))
	path := "/api/v1/projects/" + projectID + "/pull-request-authors?q=private-query&cursor=private-cursor"
	for _, tc := range []struct {
		err    error
		status int
		code   string
	}{
		{&model.Fault{Code: "resource_conflict", Message: "private-fault"}, http.StatusConflict, "resource_conflict"},
		{&model.Fault{Code: "not_found", Message: "not found"}, http.StatusNotFound, "not_found"},
		{errors.New("private-login private-title private-body"), http.StatusInternalServerError, "internal_error"},
	} {
		s.err = tc.err
		w := call(m, http.MethodGet, path)
		if w.Code != tc.status || !strings.Contains(w.Body.String(), tc.code) {
			t.Errorf("error: %d %s", w.Code, w.Body)
		}
	}
	for _, secret := range []string{"private-query", "private-cursor", "private-login", "private-title", "private-body", "private-fault"} {
		if strings.Contains(log.String(), secret) {
			t.Errorf("log exposed %q: %s", secret, log.String())
		}
	}
	if !strings.Contains(log.String(), `"phase":"authors"`) || !strings.Contains(log.String(), `"project_id":"`+projectID+`"`) || !strings.Contains(log.String(), `"user_id":"`+userID+`"`) {
		t.Fatalf("missing context: %s", log.String())
	}
}

type blockingAuthorsReader struct {
	readerStub
	started chan struct{}
	stopped chan struct{}
}

func (s *blockingAuthorsReader) Authors(ctx context.Context, _ model.Principal, _ string, _ coregithub.AuthorsRequest) (coregithub.AuthorsPage, error) {
	close(s.started)
	<-ctx.Done()
	close(s.stopped)
	return coregithub.AuthorsPage{}, ctx.Err()
}

func TestAuthorDirectoryPropagatesCancellation(t *testing.T) {
	s := &blockingAuthorsReader{started: make(chan struct{}), stopped: make(chan struct{})}
	m := http.NewServeMux()
	RegisterPullRequestRoutes(m, s, authStub{}, slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+projectID+"/pull-request-authors", nil).WithContext(ctx)
	finished := make(chan struct{})
	go func() { m.ServeHTTP(w, r); close(finished) }()
	select {
	case <-s.started:
	case <-time.After(time.Second):
		t.Fatal("read did not start")
	}
	cancel()
	select {
	case <-s.stopped:
	case <-time.After(time.Second):
		t.Fatal("read did not receive cancellation")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("handler did not return")
	}
	if w.Body.Len() != 0 {
		t.Fatalf("cancelled response: %s", w.Body)
	}
}
