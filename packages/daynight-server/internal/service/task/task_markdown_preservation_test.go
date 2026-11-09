package task_test

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestTaskDescriptionUpdatePassesRawMarkdownToDAO(t *testing.T) {
	f := newTaskRuleFixture(t)
	ctx := t.Context()
	current := f.target
	f.write(ctx, store.Completion{Outcome: store.TransactionCommitted})
	f.dependencies(ctx, []string{}, []model.Task{})
	text := "  # 原始 Markdown 😀\r\n\r\n[方案](plans/设计.md?raw=1#section)\r\n<script>window.example = '<&>'</script>\r\n`代码` \u2028\r\n"
	for _, description := range []string{text, strings.Replace(text, "原始", "完整", 1)} {
		f.current(ctx, current)
		after := current
		after.Description, after.Version, after.UpdatedAt = description, current.Version+1, current.UpdatedAt.Add(time.Second)
		f.update(ctx, current.ID, taskcore.CurrentWrite(after), after)
		got, err := f.tasks.Update(ctx, f.principal, f.project.ID, current.ID, taskcore.UpdateTask{Version: current.Version, Description: &description})
		if err != nil || !reflect.DeepEqual(got, after) || got.Description != description {
			t.Fatalf("description candidate or authoritative result changed raw Markdown: %#v %#v %v", after, got, err)
		}
		current = after
	}
}
