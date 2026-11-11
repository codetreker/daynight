package task_test

import (
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/google/uuid"
)

func TestGoalProgressBatchAndBodies(t *testing.T) {
	f := newFixture(t)
	goal, empty, hidden := uuid.NewString(), uuid.NewString(), uuid.NewString()
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()}
	_, err := f.tx.Exec(t.Context(), `INSERT INTO tasks(id,project_id,title,type,deleted_at) VALUES
      ($1,$4,'first','goal',NULL),($2,$4,'empty','goal',NULL),($3,$4,'hidden','goal',now())`, goal, empty, hidden, f.project)
	mustOK(t, err)
	_, err = f.tx.Exec(t.Context(), `INSERT INTO tasks(id,project_id,title,type,parent_id,status,cancelled_at,deleted_at) VALUES
     ($1,$8,'done','task',$6,'done',NULL,NULL),($2,$8,'cancelled','task',$6,'cancelled',now(),NULL),
     ($3,$8,'todo','task',$6,'todo',NULL,NULL),($4,$8,'deleted','task',$6,'done',NULL,now()),
     ($5,$8,'hidden child','task',$7,'done',NULL,NULL)`, ids[0], ids[1], ids[2], ids[3], ids[4], goal, hidden, f.project)
	mustOK(t, err)
	reader := task.NewReader(f.tx)
	got, err := reader.GoalProgresses(t.Context(), f.project, []string{goal, empty, hidden})
	mustOK(t, err)
	want := map[string]model.GoalProgress{goal: {Total: 3, Done: 1, Cancelled: 1, Unfinished: 1}, empty: {}, hidden: {}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("progress=%#v want %#v", got, want)
	}
	bodies, err := reader.TaskBodies(t.Context(), f.project, []string{ids[0], ids[2], ids[4]})
	mustOK(t, err)
	if len(bodies) != 2 {
		t.Fatalf("visible bodies: %#v", bodies)
	}
	found := map[string]bool{}
	for _, body := range bodies {
		found[body.ID] = true
	}
	if !found[ids[0]] || !found[ids[2]] || found[ids[4]] {
		t.Fatalf("visible body ids: %#v", found)
	}
}
