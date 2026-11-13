package task_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestTaskTagCreateInputAndReceipt(t *testing.T) {
	const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	for _, tc := range []struct {
		name, body string
		input      *[]string
		refs       []model.TagReference
	}{
		{"omitted", `{"title":"Tagged"}`, nil, nil},
		{"empty", `{"title":"Tagged","tagIds":[]}`, &[]string{}, nil},
		{"set", `{"title":"Tagged","tagIds":["` + strings.ToUpper(b) + `","` + a + `","` + b + `"]}`, &[]string{strings.ToUpper(b), a, b}, []model.TagReference{{ID: a, Name: "Alpha"}, {ID: b, Name: "Beta &"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			result := testTask("Tagged")
			result.Tags = tc.refs
			h.Tasks.CreateFunc = func(ctx context.Context, principal model.Principal, project string, input taskcore.CreateTask) (model.Task, error) {
				if ctx.Err() != nil || principal != h.principal || project != testProjectID || input.Title != "Tagged" || !reflect.DeepEqual(input.TagIDs, tc.input) {
					t.Fatalf("create scope or input: %+v %+v %s %v", input, principal, project, ctx.Err())
				}
				return result, nil
			}
			response := projectRequest(h, http.MethodPost, taskCollection(testProjectID), tc.body)
			got := decodeResponse[api.Task](t, response, http.StatusCreated)
			if got.ID != result.ID || got.ProjectID != result.ProjectID || got.Type != result.Type || got.Status != string(result.Status) || got.Version != result.Version || !reflect.DeepEqual(got.Tags, tagHTTPReferences(result.Tags)) || got.Tags == nil || response.Header().Get("Location") != taskCollection(testProjectID)+"/"+result.ID {
				t.Fatalf("create receipt: %+v headers=%v", got, response.Header())
			}
		})
	}
}

func TestTaskTagCreateMapsServiceRefusals(t *testing.T) {
	for _, tc := range []struct {
		code   string
		status int
	}{{"invalid_input", http.StatusBadRequest}, {"forbidden", http.StatusForbidden}, {"tag_not_found", http.StatusNotFound}, {"resource_limit_exceeded", http.StatusConflict}} {
		t.Run(tc.code, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Tasks.CreateFunc = func(_ context.Context, _ model.Principal, _ string, input taskcore.CreateTask) (model.Task, error) {
				if input.TagIDs == nil || len(*input.TagIDs) != 1 {
					t.Fatalf("missing tag input: %+v", input)
				}
				return model.Task{}, &model.Fault{Code: tc.code, Message: "Create refused."}
			}
			response := projectRequest(h, http.MethodPost, taskCollection(testProjectID), `{"title":"Tagged","tagIds":["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]}`)
			assertProjectError(t, response, tc.status, tc.code)
		})
	}
}

func TestTaskTagCreateCancellationReachesService(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	started, finished := make(chan struct{}), make(chan struct{})
	h.Tasks.CreateFunc = func(ctx context.Context, _ model.Principal, _ string, input taskcore.CreateTask) (model.Task, error) {
		if input.TagIDs == nil || !reflect.DeepEqual(*input.TagIDs, []string{"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}) {
			t.Errorf("create tags: %+v", input.TagIDs)
		}
		close(started)
		<-ctx.Done()
		return model.Task{}, ctx.Err()
	}
	request := httptest.NewRequest(http.MethodPost, taskCollection(testProjectID), strings.NewReader(`{"title":"Tagged","tagIds":["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]}`)).WithContext(ctx)
	authorizeResourceRequest(h, request)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	go func() { defer close(finished); h.ServeHTTP(response, request) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Error("cancelled create did not drain")
		}
	})
	await(t, started)
	cancel()
	await(t, finished)
	if response.Body.Len() != 0 || response.Header().Get("Content-Type") != "" || h.Tasks.Calls("Create") != 1 {
		t.Fatalf("cancelled create published success: %d %s", response.Code, response.Body.String())
	}
}

func TestTaskTagPatchDispatchAndReceipt(t *testing.T) {
	const tagID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	for _, tc := range []struct {
		name, body string
		tags       []string
		mixed      bool
	}{
		{"replace", `{"version":7,"tagIds":["` + tagID + `"]}`, []string{tagID}, false},
		{"clear", `{"version":7,"tagIds":[]}`, []string{}, false},
		{"mixed", `{"version":7,"tagIds":["` + tagID + `"],"title":"Changed"}`, []string{tagID}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			result := testTask("Changed")
			result.Version = 8
			for _, id := range tc.tags {
				result.Tags = append(result.Tags, model.TagReference{ID: id, Name: "标签 &"})
			}
			check := func(ctx context.Context, principal model.Principal, project, id string, version int64, tags *[]string) {
				t.Helper()
				if ctx.Err() != nil || principal != h.principal || project != testProjectID || id != testTaskID || version != 7 || tags == nil || !reflect.DeepEqual(*tags, tc.tags) {
					t.Fatalf("tag request scope or values: %v %+v %s %s %d %v", ctx.Err(), principal, project, id, version, tags)
				}
			}
			if tc.mixed {
				h.Tasks.UpdateFunc = func(ctx context.Context, p model.Principal, project, id string, input taskcore.UpdateTask) (model.Task, error) {
					check(ctx, p, project, id, input.Version, input.TagIDs)
					if input.Title == nil || *input.Title != "Changed" {
						t.Fatalf("mixed fields: %+v", input)
					}
					return result, nil
				}
			} else {
				h.Tasks.ReplaceTagsFunc = func(ctx context.Context, p model.Principal, project, id string, version int64, tags *[]string) (model.Task, error) {
					check(ctx, p, project, id, version, tags)
					return result, nil
				}
			}
			response := projectRequest(h, http.MethodPatch, taskCollection(testProjectID)+"/"+testTaskID, tc.body)
			got := decodeResponse[api.Task](t, response, http.StatusOK)
			if got.Version != result.Version || !reflect.DeepEqual(got.Tags, tagHTTPReferences(result.Tags)) {
				t.Fatalf("tag receipt: %+v", got)
			}
		})
	}
}

func TestTaskTagPatchMapsServiceRefusals(t *testing.T) {
	for _, tc := range []struct {
		code   string
		status int
	}{{"tag_not_found", http.StatusNotFound}, {"version_conflict", http.StatusConflict}, {"resource_limit_exceeded", http.StatusConflict}} {
		t.Run(tc.code, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Tasks.ReplaceTagsFunc = func(context.Context, model.Principal, string, string, int64, *[]string) (model.Task, error) {
				return model.Task{}, &model.Fault{Code: tc.code, Message: "Tag write refused."}
			}
			response := projectRequest(h, http.MethodPatch, taskCollection(testProjectID)+"/"+testTaskID, `{"version":1,"tagIds":[]}`)
			assertProjectError(t, response, tc.status, tc.code)
		})
	}
}

func TestTaskTagPatchWithExplicitEmptyPropertiesUsesMetadataPath(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	h.Tasks.UpdateFunc = func(_ context.Context, _ model.Principal, _, _ string, input taskcore.UpdateTask) (model.Task, error) {
		if input.TagIDs == nil || len(*input.TagIDs) != 0 || input.Properties == nil || len(input.Properties) != 0 {
			t.Fatalf("mixed input: %+v", input)
		}
		return model.Task{}, &model.Fault{Code: "invalid_input", Message: "No metadata field provided."}
	}
	response := projectRequest(h, http.MethodPatch, taskCollection(testProjectID)+"/"+testTaskID, `{"version":1,"tagIds":[],"properties":{}}`)
	assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
}
