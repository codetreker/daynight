package task_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/jackc/pgx/v5"
)

// tagQueryProbe still executes real PostgreSQL queries; it observes the selected
// identities and can reject a batch to prove incomplete results are discarded.
type tagQueryProbe struct {
	pgx.Tx
	batches [][]string
	failure error
}

func (p *tagQueryProbe) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if strings.Contains(sql, "FROM task_tags a") {
		ids := append([]string(nil), args[1].([]string)...)
		p.batches = append(p.batches, ids)
		if p.failure != nil {
			return nil, p.failure
		}
	}
	return p.Tx.Query(ctx, sql, args...)
}

func TestTaskTagSelectedProjections(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	a, b, goal, hidden, hiddenChild, foreign := readerID(101), readerID(102), readerID(103), readerID(104), readerID(105), readerID(106)
	tag1, tag2, otherTag := readerID(201), readerID(202), readerID(203)
	_, err := f.tx.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title,status,created_at,deleted_at) VALUES
		($1,$6,'task','alpha','todo','2020-01-01',NULL),($2,$6,'task','alpha','todo','2020-01-02',NULL),
		($3,$6,'goal','alpha','todo','2020-01-03',NULL),($4,$6,'goal','hidden','todo','2020-01-04',now()),
		($5,$7,'task','foreign','todo','2020-01-05',NULL)`, a, b, goal, hidden, foreign, f.project, f.other)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `INSERT INTO tasks(id,project_id,type,title,parent_id) VALUES($1,$2,'task','hidden child',$3)`, hiddenChild, f.project, hidden)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES($1,$4,'One','one',now(),now()),($2,$4,'Two','two',now(),now()),($3,$5,'Other','other',now(),now())`, tag1, tag2, otherTag, f.project, f.other)
	mustOK(t, err)
	_, err = f.tx.Exec(ctx, `INSERT INTO task_tags(project_id,task_id,tag_id) VALUES ($1,$2,$3),($1,$2,$4),($1,$5,$4),($1,$6,$3),($7,$8,$9)`, f.project, a, tag2, tag1, goal, hiddenChild, f.other, foreign, otherTag)
	mustOK(t, err)
	want := []model.TagReference{{ID: tag1, Name: "One"}, {ID: tag2, Name: "Two"}}
	goalWant := []model.TagReference{{ID: tag1, Name: "One"}}
	probe := &tagQueryProbe{Tx: f.tx}
	reader := task.NewReader(probe)
	assert := func(ids []string) {
		t.Helper()
		if len(probe.batches) != 1 || !reflect.DeepEqual(probe.batches[0], ids) {
			t.Fatalf("tag batches = %#v, want one batch for %#v", probe.batches, ids)
		}
		probe.batches = nil
	}
	page, err := reader.Tasks(ctx, f.project, store.TaskQuery{Page: store.Page{Limit: 1}})
	mustOK(t, err)
	if !page.HasMore || len(page.Items) != 1 || page.Items[0].ID != a || !reflect.DeepEqual(page.Items[0].Tags, want) {
		t.Fatalf("selected list: %#v", page)
	}
	assert([]string{a})
	bodies, err := reader.TaskBodies(ctx, f.project, []string{a, b, goal, hiddenChild, foreign})
	mustOK(t, err)
	if len(bodies) != 3 {
		t.Fatalf("body visibility: %#v", bodies)
	}
	bodyIDs := make([]string, len(bodies))
	for i, body := range bodies {
		bodyIDs[i] = body.ID
		switch body.ID {
		case a:
			if !reflect.DeepEqual(body.Tags, want) {
				t.Fatalf("body tags: %#v", body.Tags)
			}
		case b:
			if len(body.Tags) != 0 {
				t.Fatalf("empty body tags: %#v", body.Tags)
			}
		case goal:
			if !reflect.DeepEqual(body.Tags, goalWant) {
				t.Fatalf("goal tags: %#v", body.Tags)
			}
		default:
			t.Fatalf("hidden or foreign body: %s", body.ID)
		}
	}
	assert(bodyIDs)
	priority, err := reader.TaskPriorityList(ctx, f.project, store.TaskPriorityQuery{Limit: 1})
	mustOK(t, err)
	if !priority.HasMore || len(priority.Items) != 1 || priority.Items[0].Task.ID != a || !reflect.DeepEqual(priority.Items[0].Task.Tags, want) {
		t.Fatalf("priority: %#v", priority)
	}
	assert([]string{a})
	sync, err := reader.TaskSyncTasks(ctx, f.project, nil, 160)
	mustOK(t, err)
	if len(sync) != 3 || sync[0].ID != a || !reflect.DeepEqual(sync[0].Tags, want) || len(sync[1].Tags) != 0 || !reflect.DeepEqual(sync[2].Tags, goalWant) {
		t.Fatalf("sync: %#v", sync)
	}
	assert([]string{a, b, goal})
	search, err := task.NewSearchSnapshot(probe).Matches(ctx, f.project, store.TaskSearchQuery{Expression: &tasksearch.Node{Kind: tasksearch.Leaf, Atom: tasksearch.Atom{Field: tasksearch.TitleField, Term: "alpha"}}, Limit: 1})
	mustOK(t, err)
	if !search.HasMore || len(search.Items) != 1 {
		t.Fatalf("search: %#v", search)
	}
	id := search.Items[0].ID
	if id == a && !reflect.DeepEqual(search.Items[0].Tags, want) || id == b && len(search.Items[0].Tags) != 0 {
		t.Fatalf("search tags: %#v", search.Items[0])
	}
	assert([]string{id})
	writer := task.NewWriter(probe, f.project)
	selected, err := writer.TasksByID(ctx, []string{a, b, foreign})
	mustOK(t, err)
	if len(selected) != 2 || !reflect.DeepEqual(selected[0].Tags, want) || len(selected[1].Tags) != 0 {
		t.Fatalf("writer tasks: %#v", selected)
	}
	assert([]string{a, b})

	probe.failure = errors.New("batch read failed")
	failed, err := reader.Tasks(ctx, f.project, store.TaskQuery{Page: store.Page{Limit: 1}})
	if !errors.Is(err, probe.failure) || len(failed.Items) != 0 {
		t.Fatalf("partial list after batch failure: %#v, %v", failed, err)
	}
}

func TestTaskTagProjectionUsesSnapshot(t *testing.T) {
	db := readerStore(t)
	ctx := t.Context()
	project := readerProject(t, db, 1)
	item := readerTask(t, db, project.ID, 11, model.TaskTodo)
	tagID := readerID(21)
	readerExec(t, db, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES($1,$2,'Before','before',now(),now())`, tagID, project.ID)
	readerExec(t, db, `INSERT INTO task_tags(project_id,task_id,tag_id) VALUES($1,$2,$3)`, project.ID, item.ID, tagID)
	check := func(got []model.Task, name string) {
		t.Helper()
		if len(got) != 1 || !reflect.DeepEqual(got[0].Tags, []model.TagReference{{ID: tagID, Name: name}}) {
			t.Fatalf("snapshot tags: %#v", got)
		}
	}
	err := postgres.ReadOnlySnapshot(ctx, db.Pool, func(tx pgx.Tx) error {
		reader := task.NewReader(tx)
		first, err := reader.TaskBodies(ctx, project.ID, []string{item.ID})
		if err != nil {
			return err
		}
		check(first, "Before")
		if _, err := db.Pool.Exec(ctx, `UPDATE project_tags SET name='After',name_key='after' WHERE id=$1`, tagID); err != nil {
			return err
		}
		again, err := reader.TaskBodies(ctx, project.ID, []string{item.ID})
		if err != nil {
			return err
		}
		check(again, "Before")
		return nil
	})
	mustOK(t, err)
	err = postgres.ReadOnlySnapshot(ctx, db.Pool, func(tx pgx.Tx) error {
		got, err := task.NewReader(tx).TaskBodies(ctx, project.ID, []string{item.ID})
		if err == nil {
			check(got, "After")
		}
		return err
	})
	mustOK(t, err)
}

func TestTaskTagMixedWriteAndSync(t *testing.T) {
	db := readerStore(t)
	ctx := t.Context()
	project := readerProject(t, db, 1)
	item := readerTask(t, db, project.ID, 11, model.TaskTodo)
	unchanged := readerTask(t, db, project.ID, 12, model.TaskTodo)
	tagID := readerID(21)
	readerExec(t, db, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES($1,$2,'Before','before',now(),now())`, tagID, project.ID)
	var epoch string
	mustOK(t, db.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
		var err error
		epoch, err = s.TaskDAO().TaskCacheEpoch(ctx, project.ID)
		return err
	}))
	write := func(rollback bool) error {
		return readerWriteProject(db, ctx, project.ID, func(s store.ProjectWriteScope) error {
			if err := s.TaskTagDAO().ReplaceTaskTags(ctx, item.ID, []string{tagID}); err != nil {
				return err
			}
			updated, err := s.TaskDAO().UpdateTask(ctx, item.ID, store.TaskWrite{Title: "Mixed", Status: model.TaskTodo})
			if err != nil {
				return err
			}
			if updated.Version != item.Version+1 || !reflect.DeepEqual(updated.Tags, []model.TagReference{{ID: tagID, Name: "Before"}}) {
				t.Fatalf("mixed receipt: %#v", updated)
			}
			if rollback {
				return errors.New("reject mixed write")
			}
			return nil
		})
	}
	if err := write(true); err == nil {
		t.Fatal("rollback was not reported")
	}
	rolledBack := readerSnapshotTask(t, db, project.ID, item.ID)
	if rolledBack.Version != item.Version || rolledBack.Title != item.Title || len(rolledBack.Tags) != 0 {
		t.Fatalf("mixed rollback: %#v", rolledBack)
	}
	mustOK(t, write(false))
	committed := readerSnapshotTask(t, db, project.ID, item.ID)
	if committed.Version != item.Version+1 || committed.Title != "Mixed" || !reflect.DeepEqual(committed.Tags, []model.TagReference{{ID: tagID, Name: "Before"}}) {
		t.Fatalf("mixed committed: %#v", committed)
	}

	checkDelta := func(lower time.Time, version int64, tags []model.TagReference) {
		t.Helper()
		mustOK(t, db.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
			currentEpoch, err := s.TaskDAO().TaskCacheEpoch(ctx, project.ID)
			if err != nil {
				return err
			}
			rows, err := s.TaskDAO().TaskSyncTasks(ctx, project.ID, &lower, 160)
			if err != nil {
				return err
			}
			states, err := s.TaskDAO().TaskSyncDependencyStates(ctx, project.ID, &lower)
			if err != nil {
				return err
			}
			if currentEpoch != epoch || len(rows) != 1 || rows[0].ID != item.ID || rows[0].Version != version || !reflect.DeepEqual(rows[0].Tags, tags) || states[item.ID].TaskVersion != version {
				t.Fatalf("delta: epoch=%s/%s rows=%#v states=%#v", currentEpoch, epoch, rows, states)
			}
			if _, ok := states[unchanged.ID]; ok {
				t.Fatalf("unrelated task in delta: %#v", states)
			}
			return nil
		}))
	}
	var lower time.Time
	mustOK(t, db.Pool.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&lower))
	mustOK(t, readerWriteProject(db, ctx, project.ID, func(s store.ProjectWriteScope) error {
		observed, err := s.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		if _, err := s.TagDAO().UpdateTag(ctx, tagID, 1, "After", "after", observed); err != nil {
			return err
		}
		_, err = s.TaskTagDAO().TouchTaggedTasks(ctx, tagID, observed)
		return err
	}))
	checkDelta(lower, item.Version+2, []model.TagReference{{ID: tagID, Name: "After"}})
	mustOK(t, db.Pool.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&lower))
	mustOK(t, readerWriteProject(db, ctx, project.ID, func(s store.ProjectWriteScope) error {
		observed, err := s.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		if _, err := s.TaskTagDAO().TouchTaggedTasks(ctx, tagID, observed); err != nil {
			return err
		}
		if err := s.TaskTagDAO().ClearTagAssociations(ctx, tagID); err != nil {
			return err
		}
		return s.TagDAO().DeleteTag(ctx, tagID, 2)
	}))
	checkDelta(lower, item.Version+3, nil)
}
