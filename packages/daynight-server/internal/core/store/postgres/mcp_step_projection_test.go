package postgres

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestMCPBoundedStepProjectionRetainsInvalidTitleWithOversizedText(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	mustQueryExec(t, database, `INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at)
 VALUES($1,'00000000',0,$2,repeat('x',4194304),'todo',clock_timestamp(),clock_timestamp())`, task.ID, "\u0085")
	read := func(invalid bool) {
		t.Helper()
		if err := database.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
			summary, err := snapshot.TaskDAO().TaskStepSummary(t.Context(), task.ID, "00000000")
			if err != nil {
				return err
			}
			if summary.Step.ID != "00000000" || summary.Step.Position != 0 {
				t.Fatal("bounded Step summary lost its identity or position")
			}
			page, err := snapshot.TaskDAO().TaskStepPage(t.Context(), task.ID, summary.Step.Position-1, 1, false)
			if err != nil {
				return err
			}
			if len(page) != 1 || page[0].Step.ID != "00000000" || !page[0].Oversized || page[0].InvalidTitle != invalid || page[0].Step.Title != "" || page[0].Step.Description != "" {
				t.Fatalf("bounded Step withheld the invalid-title fact with its oversized text: %+v", page)
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	read(true)
	mustQueryExec(t, database, `UPDATE task_steps SET title='valid' WHERE task_id=$1`, task.ID)
	read(false)
}
