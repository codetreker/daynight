package service

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestTaskSyncModesWindowAndMutationSignals(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	sync := NewTaskSync(database, 10*time.Second)
	empty, err := sync.Get(ctx, principal, project.ID, TaskSyncRequest{})
	if err != nil || empty.Mode != "snapshot" || empty.Epoch == "" || empty.Tasks == nil || len(empty.Tasks) != 0 || empty.Project != project {
		t.Fatalf("empty snapshot: %#v %v", empty, err)
	}
	emptyDelta, err := sync.Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: empty.Epoch})
	if err != nil || emptyDelta.Mode != "delta" || emptyDelta.Tasks == nil || len(emptyDelta.Tasks) != 0 {
		t.Fatalf("empty baseline: %#v %v", emptyDelta, err)
	}
	a := createTask(t, tasks, principal, project.ID, "A")
	b := createTask(t, tasks, principal, project.ID, "B", a.ID)
	stamp := time.Date(2026, 10, 24, 0, 0, 0, 123456000, time.UTC)
	if _, err := database.Pool.Exec(ctx, "UPDATE tasks SET updated_at=$1 WHERE project_id=$2", stamp, project.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, "UPDATE tasks SET updated_at=$1 WHERE id=$2", stamp.Add(-time.Microsecond), a.ID); err != nil {
		t.Fatal(err)
	}
	since := stamp.Add(10 * time.Second)
	for range 3 {
		delta, err := sync.Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: empty.Epoch, Since: &since})
		if err != nil || delta.Mode != "delta" || len(delta.Tasks) != 1 || delta.Tasks[0].ID != b.ID || delta.Tasks[0].UpdatedAt != stamp || delta.Epoch != empty.Epoch {
			t.Fatalf("inclusive repeated window: %#v %v", delta, err)
		}
	}
	if _, err := database.Pool.Exec(ctx, "UPDATE tasks SET version=version+1 WHERE id=$1", b.ID); err != nil {
		t.Fatal(err)
	}
	sameStamp, err := sync.Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: empty.Epoch, Since: &since})
	if err != nil || len(sameStamp.Tasks) != 1 || sameStamp.Tasks[0].Version != b.Version+1 || sameStamp.Tasks[0].UpdatedAt != stamp {
		t.Fatalf("same-timestamp higher version was skipped: %#v %v", sameStamp, err)
	}
	wider, err := NewTaskSync(database, 30*time.Second).Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: empty.Epoch, Since: &since})
	if err != nil || len(wider.Tasks) != 2 {
		t.Fatalf("new overlap must apply to the unchanged since: %#v %v", wider, err)
	}
	for _, input := range []TaskSyncRequest{{}, {Epoch: "00000000-0000-4000-8000-000000000099", Since: &since}, {Epoch: empty.Epoch}} {
		result, err := sync.Get(ctx, principal, project.ID, input)
		if err != nil || len(result.Tasks) != 2 {
			t.Fatalf("complete baseline: %#v %v", result, err)
		}
	}
	for _, overlap := range []time.Duration{time.Nanosecond, 500 * time.Nanosecond, time.Microsecond} {
		lower := stamp.Add(overlap).Add(time.Nanosecond)
		result, err := NewTaskSync(database, overlap).Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: empty.Epoch, Since: &lower})
		if err != nil || len(result.Tasks) != 0 {
			t.Fatalf("submicrosecond overlap %v: %#v %v", overlap, result, err)
		}
	}
	// A future row is still selected: observedAt never supplies a query upper bound.
	future := time.Now().UTC().Add(time.Hour).Truncate(time.Microsecond)
	if _, err := database.Pool.Exec(ctx, "UPDATE tasks SET updated_at=$1 WHERE id=$2", future, b.ID); err != nil {
		t.Fatal(err)
	}
	result, err := sync.Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: empty.Epoch, Since: &future})
	if err != nil || len(result.Tasks) != 1 || !result.Tasks[0].UpdatedAt.After(result.ObservedAt) {
		t.Fatalf("request upper bound added: %#v %v", result, err)
	}
	description := "Changed details"
	a, err = tasks.Update(ctx, principal, project.ID, a.ID, UpdateTask{Version: a.Version, Description: &description})
	if err != nil {
		t.Fatal(err)
	}
	properties := []core.PullRequestProperty{{URL: "https://github.com/org/repo/pull/1", Title: "Change"}}
	a, err = tasks.Update(ctx, principal, project.ID, a.ID, UpdateTask{Version: a.Version, Properties: propertyPatch(properties...)})
	if err != nil {
		t.Fatal(err)
	}
	before := a
	a, err = tasks.Update(ctx, principal, project.ID, a.ID, UpdateTask{Version: a.Version, Description: &description})
	if err != nil {
		t.Fatal(err)
	}
	if a.Version != before.Version || a.UpdatedAt != before.UpdatedAt || a.Version != 3 {
		t.Fatalf("semantic no-op changed signal: %#v %#v", a, before)
	}
	result, err = sync.Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: empty.Epoch, Since: &a.UpdatedAt})
	if err != nil || len(result.Tasks) != 2 || result.Tasks[0].Version != 3 || result.Tasks[0].UpdatedAt != a.UpdatedAt {
		t.Fatalf("detail mutation lost summary signal: %#v %v", result, err)
	}
	_, err = sync.Get(ctx, principal, project.ID, TaskSyncRequest{Since: &since})
	requireFault(t, err, "invalid_input")
	_, err = sync.Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: "invalid"})
	requireFault(t, err, "invalid_input")
	_, err = sync.Get(ctx, core.Principal{}, project.ID, TaskSyncRequest{})
	requireFault(t, err, "unauthenticated")
	_, err = sync.Get(ctx, principal, "invalid", TaskSyncRequest{})
	requireFault(t, err, "invalid_input")
	_, err = sync.Get(ctx, principal, "00000000-0000-4000-8000-000000000099", TaskSyncRequest{})
	requireFault(t, err, "not_found")
	stranger := servicePrincipal(t, database)
	_, err = sync.Get(ctx, stranger, project.ID, TaskSyncRequest{})
	requireFault(t, err, "not_found")
}

func TestTaskSyncFullCapacityBeforeWindowProjection(t *testing.T) {
	for _, test := range []struct {
		nodes, edges int
		refused      bool
	}{{1000, 5000, false}, {1001, 0, true}, {101, 5001, true}} {
		t.Run(fmt.Sprintf("%d_%d", test.nodes, test.edges), func(t *testing.T) {
			_, database, project, url, principal := taskService(t)
			seedGraph(t, database, project.ID, test.nodes, test.edges)
			baseline, err := NewTaskSync(database, 10*time.Second).Get(context.Background(), principal, project.ID, TaskSyncRequest{})
			if test.refused {
				requireFault(t, err, "graph_limit_exceeded")
			} else if err != nil || len(baseline.Tasks) != 1000 {
				t.Fatalf("exact limit: %#v %v", baseline, err)
			}
			var epoch string
			if err := database.Pool.QueryRow(context.Background(), "SELECT task_cache_epoch::text FROM projects WHERE id=$1", project.ID).Scan(&epoch); err != nil {
				t.Fatal(err)
			}
			read := false
			traced := tracedTasks(t, url, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "left(t.title, $2)") }, start: func() { read = true }})
			since := time.Now().Add(time.Hour)
			result, err := NewTaskSync(traced.store, 10*time.Second).Get(context.Background(), principal, project.ID, TaskSyncRequest{Epoch: epoch, Since: &since})
			if test.refused {
				fault := requireFault(t, err, "graph_limit_exceeded")
				if read || fault.GraphLimit.NodeCount != int64(test.nodes) || fault.GraphLimit.EdgeCount != int64(test.edges) || !reflect.DeepEqual(result, core.TaskSync{}) {
					t.Fatalf("partial capacity check: %#v %#v", fault, result)
				}
			} else if err != nil || !read || result.Tasks == nil || len(result.Tasks) != 0 {
				t.Fatalf("valid empty window: %#v %v", result, err)
			}
		})
	}
}

func TestTaskSyncInterleavedWriteKeepsOneSnapshot(t *testing.T) {
	tasks, database, project, url, principal := taskService(t)
	ctx := context.Background()
	a := createTask(t, tasks, principal, project.ID, "Before")
	createTask(t, tasks, principal, project.ID, "Dependent", a.ID)
	var oldEpoch string
	if err := database.Pool.QueryRow(ctx, "SELECT task_cache_epoch::text FROM projects WHERE id=$1", project.ID).Scan(&oldEpoch); err != nil {
		t.Fatal(err)
	}
	traced := tracedTasks(t, url, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "SELECT count(*) FROM tasks") }, end: func() {
		if err := database.WriteProject(ctx, project.ID, func(tx *store.ProjectTx) error {
			_, err := tx.UpdateTask(ctx, a.ID, store.TaskWrite{Title: "After", Status: core.TaskDone})
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := database.Pool.Exec(ctx, "UPDATE projects SET task_cache_epoch=gen_random_uuid(), execution_warning_minutes=31 WHERE id=$1", project.ID); err != nil {
			t.Fatal(err)
		}
	}})
	old, err := NewTaskSync(traced.store, 10*time.Second).Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: oldEpoch})
	if err != nil || old.Epoch != oldEpoch || old.Project != project || len(old.Tasks) != 2 || old.Tasks[0].TitlePreview != "Before" || old.Tasks[0].Version != 1 || !slices.Equal(old.Tasks[1].DependsOn, []string{a.ID}) {
		t.Fatalf("mixed snapshot: %#v %v", old, err)
	}
	fresh, err := NewTaskSync(database, 10*time.Second).Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: oldEpoch})
	if err != nil || fresh.Mode != "snapshot" || fresh.Epoch == oldEpoch || fresh.Tasks[0].TitlePreview != "After" || fresh.Project.Settings.ExecutionWarningMinutes != 31 {
		t.Fatalf("fresh history: %#v %v", fresh, err)
	}
}

func TestTaskSyncOperationalFailuresAndCompletionPrecedence(t *testing.T) {
	for _, test := range []struct {
		name, fragment           string
		missing, limit, complete bool
	}{
		{"project", "FROM projects WHERE id =", false, false, false}, {"epoch", "SELECT task_cache_epoch::text", false, false, false},
		{"count", "SELECT count(*) FROM tasks", false, false, false}, {"rows", "left(t.title, $2)", false, false, false}, {"properties", "SELECT task_id::text,name,value FROM task_properties", false, false, false}, {"clock", "SELECT statement_timestamp()", false, false, false},
		{"missing completion", "FROM project_members m", true, false, true}, {"limit completion", "SELECT count(*) FROM tasks", false, true, true}, {"success completion", "SELECT statement_timestamp()", false, false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			tasks, database, project, url, principal := taskService(t)
			if test.name == "properties" {
				createTask(t, tasks, principal, project.ID, "Property read")
			}
			if test.limit {
				seedGraph(t, database, project.ID, 1001, 0)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			action := taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, test.fragment) }}
			if test.complete {
				action.end = cancel
			} else {
				action.start = cancel
			}
			traced := tracedTasks(t, url, action)
			id := project.ID
			if test.missing {
				id = "00000000-0000-4000-8000-000000000099"
			}
			result, err := NewTaskSync(traced.store, 10*time.Second).Get(ctx, principal, id, TaskSyncRequest{})
			assertOperational(t, err)
			if !errors.Is(err, context.Canceled) || !reflect.DeepEqual(result, core.TaskSync{}) {
				t.Fatalf("completion precedence: %#v %v", result, err)
			}
		})
	}
	_, database, project, _, principal := taskService(t)
	database.Close()
	_, err := NewTaskSync(database, 10*time.Second).Get(context.Background(), principal, project.ID, TaskSyncRequest{})
	assertOperational(t, err)
}

func TestTaskSyncLongProjectLockWaitPreservesLaterWatermark(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	a := createTask(t, tasks, principal, project.ID, "Lock holder")
	b := createTask(t, tasks, principal, project.ID, "Waiter")
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	result := make(chan error, 1)
	var first, later core.Task
	err := database.WriteProject(ctx, project.ID, func(tx *store.ProjectTx) error {
		go func() {
			var err error
			title := "Later"
			later, err = tasks.Update(ctx, principal, project.ID, b.ID, UpdateTask{Version: b.Version, Title: &title})
			result <- err
		}()
		barrier, finishBarrier := context.WithTimeout(ctx, 5*time.Second)
		defer finishBarrier()
		waitForTaskWriters(t, barrier, database, 1)
		if _, err := database.Pool.Exec(ctx, "SELECT pg_sleep(11)"); err != nil {
			return err
		}
		var err error
		first, err = tx.UpdateTask(ctx, a.ID, store.TaskWrite{Title: "First", Status: core.TaskTodo})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if !later.UpdatedAt.After(first.UpdatedAt) {
		t.Fatalf("waiter used an earlier transaction timestamp: first %v later %v", first.UpdatedAt, later.UpdatedAt)
	}
	baseline, err := NewTaskSync(database, 10*time.Second).Get(ctx, principal, project.ID, TaskSyncRequest{})
	if err != nil {
		t.Fatal(err)
	}
	delta, err := NewTaskSync(database, 10*time.Second).Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: baseline.Epoch, Since: &first.UpdatedAt})
	if err != nil || len(delta.Tasks) != 2 || delta.Tasks[1].ID != b.ID || delta.Tasks[1].Version != later.Version {
		t.Fatalf("long waiter skipped by window: %#v %v", delta, err)
	}
}

func TestTaskSyncUncommittedWriteBeyondOverlapRemainsDiscoverable(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	a := createTask(t, tasks, principal, project.ID, "Uncommitted")
	b := createTask(t, tasks, principal, project.ID, "Waiting")
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	sync := NewTaskSync(database, 10*time.Second)
	baseline, err := sync.Get(ctx, principal, project.ID, TaskSyncRequest{})
	if err != nil {
		t.Fatal(err)
	}
	since := baseline.Tasks[1].UpdatedAt
	result := make(chan error, 1)
	var first, later core.Task
	var heldFor time.Duration
	err = database.WriteProject(ctx, project.ID, func(tx *store.ProjectTx) error {
		var err error
		first, err = tx.UpdateTask(ctx, a.ID, store.TaskWrite{Title: "Committed first", Status: core.TaskTodo})
		if err != nil {
			return err
		}
		started := time.Now()
		go func() {
			title := "Committed later"
			var err error
			later, err = tasks.Update(ctx, principal, project.ID, b.ID, UpdateTask{Version: b.Version, Title: &title})
			result <- err
		}()
		barrier, finishBarrier := context.WithTimeout(ctx, 5*time.Second)
		defer finishBarrier()
		waitForTaskWriters(t, barrier, database, 1)
		if _, err := database.Pool.Exec(ctx, "SELECT pg_sleep(11)"); err != nil {
			return err
		}
		heldFor = time.Since(started)
		old, err := sync.Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: baseline.Epoch, Since: &since})
		if err != nil {
			return err
		}
		if len(old.Tasks) != 2 || old.Tasks[0].Version != a.Version || old.Tasks[1].Version != b.Version || old.Tasks[0].UpdatedAt != a.UpdatedAt || !old.ObservedAt.After(first.UpdatedAt.Add(10*time.Second)) {
			return fmt.Errorf("uncommitted task leaked into the old snapshot: %#v", old)
		}
		select {
		case err := <-result:
			return fmt.Errorf("second writer crossed the held project lock: %v", err)
		default:
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	delta, err := sync.Get(ctx, principal, project.ID, TaskSyncRequest{Epoch: baseline.Epoch, Since: &since})
	if err != nil || heldFor < 11*time.Second || !later.UpdatedAt.After(first.UpdatedAt) || len(delta.Tasks) != 2 || delta.Tasks[0].Version != first.Version || delta.Tasks[1].Version != later.Version {
		t.Fatalf("long uncommitted write skipped: held %s, first %v, later %v, delta %#v, error %v", heldFor, first.UpdatedAt, later.UpdatedAt, delta, err)
	}
	t.Logf("project lock held after task write for %s; old snapshot retained versions %d/%d; committed timestamps %s then %s", heldFor, a.Version, b.Version, first.UpdatedAt.Format(time.RFC3339Nano), later.UpdatedAt.Format(time.RFC3339Nano))
}
