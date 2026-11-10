package task_test

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

func TestTaskProposedStore(t *testing.T) {
	suite := newTaskStoreSuite(t)
	suite.run(t, "ProposedTaskStorageKeepsExecutionEligibilityAndTimingDistinct", testProposedTaskStorageKeepsExecutionEligibilityAndTimingDistinct)
	suite.run(t, "PriorityPaginationOrdersProposedBetweenBlockedAndTerminalTasks", testPriorityPaginationOrdersProposedBetweenBlockedAndTerminalTasks)
}

func testProposedTaskStorageKeepsExecutionEligibilityAndTimingDistinct(t *testing.T, database *postgres.Store) {
	project := writerProject(t, database, 1)
	proposed := writerTask(t, database, project.ID, 10, model.TaskProposed)
	dependent := writerTask(t, database, project.ID, 11, model.TaskTodo, proposed.ID)
	if proposed.Ready || !reflect.DeepEqual(dependent.BlockedBy, []string{proposed.ID}) || dependent.Ready {
		t.Fatalf("proposed task became executable or satisfied its successor: proposed=%+v dependent=%+v", proposed, dependent)
	}
	if err := writerRead(t, database, func(reader store.TaskReader) error {
		status, ready := model.TaskProposed, true
		page, err := reader.Tasks(t.Context(), project.ID, store.TaskQuery{Page: store.Page{Limit: 10}, Status: &status})
		if err != nil || len(page.Items) != 1 || page.Items[0].ID != proposed.ID {
			t.Fatalf("proposed exact filter: %+v %v", page, err)
		}
		page, err = reader.Tasks(t.Context(), project.ID, store.TaskQuery{Page: store.Page{Limit: 10}, Ready: &ready})
		if err != nil || len(page.Items) != 0 {
			t.Fatalf("ready filter included proposed or its blocked successor: %+v %v", page, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	write := func(status model.TaskStatus) {
		t.Helper()
		before := proposed
		if err := writerWrite(t, database, project.ID, func(dao store.TaskWriteDAO) error {
			values := testutil.TaskWrite(before)
			values.Status = status
			var err error
			proposed, err = dao.UpdateTask(t.Context(), before.ID, values)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if actual := testutil.SnapshotTask(t, database, project.ID, proposed.ID); !reflect.DeepEqual(actual, proposed) || proposed.Version != before.Version+1 {
			t.Fatalf("proposed transition was not persisted once: returned=%+v actual=%+v", proposed, actual)
		}
	}
	write(model.TaskDone)
	if proposed.StartedAt != nil || proposed.CompletedAt == nil {
		t.Fatalf("direct proposed completion invented a start: %+v", proposed)
	}
	write(model.TaskProposed)
	if proposed.StartedAt != nil || proposed.CompletedAt != nil || proposed.CancelledAt != nil || proposed.Ready {
		t.Fatalf("returning to proposed retained execution timing: %+v", proposed)
	}
	write(model.TaskInProgress)
	if proposed.StartedAt == nil || proposed.CompletedAt != nil {
		t.Fatalf("direct proposed start did not start its interval: %+v", proposed)
	}
	write(model.TaskProposed)
	if proposed.StartedAt != nil || proposed.CompletedAt != nil {
		t.Fatalf("returning from execution to proposed retained timing: %+v", proposed)
	}
}

func testPriorityPaginationOrdersProposedBetweenBlockedAndTerminalTasks(t *testing.T, database *postgres.Store) {
	project := writerProject(t, database, 1)
	done := writerTask(t, database, project.ID, 10, model.TaskDone)
	proposed := writerTask(t, database, project.ID, 11, model.TaskProposed)
	blocked := writerTask(t, database, project.ID, 12, model.TaskTodo, proposed.ID)
	ready := writerTask(t, database, project.ID, 13, model.TaskTodo)
	active := writerTask(t, database, project.ID, 14, model.TaskInProgress)
	var after *store.TaskPriorityPosition
	var ids []string
	for _, group := range []int{0, 1, 2, 3, 4} {
		var page store.TaskPriorityPage
		if err := database.ReadSnapshot(t.Context(), func(snapshot store.SnapshotScope) error {
			var err error
			page, err = snapshot.TaskDAO().TaskPriorityList(t.Context(), project.ID, store.TaskPriorityQuery{Limit: 1, After: after})
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if len(page.Items) != 1 || page.HasMore != (group < 4) {
			t.Fatalf("priority group %d page: %+v", group, page)
		}
		last := page.Items[0].Task
		ids = append(ids, last.ID)
		after = &store.TaskPriorityPosition{Group: group, CreatedAt: last.CreatedAt, ID: last.ID}
	}
	if !reflect.DeepEqual(ids, []string{active.ID, ready.ID, blocked.ID, proposed.ID, done.ID}) {
		t.Fatalf("priority order skipped or repeated a group: %v", ids)
	}
}
