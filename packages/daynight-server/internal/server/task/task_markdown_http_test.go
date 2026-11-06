package task_test

import (
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTaskHTTPDescriptionPreservesRawMarkdownAcrossUpdates(t *testing.T) {
	handler := projectTestHandler(t, projectTestStore(t), io.Discard)
	task := createHTTPTask(t, handler, taskProject(t, handler).ID, "Raw description")
	original := task
	text := "  # 原始 Markdown 😀\r\n\r\n[方案](plans/设计.md?raw=1#section)\r\n<script>window.example = '<&>'</script>\r\n`代码` \u2028\r\n"
	for _, description := range []string{text, strings.Replace(text, "原始", "完整", 1)} {
		before := task
		response := projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": before.Version, "description": description}))
		task = decodeResponse[api.Task](t, response, http.StatusOK)
		preserved := task
		preserved.Description, preserved.Version, preserved.UpdatedAt = before.Description, before.Version, before.UpdatedAt
		if task.Description != description || task.Version != before.Version+1 || !task.UpdatedAt.After(before.UpdatedAt) || !reflect.DeepEqual(preserved, before) {
			t.Fatalf("description update changed bytes or unrelated task fields: %+v", task)
		}
		if got := readHTTPTask(t, handler, task); !reflect.DeepEqual(got, task) || got.Description != description {
			t.Fatal("description readback changed raw Markdown")
		}
	}
	stale := projectRequest(handler, http.MethodPatch, taskPath(task), jsonBody(t, map[string]any{"version": original.Version, "description": "stale replacement"}))
	assertProjectError(t, stale, http.StatusConflict, "version_conflict")
	if got := readHTTPTask(t, handler, task); !reflect.DeepEqual(got, task) {
		t.Fatal("stale description update changed the task")
	}
}
