package project

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type repositoryMock struct {
	*projectMock
	preview func(context.Context, model.Principal, string, string, string) (coreproject.RepositoryPreview, error)
	save    func(context.Context, model.Principal, string, coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error)
}

func (m *repositoryMock) RepositoryPreview(ctx context.Context, p model.Principal, id, repo, expected string) (coreproject.RepositoryPreview, error) {
	m.h.invoked("RepositoryPreview", ctx, p)
	if m.preview == nil {
		panic("unexpected preview")
	}
	return m.preview(ctx, p, id, repo, expected)
}
func (m *repositoryMock) SetRepository(ctx context.Context, p model.Principal, id string, input coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error) {
	m.h.invoked("SetRepository", ctx, p)
	if m.save == nil {
		panic("unexpected save")
	}
	return m.save(ctx, p, id, input)
}
func repositoryHarness(t *testing.T) (*httpHarness, *repositoryMock) {
	t.Helper()
	h := newHTTPHarness(t)
	mock := &repositoryMock{projectMock: h.Projects}
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	mux := http.NewServeMux()
	RegisterRoutes(mux, mock, h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	return h, mock
}

func TestRepositoryRoutesSuccess(t *testing.T) {
	h, m := repositoryHarness(t)
	path := "/api/v1/projects/" + h.Project.ID + "/repository"
	repo := "git@github.com:org/new.git"
	target := int64(9007199254740993)
	reason := "provider_unavailable"
	m.preview = func(_ context.Context, _ model.Principal, id, address, expected string) (coreproject.RepositoryPreview, error) {
		if id != h.Project.ID || address != repo || expected != h.Principal.UserID {
			t.Fatalf("preview arguments: %q %q %q", id, address, expected)
		}
		return coreproject.RepositoryPreview{ProjectID: id, ProjectName: h.Project.Name, CurrentRepoURL: h.Project.RepoURL, RepoURL: address, RepositoryVersion: 9007199254740993, OwnershipVersion: 9007199254740994, Classification: "unverified", TargetGitHubRepositoryID: &target, UnverifiedReason: &reason, BindingsInvalidated: true}, nil
	}
	response := h.call("POST", path+"/preview", `{"repoUrl":"`+repo+`","expectedUserId":"`+h.Principal.UserID+`"}`)
	got := decodeResponse[api.RepositoryPreview](t, response, 200)
	if got.RepositoryVersion != "9007199254740993" || got.OwnershipVersion != "9007199254740994" || got.TargetGitHubRepositoryID == nil || *got.TargetGitHubRepositoryID != "9007199254740993" || got.UnverifiedReason == nil || *got.UnverifiedReason != reason || !got.BindingsInvalidated || got.CurrentRepoURL != h.Project.RepoURL || response.Header().Get("Daynight-User-ID") != h.Principal.UserID || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("preview: %+v %s", got, response.Body)
	}
	m.save = func(_ context.Context, _ model.Principal, id string, input coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error) {
		want := coreproject.RepositoryChange{RepoURL: repo, ExpectedUserID: h.Principal.UserID, RepositoryVersion: 9007199254740993, OwnershipVersion: 9007199254740994, Classification: "unverified", TargetGitHubRepositoryID: &target, TreatUnverifiedAsSwitch: true}
		if id != h.Project.ID || !reflect.DeepEqual(input, want) {
			t.Fatalf("save input %+v", input)
		}
		return coreproject.RepositoryReceipt{ProjectID: id, RepoURL: repo, RepositoryVersion: 9007199254740994, Changed: true, BindingsInvalidated: true}, nil
	}
	body := `{"repoUrl":"` + repo + `","expectedUserId":"` + h.Principal.UserID + `","repositoryVersion":"9007199254740993","ownershipVersion":"9007199254740994","classification":"unverified","targetGitHubRepositoryId":"9007199254740993","treatUnverifiedAsSwitch":true}`
	response = h.call("PATCH", path, body)
	receipt := decodeResponse[api.RepositoryReceipt](t, response, 200)
	if receipt.RepositoryVersion != "9007199254740994" || receipt.ProjectID != h.Project.ID || receipt.RepoURL != repo || !receipt.Changed || !receipt.BindingsInvalidated || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != h.Principal.UserID {
		t.Fatalf("receipt %+v", receipt)
	}
	h.assertCalls(map[string]int{"RepositoryPreview": 1, "SetRepository": 1})
}

func TestRepositoryRoutesRejectInvalidProtocol(t *testing.T) {
	base := `{"repoUrl":"https://github.com/x/y","expectedUserId":"10000000-0000-4000-8000-000000000001","repositoryVersion":"1","ownershipVersion":"2","classification":"same_repository","targetGitHubRepositoryId":null}`
	for _, body := range []string{
		strings.Replace(base, `"repositoryVersion":"1"`, `"repositoryVersion":1`, 1), strings.Replace(base, `"repositoryVersion":"1"`, `"repositoryVersion":"01"`, 1), strings.Replace(base, `"repositoryVersion":"1"`, `"repositoryVersion":"9223372036854775808"`, 1), strings.Replace(base, `"ownershipVersion":"2"`, `"ownershipVersion":null`, 1), strings.Replace(base, `,"targetGitHubRepositoryId":null`, ``, 1), strings.Replace(base, `"targetGitHubRepositoryId":null`, `"targetGitHubRepositoryId":"0"`, 1), strings.Replace(base, `"targetGitHubRepositoryId":null`, `"targetGitHubRepositoryId":4`, 1), strings.Replace(base, `"classification":"same_repository"`, `"classification":"\ud800"`, 1), strings.Replace(base, `"repoUrl":"https://github.com/x/y"`, `"repoUrl":null`, 1), strings.Replace(base, `"classification":"same_repository"`, `"classification":"same_repository","extra":true`, 1), strings.Replace(base, `"ownershipVersion":"2"`, `"ownershipVersion":"2","ownershipVersion":"3"`, 1), strings.TrimSuffix(base, "}") + `,"treatUnverifiedAsSwitch":null}`,
	} {
		t.Run(body, func(t *testing.T) {
			h, _ := repositoryHarness(t)
			response := h.call("PATCH", "/api/v1/projects/"+h.Project.ID+"/repository", body)
			assertProjectError(t, response, 400, "invalid_input")
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("no-store missing")
			}
			h.assertCalls(nil)
		})
	}
	for _, body := range []string{`{"repoUrl":"x"}`, `{"repoUrl":"\ud800","expectedUserId":"x"}`, `{"repoUrl":"x","expectedUserId":"x","extra":true}`} {
		h, _ := repositoryHarness(t)
		response := h.call("POST", "/api/v1/projects/"+h.Project.ID+"/repository/preview", body)
		assertProjectError(t, response, 400, "invalid_input")
		h.assertCalls(nil)
	}
	h, _ := repositoryHarness(t)
	path := "/api/v1/projects/" + h.Project.ID + "/repository"
	assertProjectError(t, h.call("PATCH", path+"?extra=1", base), 400, "invalid_input")
	response := h.call("GET", path, "")
	if response.Code != 405 || response.Header().Get("Allow") != "PATCH" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("method: %d %v", response.Code, response.Header())
	}
	response = h.call("POST", path+"/preview", `{"repoUrl":"x","expectedUserId":"x"}`, nil)
	if response.Code != 401 {
		t.Fatalf("unauthenticated: %d", response.Code)
	}
	h.assertCalls(nil)
}

func TestRepositoryRoutesErrorsAndNullTarget(t *testing.T) {
	for _, tc := range []struct {
		name    string
		failure error
		status  int
		code    string
	}{
		{"conflict", &model.Fault{Code: "version_conflict", Message: "preview again"}, 409, "version_conflict"},
		{"forbidden", &model.Fault{Code: "forbidden", Message: "forbidden"}, 403, "forbidden"},
		{"occupancy", &model.Fault{Code: "project_repository_conflict", Message: "occupied"}, 409, "project_repository_conflict"},
		{"unknown", &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("connection lost")}, 503, "write_outcome_unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, m := repositoryHarness(t)
			m.save = func(_ context.Context, _ model.Principal, _ string, input coreproject.RepositoryChange) (coreproject.RepositoryReceipt, error) {
				if input.TargetGitHubRepositoryID != nil || input.TreatUnverifiedAsSwitch {
					t.Fatal("unexpected confirmation")
				}
				return coreproject.RepositoryReceipt{}, tc.failure
			}
			body := `{"repoUrl":"x","expectedUserId":"` + h.Principal.UserID + `","repositoryVersion":"1","ownershipVersion":"2","classification":"same_repository","targetGitHubRepositoryId":null}`
			response := h.call("PATCH", "/api/v1/projects/"+h.Project.ID+"/repository", body)
			assertProjectError(t, response, tc.status, tc.code)
			if response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("no-store missing")
			}
			h.assertCalls(map[string]int{"SetRepository": 1})
		})
	}
}
