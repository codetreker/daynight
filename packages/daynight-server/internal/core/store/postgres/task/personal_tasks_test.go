package task_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestPersonalTaskInventory(t *testing.T) {
	db := readerStore(t)
	a := readerProject(t, db, 1)
	b := readerProject(t, db, 2)
	c := readerProject(t, db, 3)
	hidden := readerProject(t, db, 4)
	actor := readerAssigneeUser(t, db, a.ID, 5, true)
	team := readerID(6)
	readerExec(t, db, `INSERT INTO teams(id,name) VALUES($1,'Team')`, team)
	readerExec(t, db, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team, actor)
	readerExec(t, db, `UPDATE project_ownership SET team_id=$1 WHERE project_id=$2`, team, b.ID)
	readerExec(t, db, `UPDATE project_ownership SET team_id=$1 WHERE project_id=$2`, team, c.ID)
	readerExec(t, db, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, b.ID, actor)
	readerExec(t, db, `UPDATE projects SET name=CASE WHEN id=$1 THEN 'A' ELSE 'B' END WHERE id=ANY($2::uuid[])`, a.ID, []string{a.ID, b.ID, c.ID})
	first := readerTask(t, db, a.ID, 10, model.TaskInProgress)
	second := readerTask(t, db, a.ID, 11, model.TaskInProgress)
	nullTime := readerTask(t, db, a.ID, 12, model.TaskInProgress)
	other := readerTask(t, db, b.ID, 13, model.TaskInProgress)
	teamOnly := readerTask(t, db, c.ID, 20, model.TaskInProgress)
	invisible := readerTask(t, db, hidden.ID, 14, model.TaskInProgress)
	notStarted := readerTask(t, db, a.ID, 15, model.TaskTodo)
	goal := readerTask(t, db, a.ID, 16, model.TaskTodo)
	child := readerTask(t, db, a.ID, 17, model.TaskInProgress)
	deletedGoal := readerTask(t, db, a.ID, 18, model.TaskTodo)
	hiddenChild := readerTask(t, db, a.ID, 19, model.TaskInProgress)
	readerExec(t, db, `UPDATE tasks SET type='goal' WHERE id=ANY($1::uuid[])`, []string{goal.ID, deletedGoal.ID})
	readerExec(t, db, `UPDATE tasks SET parent_id=$1 WHERE id=$2`, goal.ID, child.ID)
	readerExec(t, db, `UPDATE tasks SET parent_id=$1 WHERE id=$2`, deletedGoal.ID, hiddenChild.ID)
	readerExec(t, db, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, deletedGoal.ID)
	ids := []string{first.ID, second.ID, nullTime.ID, other.ID, teamOnly.ID, invisible.ID, notStarted.ID, child.ID, hiddenChild.ID}
	readerExec(t, db, `UPDATE tasks SET assigned_to=$1 WHERE id=ANY($2::uuid[])`, actor, ids)
	when := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	readerExec(t, db, `UPDATE tasks SET started_at=$1,version=9223372036854775807 WHERE id=ANY($2::uuid[])`, when, []string{first.ID, second.ID})
	readerExec(t, db, `UPDATE tasks SET started_at=NULL WHERE id=ANY($1::uuid[])`, []string{nullTime.ID, child.ID})
	readerPutProperty(t, db, first.ID, "paused", []byte(`true`))
	if err := db.ReadSnapshot(t.Context(), func(scope store.SnapshotScope) error {
		dao := scope.TaskDAO().(store.PersonalTaskReader)
		facts, err := dao.PersonalTaskFacts(t.Context(), actor)
		if err != nil {
			return err
		}
		if len(facts) != 3 || facts[0].MatchedCount != "4" || facts[1].MatchedCount != "1" || facts[2].MatchedCount != "1" || facts[0].AllTaskVersionSum != "18446744073709551620" {
			t.Fatalf("facts: %+v", facts)
		}
		readerExec(t, db, `UPDATE tasks SET title='Changed goal',version=version+1 WHERE id=$1`, goal.ID)
		again, err := dao.PersonalTaskFacts(t.Context(), actor)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(facts, again) {
			t.Fatalf("snapshot changed: %v / %v", facts, again)
		}
		var all []store.PersonalTaskRow
		var after *store.PersonalTaskPosition
		for {
			page, err := dao.PersonalTaskPage(t.Context(), actor, store.PersonalTaskQuery{Limit: 1, After: after})
			if err != nil {
				return err
			}
			all = append(all, page.Items...)
			if !page.HasMore {
				break
			}
			after = &page.Items[len(page.Items)-1].Position
		}
		got := []string{}
		for _, row := range all {
			got = append(got, row.ID)
		}
		if !reflect.DeepEqual(got, []string{first.ID, second.ID, nullTime.ID, child.ID, other.ID, teamOnly.ID}) {
			t.Fatalf("order: %v", got)
		}
		if all[0].PausedRaw == nil || *all[0].PausedRaw != "true" || all[3].GoalID == nil || *all[3].GoalID != goal.ID || all[3].GoalTitle == nil || *all[3].GoalTitle != "Task" {
			t.Fatalf("projection: %+v", all)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := db.ReadSnapshot(t.Context(), func(scope store.SnapshotScope) error {
		facts, err := scope.TaskDAO().(store.PersonalTaskReader).PersonalTaskFacts(t.Context(), actor)
		if err != nil {
			return err
		}
		if facts[0].AllTaskVersionSum != "18446744073709551621" {
			t.Fatalf("fresh snapshot missed update: %+v", facts)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var indexExists bool
	if err := db.Pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname='tasks_personal_in_progress')`).Scan(&indexExists); err != nil || !indexExists {
		t.Fatalf("index: %v %v", indexExists, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := db.ReadSnapshot(ctx, func(scope store.SnapshotScope) error { return nil }); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
}

func TestPersonalTaskInventoryCancellation(t *testing.T) {
	db := readerStore(t)
	ctx, stop := context.WithTimeout(t.Context(), 10*time.Second)
	defer stop()
	blocker, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err = blocker.Exec(ctx, `LOCK TABLE tasks IN ACCESS EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	readCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- db.ReadSnapshot(readCtx, func(scope store.SnapshotScope) error {
			_, err := scope.TaskDAO().(store.PersonalTaskReader).PersonalTaskFacts(readCtx, readerID(1))
			return err
		})
	}()
	observed := false
	for ctx.Err() == nil {
		if err = db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%WITH matched AS MATERIALIZED%')`).Scan(&observed); err != nil {
			t.Fatal(err)
		}
		if observed {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !observed {
		t.Fatal("personal query never reached lock")
	}
	cancel()
	select {
	case err = <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("cancelled query did not exit")
	}
	if err = blocker.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	for db.Pool.Stat().AcquiredConns() != 0 && ctx.Err() == nil {
		time.Sleep(10 * time.Millisecond)
	}
	if got := db.Pool.Stat().AcquiredConns(); got != 0 {
		t.Fatalf("retained %d connections", got)
	}
}
