package task_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskHTTPDescriptionPreservesRawMarkdownAcrossUpdates(t *testing.T) {
	text := "  # 原始 Markdown 😀\r\n\r\n[方案](plans/设计.md?raw=1#section)\r\n<script>window.example = '<&>'</script>\r\n`代码` \u2028\r\n"
	for _, description := range []string{text, strings.Replace(text, "原始", "完整", 1)} {
		t.Run(description, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			result := testTask("Raw description")
			result.Description, result.Version = description, 2
			h.Tasks.UpdateFunc = func(ctx context.Context, principal model.Principal, projectID, id string, input taskcore.UpdateTask) (model.Task, error) {
				if ctx.Err() != nil || principal != h.principal || projectID != testProjectID || id != testTaskID || input.Version != 1 || input.Description == nil || *input.Description != description || input.Title != nil || input.Properties != nil || input.DependsOn != nil {
					t.Fatalf("Markdown input changed bytes or fields: %+v", input)
				}
				return result, nil
			}
			h.Tasks.ObserveFunc = func(context.Context, model.Principal, string, string) (taskservice.TaskObservation, error) {
				return taskservice.TaskObservation{Task: result, Epoch: testEpoch}, nil
			}
			path := taskCollection(testProjectID) + "/" + testTaskID
			actual := decodeResponse[api.Task](t, projectRequest(h, http.MethodPatch, path, jsonBody(t, map[string]any{"version": 1, "description": description})), http.StatusOK)
			if actual.Description != description || actual.Version != result.Version || actual.Title != result.Title {
				t.Fatalf("Markdown response changed bytes or fields: %+v", actual)
			}
			read := decodeResponse[api.Task](t, projectRequest(h, http.MethodGet, path, ""), http.StatusOK)
			if read.Description != description || read.Version != result.Version || read.ID != result.ID {
				t.Fatalf("Markdown read encoding changed: %+v", read)
			}
		})
	}
}
