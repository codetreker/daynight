package github

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

func TestRepositoryDirectoryResponse(t *testing.T) {
	id := int64(9007199254740995)
	s := &readerStub{repositoriesPage: coregithub.RepositoriesPage{CurrentRepositoryID: &id, Items: []githubpr.Repository{{RepositoryID: id, FullName: "owner/repo"}}, NextCursor: pointer("next")}}
	m := newMux(s)
	r := httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+projectID+"/pull-request-repositories?limit=1&cursor=token", nil)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	w := httptest.NewRecorder()
	m.ServeHTTP(w, r.WithContext(ctx))
	var page api.PullRequestRepositoryPage
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || w.Code != http.StatusOK {
		t.Fatalf("directory: %d %s %v", w.Code, w.Body, err)
	}
	if s.calls != 1 || s.id != projectID || s.ctx != ctx || s.principal.UserID != userID || s.repositoriesInput != (coregithub.RepositoriesRequest{Limit: 1, Cursor: "token"}) {
		t.Fatalf("request: %+v", s)
	}
	if page.CurrentRepositoryID == nil || *page.CurrentRepositoryID != "9007199254740995" || len(page.Items) != 1 || page.Items[0] != (api.PullRequestRepository{RepositoryID: "9007199254740995", FullName: "owner/repo"}) || page.NextCursor == nil || *page.NextCursor != "next" {
		t.Fatalf("directory: %s", w.Body)
	}
	if w.Header().Get("Daynight-User-ID") != userID || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Header())
	}
	s.repositoriesPage = coregithub.RepositoriesPage{}
	w = call(m, http.MethodGet, "/api/v1/projects/"+projectID+"/pull-request-repositories")
	if w.Code != http.StatusOK || s.repositoriesInput.Limit != 100 || strings.TrimSpace(w.Body.String()) != `{"currentRepositoryId":null,"items":[],"nextCursor":null}` {
		t.Fatalf("empty: %d %s", w.Code, w.Body)
	}
	w = call(m, http.MethodHead, "/api/v1/projects/"+projectID+"/pull-request-repositories")
	if w.Code != http.StatusOK {
		t.Fatalf("HEAD: %d", w.Code)
	}
}

func TestRepositoryDirectoryProtocolAndErrors(t *testing.T) {
	s := &readerStub{}
	m := newMux(s)
	base := "/api/v1/projects/" + projectID + "/pull-request-repositories"
	for _, query := range []string{"?limit=0", "?limit=101", "?limit=01", "?limit=x", "?limit=+1", "?limit=1&limit=1", "?cursor=", "?cursor=a&cursor=b", "?unknown=x", "?q=", "?repositoryId=1", "?cursor=%GG"} {
		w := call(m, http.MethodGet, base+query)
		if w.Code != http.StatusBadRequest || s.calls != 0 {
			t.Errorf("%q: %d %s calls %d", query, w.Code, w.Body, s.calls)
		}
	}
	w := call(m, http.MethodGet, base+"?cursor="+strings.Repeat("a", 70000))
	if w.Code != http.StatusRequestURITooLong || s.calls != 0 {
		t.Fatalf("long query: %d", w.Code)
	}
	w = call(m, http.MethodPost, base)
	if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD" || s.calls != 0 {
		t.Fatalf("method: %d %v calls %d", w.Code, w.Header(), s.calls)
	}
	for _, tc := range []struct {
		err    error
		status int
	}{
		{&model.Fault{Code: "not_found", Message: "not found"}, http.StatusNotFound},
		{&model.Fault{Code: "forbidden", Message: "forbidden"}, http.StatusForbidden},
		{errors.New("private storage error"), http.StatusInternalServerError},
	} {
		s.err = tc.err
		w = call(m, http.MethodGet, base)
		if w.Code != tc.status || strings.Contains(w.Body.String(), "private") {
			t.Errorf("failure: %d %s", w.Code, w.Body)
		}
	}
}

func TestSourceScopedReadProtocol(t *testing.T) {
	c, pr := fixture()
	repository := &githubpr.Repository{RepositoryID: 9007199254740995, FullName: "owner/repo"}
	s := &readerStub{page: coregithub.Page{Connection: c, Repository: repository}, authorsPage: coregithub.AuthorsPage{Connection: c, Repository: repository}, statisticsResult: coregithub.Statistics{Connection: c, Repository: repository}, detail: coregithub.Detail{Connection: c, PullRequest: githubpr.PullRequest{PullRequestSummary: pr}}}
	m := newMux(s)
	stats := "/pull-request-statistics?endDate=2026-01-30&window=0@1767225600000,-@1767312000000"
	for _, path := range []string{"/pull-requests?state=all", "/pull-requests/42", "/pull-request-authors", stats} {
		separator := "&"
		if !strings.Contains(path, "?") {
			separator = "?"
		}
		w := call(m, http.MethodGet, "/api/v1/projects/"+projectID+path+separator+"repositoryId=9007199254740995")
		if w.Code != http.StatusOK {
			t.Fatalf("source read %s: %d %s", path, w.Code, w.Body)
		}
		var selected *int64
		switch {
		case strings.HasPrefix(path, "/pull-requests/42"):
			selected = s.repositoryID
		case strings.HasPrefix(path, "/pull-requests?"):
			selected = s.input.RepositoryID
		case strings.HasPrefix(path, "/pull-request-authors"):
			selected = s.authorsInput.RepositoryID
		default:
			selected = s.statisticsInput.RepositoryID
		}
		if selected == nil || *selected != repository.RepositoryID {
			t.Fatalf("source not propagated for %s: %+v", path, s)
		}
		if !strings.HasPrefix(path, "/pull-requests/42") && !strings.Contains(w.Body.String(), `"repository":{"repositoryId":"9007199254740995","fullName":"owner/repo"}`) {
			t.Fatalf("source metadata: %s", w.Body)
		}
	}
	for _, route := range []string{"/pull-requests?", "/pull-requests/42?", "/pull-request-authors?", stats + "&"} {
		for _, value := range []string{"", "0", "-1", "%2B1", "01", "1.0", "9223372036854775808", "1&repositoryId=1"} {
			before := s.calls
			w := call(m, http.MethodGet, "/api/v1/projects/"+projectID+route+"repositoryId="+value)
			if w.Code != http.StatusBadRequest || s.calls != before {
				t.Errorf("invalid source %s %q: %d %s calls %d -> %d", route, value, w.Code, w.Body, before, s.calls)
			}
		}
	}
}
