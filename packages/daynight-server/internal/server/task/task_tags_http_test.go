package task_test

import (
	"context"
	"io"
	"net/http"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

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
