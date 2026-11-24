package task_test

import (
	"reflect"
	"slices"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/google/uuid"
)

func TestUnfinishedChildIDsAreVisibleDirectAndOrdered(t *testing.T) {
	f := newFixture(t)
	parent := uuid.NewString()
	_, err := f.tx.Exec(t.Context(), `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'task','parent','todo')`, parent, f.project)
	mustOK(t, err)
	expected := []string{}
	for _, status := range []model.TaskStatus{model.TaskProposed, model.TaskTodo, model.TaskInProgress, model.TaskDone, model.TaskCancelled} {
		id := uuid.NewString()
		_, err = f.tx.Exec(t.Context(), `INSERT INTO tasks(id,project_id,type,title,parent_id,status,cancelled_at) VALUES($1,$2,'task','child',$3,$4,CASE WHEN $4='cancelled' THEN now() END)`, id, f.project, parent, status)
		mustOK(t, err)
		if !status.IsTerminal() {
			expected = append(expected, id)
		}
	}
	hidden := uuid.NewString()
	_, err = f.tx.Exec(t.Context(), `INSERT INTO tasks(id,project_id,type,title,parent_id,status,ancestor_deleted_at) VALUES($1,$2,'task','hidden',$3,'todo',now())`, hidden, f.project, parent)
	mustOK(t, err)
	grandchild := uuid.NewString()
	_, err = f.tx.Exec(t.Context(), `INSERT INTO tasks(id,project_id,type,title,parent_id,status) VALUES($1,$2,'task','grandchild',$3,'todo')`, grandchild, f.project, expected[0])
	mustOK(t, err)
	slices.Sort(expected)
	got, err := task.NewWriter(f.tx, f.project).UnfinishedChildIDs(t.Context(), parent)
	if err != nil || !reflect.DeepEqual(got, expected) {
		t.Fatalf("unfinished children=%v want=%v err=%v", got, expected, err)
	}
}
