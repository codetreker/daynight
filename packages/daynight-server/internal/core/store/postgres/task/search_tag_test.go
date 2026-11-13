package task_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
)

func TestSearchTagPredicatesAndPagination(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	a, b, c, goal := readerID(101), readerID(102), readerID(103), readerID(104)
	bug, backend := readerID(201), readerID(202)
	_, err := f.tx.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title,description,status,parent_id,assigned_to,updated_at) VALUES
	($1,$5,'task','alpha one','red','todo',$4,$6,'2020-01-03'),
	($2,$5,'task','alpha two','blue','todo',NULL,NULL,'2020-01-02'),
	($3,$5,'task','alpha three','red','todo',NULL,NULL,'2020-01-01'),
	($4,$5,'goal','alpha goal','','todo',NULL,NULL,'2020-01-04')`, a, b, c, goal, f.project, f.user)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES
	($1,$3,'bugonly','bugonly',now(),now()),($2,$3,'backend','backend',now(),now())`, bug, backend, f.project)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `INSERT INTO task_tags(project_id,task_id,tag_id) VALUES($1,$2,$5),($1,$2,$6),($1,$3,$5),($1,$4,$6)`, f.project, a, b, goal, bug, backend)
	mustOK(t, err)
	snapshot := task.NewSearchSnapshot(f.tx)
	all := store.TagFilter{TagIDs: []string{bug, backend}, TagMatch: "all"}
	any := store.TagFilter{TagIDs: []string{bug, backend}, TagMatch: "any"}
	red := atom(tasksearch.DescriptionField, "red")
	alpha := atom(tasksearch.AnyField, "alpha")
	for _, tc := range []struct {
		name  string
		query store.TaskSearchQuery
		want  []string
	}{
		{"all", store.TaskSearchQuery{Expression: alpha, TagFilter: all}, []string{a}},
		{"any", store.TaskSearchQuery{Expression: alpha, TagFilter: any}, []string{a, b}},
		{"untagged", store.TaskSearchQuery{Expression: alpha, TagFilter: store.TagFilter{Untagged: true}}, []string{c}},
		{"goal own tags", store.TaskSearchQuery{Expression: alpha, TagFilter: any, Type: model.TaskTypeGoal}, []string{goal}},
		{"parent and assignee", store.TaskSearchQuery{Expression: alpha, TagFilter: any, Parent: &goal, AssignedTo: model.TaskAssignmentFilter{Mode: model.TaskAssignmentUser, UserID: f.user}}, []string{a}},
		{"and", store.TaskSearchQuery{Expression: &tasksearch.Node{Kind: tasksearch.And, Left: alpha, Right: red}, TagFilter: any}, []string{a}},
		{"or cannot bypass", store.TaskSearchQuery{Expression: &tasksearch.Node{Kind: tasksearch.Or, Left: alpha, Right: red}, TagFilter: any}, []string{a, b}},
		{"not cannot bypass", store.TaskSearchQuery{Expression: &tasksearch.Node{Kind: tasksearch.And, Left: alpha, Right: &tasksearch.Node{Kind: tasksearch.Leaf, Atom: tasksearch.Atom{Field: tasksearch.AnyField, Term: "blue"}, Negated: true}}, TagFilter: any}, []string{a}},
		{"tag name is not text", store.TaskSearchQuery{Expression: atom(tasksearch.AnyField, "bugonly"), TagFilter: any}, []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			query := tc.query
			query.Limit = 1
			got := []string{}
			for {
				page, err := snapshot.Matches(ctx, f.project, query)
				mustOK(t, err)
				if page.Total != int64(len(tc.want)) {
					t.Fatalf("total %d want %d", page.Total, len(tc.want))
				}
				for _, item := range page.Items {
					got = append(got, item.ID)
					if item.ID == a && len(item.Tags) != 2 {
						t.Fatalf("missing batch tag projection: %+v", item.Tags)
					}
					query.After = &store.TaskSearchPosition{ID: item.ID, UpdatedAt: item.UpdatedAt, ExactIDPriority: item.ExactIDPriority, TitlePriority: item.TitlePriority}
				}
				if !page.HasMore {
					break
				}
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
	for _, invalid := range []store.TagFilter{{TagIDs: []string{bug}, Untagged: true}, {TagIDs: []string{backend, bug}}, {TagMatch: "bad"}} {
		if _, err := snapshot.Matches(ctx, f.project, store.TaskSearchQuery{Expression: alpha, TagFilter: invalid, Limit: 1}); err == nil {
			t.Fatalf("accepted invalid filter: %+v", invalid)
		}
	}
}

func TestSearchTagQualificationSharesSnapshotAndFence(t *testing.T) {
	db := readerStore(t)
	ctx := t.Context()
	project := readerProject(t, db, 1)
	item := readerTask(t, db, project.ID, 11, model.TaskTodo)
	tagID := readerID(21)
	readerExec(t, db, `UPDATE tasks SET title='alpha' WHERE id=$1`, item.ID)
	readerExec(t, db, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES($1,$2,'Tag','tag',now(),now())`, tagID, project.ID)
	readerExec(t, db, `INSERT INTO task_tags(project_id,task_id,tag_id) VALUES($1,$2,$3)`, project.ID, item.ID, tagID)
	initial := readerSearchFence(t, db, project.ID)
	completion, err := db.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
		if _, err := scope.TaskTagDAO().TouchTaggedTasks(ctx, tagID, time.Now()); err != nil {
			return err
		}
		_, err := scope.TagDAO().UpdateTag(ctx, tagID, 1, "Renamed", "renamed", time.Now())
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("rename: %+v %v", completion, err)
	}
	if after := readerSearchFence(t, db, project.ID); after == initial {
		t.Fatalf("rename did not change fence: %+v", after)
	}
	var before store.TaskSearchFence
	err = postgres.NewTaskSearch(db.Pool).ReadTaskSearch(ctx, func(snapshot store.TaskSearchSnapshot) error {
		tags, err := snapshot.ResolveTags(ctx, project.ID, []string{tagID})
		if err != nil {
			return err
		}
		if len(tags) != 1 {
			t.Fatalf("initial tags: %+v", tags)
		}
		before, err = snapshot.Fence(ctx, project.ID)
		if err != nil {
			return err
		}
		completion, err := db.WriteProject(ctx, project.ID, func(scope store.ProjectWriteScope) error {
			if _, err := scope.TaskTagDAO().TouchTaggedTasks(ctx, tagID, time.Now()); err != nil {
				return err
			}
			if err := scope.TaskTagDAO().ClearTagAssociations(ctx, tagID); err != nil {
				return err
			}
			return scope.TagDAO().DeleteTag(ctx, tagID, tags[0].Version)
		})
		if err != nil || completion.Outcome != store.TransactionCommitted {
			t.Fatalf("delete: %+v %v", completion, err)
		}
		page, err := snapshot.Matches(ctx, project.ID, store.TaskSearchQuery{Expression: atom(tasksearch.AnyField, "alpha"), TagFilter: store.TagFilter{TagIDs: []string{tagID}, TagMatch: "all"}, Limit: 1})
		if err != nil {
			return err
		}
		if len(page.Items) != 1 || page.Items[0].ID != item.ID || len(page.Items[0].Tags) != 1 {
			t.Fatalf("snapshot selection: %+v", page)
		}
		after, err := snapshot.Fence(ctx, project.ID)
		if err != nil {
			return err
		}
		if after != before {
			t.Fatalf("snapshot fence changed: %+v %+v", before, after)
		}
		return nil
	})
	mustOK(t, err)
	err = postgres.NewTaskSearch(db.Pool).ReadTaskSearch(ctx, func(snapshot store.TaskSearchSnapshot) error {
		tags, err := snapshot.ResolveTags(ctx, project.ID, []string{tagID})
		if err != nil {
			return err
		}
		if len(tags) != 0 {
			t.Fatalf("deleted tag retained: %+v", tags)
		}
		after, err := snapshot.Fence(ctx, project.ID)
		if err != nil {
			return err
		}
		if after == before {
			t.Fatalf("delete did not change fence: %+v", after)
		}
		return nil
	})
	mustOK(t, err)
}

func TestSearchTagQueryCancellation(t *testing.T) {
	db := readerStore(t)
	ctx, stop := context.WithTimeout(t.Context(), 10*time.Second)
	defer stop()
	blocker, err := db.Pool.Begin(ctx)
	mustOK(t, err)
	defer blocker.Rollback(context.Background())
	_, err = blocker.Exec(ctx, `LOCK TABLE task_tags IN ACCESS EXCLUSIVE MODE`)
	mustOK(t, err)
	readCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		done <- postgres.NewTaskSearch(db.Pool).ReadTaskSearch(readCtx, func(snapshot store.TaskSearchSnapshot) error {
			_, err := snapshot.Matches(readCtx, readerID(1), store.TaskSearchQuery{Expression: atom(tasksearch.AnyField, "alpha"), TagFilter: store.TagFilter{Untagged: true}, Limit: 1})
			return err
		})
	}()
	observed := false
	for ctx.Err() == nil {
		err = db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%WITH folded AS MATERIALIZED%')`).Scan(&observed)
		mustOK(t, err)
		if observed {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !observed {
		t.Fatal("search did not reach locked tag table")
	}
	cancel()
	select {
	case err = <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancel: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("cancelled search did not exit")
	}
	mustOK(t, blocker.Rollback(ctx))
	for db.Pool.Stat().AcquiredConns() != 0 && ctx.Err() == nil {
		time.Sleep(10 * time.Millisecond)
	}
	if got := db.Pool.Stat().AcquiredConns(); got != 0 {
		t.Fatalf("retained %d connections", got)
	}
}
