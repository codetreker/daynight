package postgres

import (
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTaskDescriptionUpdatesPersistRawMarkdownAndUnrelatedFacts(t *testing.T) {
	database := isolatedStore(t)
	ctx := t.Context()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 11, model.TaskTodo)
	text := "  # 原始 Markdown 😀\r\n\r\n[方案](plans/设计.md?raw=1#section)\r\n<script>window.example = '<&>'</script>\r\n`代码` \u2028\r\n"
	for _, description := range []string{text, strings.Replace(text, "原始", "完整", 1)} {
		before := task
		values := taskMutationValues(before)
		values.Description = description
		completion, err := database.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
			var err error
			task, err = scope.TaskDAO().UpdateTask(ctx, before.ID, values)
			return err
		})
		if err != nil || completion.Outcome != store.TransactionCommitted || task.Description != description ||
			task.Version != before.Version+1 || !task.UpdatedAt.After(before.UpdatedAt) {
			t.Fatalf("raw description write changed bytes or revision: %#v %#v %v", task, completion, err)
		}
		comparable := task
		comparable.Description, comparable.Version, comparable.UpdatedAt = before.Description, before.Version, before.UpdatedAt
		if !reflect.DeepEqual(comparable, before) {
			t.Fatalf("description update changed unrelated persisted facts: %#v %#v", before, task)
		}
		if stored := snapshotTask(t, database, project.ID, task.ID); stored.Description != description || !reflect.DeepEqual(stored, task) {
			t.Fatalf("description readback changed raw Markdown or metadata: %#v %#v", task, stored)
		}
	}
}
