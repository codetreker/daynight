package project

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
)

func TestProjectHTTPContinuationRecoversAfterBusinessFailure(t *testing.T) {
	h := newHTTPHarness(t)
	cursor := "opaque+continuation/cursor="
	next := h.Project
	next.ID = "33333333-3333-4333-8333-333333333333"
	next.Name = "Second"
	h.Projects.ListScopedFunc = func(ctx context.Context, p model.Principal, in coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
		assertProjectInvocation(t, h, ctx, p)
		if !reflect.DeepEqual(in, coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 1}}) {
			t.Fatalf("first request %+v", in)
		}
		return coreproject.ProjectPage{Items: []model.Project{h.Project}, NextCursor: &cursor}, nil
	}
	first := decodeResponse[api.ProjectPage](t, h.call(http.MethodGet, "/api/v1/projects?limit=1", "", h.Cookie), 200)
	if len(first.Items) != 1 || first.Items[0] != ProjectResponse(h.Project) || first.NextCursor == nil || *first.NextCursor != cursor {
		t.Fatalf("first page %+v", first)
	}
	continuation := "/api/v1/projects?limit=1&cursor=" + url.QueryEscape(*first.NextCursor)
	responsePage := coreproject.ProjectPage{Items: []model.Project{next}}
	continuationCall := func(ctx context.Context, p model.Principal, in coreproject.ProjectListRequest) {
		assertProjectInvocation(t, h, ctx, p)
		if !reflect.DeepEqual(in, coreproject.ProjectListRequest{Page: model.PageRequest{Limit: 1, Cursor: &cursor}}) {
			t.Fatalf("continuation request %+v", in)
		}
	}
	h.Projects.ListScopedFunc = func(ctx context.Context, p model.Principal, in coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
		continuationCall(ctx, p, in)
		return responsePage, nil
	}
	baseline := decodeResponse[api.ProjectPage](t, h.call("GET", continuation, "", h.Cookie), 200)
	if len(baseline.Items) != 1 || baseline.Items[0] != ProjectResponse(next) || baseline.Items[0].ID == first.Items[0].ID {
		t.Fatalf("continuation baseline %+v", baseline)
	}
	h.Projects.ListScopedFunc = func(ctx context.Context, p model.Principal, in coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
		continuationCall(ctx, p, in)
		return coreproject.ProjectPage{}, errors.New("private_missing_projects")
	}
	response := h.call("GET", continuation, "", h.Cookie)
	failure := decodeResponse[api.ErrorResponse](t, response, 500)
	if failure.Error.Code != "internal_error" || failure.Error.RequestID == "" || failure.Error.RequestID != response.Header().Get("X-Request-ID") || strings.Contains(response.Body.String(), "private_missing_projects") || strings.Contains(response.Body.String(), "projects") {
		t.Fatalf("unsafe or uncorrelated continuation failure: %s", response.Body)
	}
	if strings.Contains(h.Logs.String(), "private_missing_projects") {
		t.Fatal("database failure leaked in logs")
	}
	h.Projects.ListScopedFunc = func(ctx context.Context, p model.Principal, in coreproject.ProjectListRequest) (coreproject.ProjectPage, error) {
		continuationCall(ctx, p, in)
		return responsePage, nil
	}
	recovered := decodeResponse[api.ProjectPage](t, h.call("GET", continuation, "", h.Cookie), 200)
	if !reflect.DeepEqual(recovered, baseline) {
		t.Fatalf("same cursor returned different page after recovery: %+v", recovered)
	}
	h.assertCalls(map[string]int{"ListScoped": 4})
}
