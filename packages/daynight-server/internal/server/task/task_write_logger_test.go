package task

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTaskWriteLoggerRecordsParentTransition(t *testing.T) {
	old, next := "old-parent", "new-parent"
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	taskWriteLogger(logger, task.TaskWriteMetadata{Type: model.TaskTypeTask, ParentID: &next, OldParentID: &old, NewParentID: &next, ParentChanged: true}).Info("task update")
	var entry map[string]any
	if err := json.Unmarshal(output.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if entry["resource_type"] != "task" || entry["parent_id"] != next || entry["old_parent_id"] != old || entry["new_parent_id"] != next {
		t.Fatalf("transition log: %s", output.String())
	}
}
