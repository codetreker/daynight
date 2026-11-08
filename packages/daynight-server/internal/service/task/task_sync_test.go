package task_test

import (
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"

	"context"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
)

func TestTaskSyncModesWindowAndMutationSignals(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	ctx := context.Background()
	sync := taskservice.NewTaskSync(database, sessioncore.NewEngine(nil), 10*time.Second)
	empty, err := sync.Get(ctx, principal, project.ID, taskservice.TaskSyncRequest{})
	if err != nil || empty.Mode != "snapshot" || empty.Epoch == "" || empty.Tasks == nil || len(empty.Tasks) != 0 || empty.Project != project {
		t.Fatalf("empty snapshot: %#v %v", empty, err)
	}
	emptyDelta, err := sync.Get(ctx, principal, project.ID, taskservice.TaskSyncRequest{Epoch: empty.Epoch})
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
		delta, err := sync.Get(ctx, principal, project.ID, taskservice.TaskSyncRequest{Epoch: empty.Epoch, Since: &since})
		if err != nil || delta.Mode != "delta" || len(delta.Tasks) != 1 || delta.Tasks[0].ID != b.ID || delta.Tasks[0].UpdatedAt != stamp || delta.Epoch != empty.Epoch {
			t.Fatalf("inclusive repeated window: %#v %v", delta, err)
		}
	}
	if _, err := database.Pool.Exec(ctx, "UPDATE tasks SET version=version+1 WHERE id=$1", b.ID); err != nil {
		t.Fatal(err)
	}
	sameStamp, err := sync.Get(ctx, principal, project.ID, taskservice.TaskSyncRequest{Epoch: empty.Epoch, Since: &since})
	if err != nil || len(sameStamp.Tasks) != 1 || sameStamp.Tasks[0].Version != b.Version+1 || sameStamp.Tasks[0].UpdatedAt != stamp {
		t.Fatalf("same-timestamp higher version was skipped: %#v %v", sameStamp, err)
	}
	wider, err := taskservice.NewTaskSync(database, sessioncore.NewEngine(nil), 30*time.Second).Get(ctx, principal, project.ID, taskservice.TaskSyncRequest{Epoch: empty.Epoch, Since: &since})
	if err != nil || len(wider.Tasks) != 2 {
		t.Fatalf("new overlap must apply to the unchanged since: %#v %v", wider, err)
	}
	for _, input := range []taskservice.TaskSyncRequest{{}, {Epoch: "00000000-0000-4000-8000-000000000099", Since: &since}, {Epoch: empty.Epoch}} {
		result, err := sync.Get(ctx, principal, project.ID, input)
		if err != nil || len(result.Tasks) != 2 {
			t.Fatalf("complete baseline: %#v %v", result, err)
		}
	}
	for _, overlap := range []time.Duration{time.Nanosecond, 500 * time.Nanosecond, time.Microsecond} {
		lower := stamp.Add(overlap).Add(time.Nanosecond)
		result, err := taskservice.NewTaskSync(database, sessioncore.NewEngine(nil), overlap).Get(ctx, principal, project.ID, taskservice.TaskSyncRequest{Epoch: empty.Epoch, Since: &lower})
		if err != nil || len(result.Tasks) != 0 {
			t.Fatalf("submicrosecond overlap %v: %#v %v", overlap, result, err)
		}
	}
	// A future row is still selected: observedAt never supplies a query upper bound.
	future := time.Now().UTC().Add(time.Hour).Truncate(time.Microsecond)
	if _, err := database.Pool.Exec(ctx, "UPDATE tasks SET updated_at=$1 WHERE id=$2", future, b.ID); err != nil {
		t.Fatal(err)
	}
	result, err := sync.Get(ctx, principal, project.ID, taskservice.TaskSyncRequest{Epoch: empty.Epoch, Since: &future})
	if err != nil || len(result.Tasks) != 1 || !result.Tasks[0].UpdatedAt.After(result.ObservedAt) {
		t.Fatalf("request upper bound added: %#v %v", result, err)
	}
	description := "Changed details"
	a, err = tasks.Update(ctx, principal, project.ID, a.ID, taskcore.UpdateTask{Version: a.Version, Description: &description})
	if err != nil {
		t.Fatal(err)
	}
	properties := []model.PullRequestProperty{{URL: "https://github.com/org/repo/pull/1", Title: "Change"}}
	a, err = tasks.Update(ctx, principal, project.ID, a.ID, taskcore.UpdateTask{Version: a.Version, Properties: propertyPatch(properties...)})
	if err != nil {
		t.Fatal(err)
	}
	before := a
	a, err = tasks.Update(ctx, principal, project.ID, a.ID, taskcore.UpdateTask{Version: a.Version, Description: &description})
	if err != nil {
		t.Fatal(err)
	}
	if a.Version != before.Version || a.UpdatedAt != before.UpdatedAt || a.Version != 3 {
		t.Fatalf("semantic no-op changed signal: %#v %#v", a, before)
	}
	result, err = sync.Get(ctx, principal, project.ID, taskservice.TaskSyncRequest{Epoch: empty.Epoch, Since: &a.UpdatedAt})
	if err != nil || len(result.Tasks) != 2 || result.Tasks[0].Version != 3 || result.Tasks[0].UpdatedAt != a.UpdatedAt {
		t.Fatalf("detail mutation lost summary signal: %#v %v", result, err)
	}
	_, err = sync.Get(ctx, principal, project.ID, taskservice.TaskSyncRequest{Since: &since})
	requireFault(t, err, "invalid_input")
	_, err = sync.Get(ctx, principal, project.ID, taskservice.TaskSyncRequest{Epoch: "invalid"})
	requireFault(t, err, "invalid_input")
	_, err = sync.Get(ctx, model.Principal{}, project.ID, taskservice.TaskSyncRequest{})
	requireFault(t, err, "unauthenticated")
	_, err = sync.Get(ctx, principal, "invalid", taskservice.TaskSyncRequest{})
	requireFault(t, err, "invalid_input")
	_, err = sync.Get(ctx, principal, "00000000-0000-4000-8000-000000000099", taskservice.TaskSyncRequest{})
	requireFault(t, err, "not_found")
	stranger := servicePrincipal(t, database)
	_, err = sync.Get(ctx, stranger, project.ID, taskservice.TaskSyncRequest{})
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
			baseline, err := taskservice.NewTaskSync(database, sessioncore.NewEngine(nil), 10*time.Second).Get(context.Background(), principal, project.ID, taskservice.TaskSyncRequest{})
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
			result, err := taskservice.NewTaskSync(traced.store, sessioncore.NewEngine(nil), 10*time.Second).Get(context.Background(), principal, project.ID, taskservice.TaskSyncRequest{Epoch: epoch, Since: &since})
			if test.refused {
				fault := requireFault(t, err, "graph_limit_exceeded")
				if read || fault.GraphLimit.NodeCount != int64(test.nodes) || fault.GraphLimit.EdgeCount != int64(test.edges) || !reflect.DeepEqual(result, model.TaskSync{}) {
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
	reader := workerMember(t, database, project.ID)
	beforeAccess, err := projectservice.NewProjects(database).Access(ctx, reader, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	var oldEpoch string
	if err := database.Pool.QueryRow(ctx, "SELECT task_cache_epoch::text FROM projects WHERE id=$1", project.ID).Scan(&oldEpoch); err != nil {
		t.Fatal(err)
	}
	traced := tracedTasks(t, url, taskQueryAction{match: func(sql string) bool { return strings.Contains(sql, "SELECT count(*) FROM tasks") }, end: func() {
		if err := writeProjectForTest(database, ctx, project.ID, func(tx store.ProjectWriteScope) error {
			_, err := tx.TaskDAO().UpdateTask(ctx, a.ID, store.TaskWrite{Title: "After", Status: model.TaskDone})
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := database.Pool.Exec(ctx, "UPDATE projects SET task_cache_epoch=gen_random_uuid(), execution_warning_minutes=31 WHERE id=$1", project.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := database.Pool.Exec(ctx, `UPDATE project_grants SET role='admin',version=9007199254740993,updated_at=statement_timestamp() WHERE project_id=$1 AND user_id=$2`, project.ID, reader.UserID); err != nil {
			t.Fatal(err)
		}
	}})
	old, err := taskservice.NewTaskSync(traced.store, sessioncore.NewEngine(nil), 10*time.Second).Get(ctx, reader, project.ID, taskservice.TaskSyncRequest{Epoch: oldEpoch})
	if err != nil || old.Epoch != oldEpoch || old.Project != project || !reflect.DeepEqual(old.ActorAccess, beforeAccess) || len(old.Tasks) != 2 || old.Tasks[0].TitlePreview != "Before" || old.Tasks[0].Version != 1 || !slices.Equal(old.Tasks[1].DependsOn, []string{a.ID}) {
		t.Fatalf("mixed snapshot: %#v %v", old, err)
	}
	fresh, err := taskservice.NewTaskSync(database, sessioncore.NewEngine(nil), 10*time.Second).Get(ctx, reader, project.ID, taskservice.TaskSyncRequest{Epoch: oldEpoch})
	if err != nil || fresh.Mode != "snapshot" || fresh.Epoch == oldEpoch || fresh.Tasks[0].TitlePreview != "After" || fresh.Project.Settings.ExecutionWarningMinutes != 31 || fresh.ActorAccess.Role != model.ProjectAdmin || fresh.ActorAccess.DirectGrant == nil || fresh.ActorAccess.DirectGrant.Version != 9007199254740993 {
		t.Fatalf("fresh history: %#v %v", fresh, err)
	}
}

const taskSyncLockTestOverlap = 20 * time.Millisecond

func waitForTaskSyncDatabaseTime(ctx context.Context, database *postgres.Store, boundary time.Time) (time.Time, error) {
	poll, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var observed time.Time
		if err := database.Pool.QueryRow(poll, "SELECT clock_timestamp()").Scan(&observed); err != nil {
			return time.Time{}, fmt.Errorf("read database clock while holding the Project lock: %w", err)
		}
		if observed.After(boundary) {
			return observed, nil
		}
		select {
		case <-poll.Done():
			return time.Time{}, fmt.Errorf("database clock did not cross the TaskSync overlap: %w", poll.Err())
		case <-ticker.C:
		}
	}
}

func TestTaskSyncLongProjectLockWaitPreservesLaterWatermark(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	a := createTask(t, tasks, principal, project.ID, "Lock holder")
	b := createTask(t, tasks, principal, project.ID, "Waiter")
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	result := make(chan error, 1)
	var first, later model.Task
	var afterWait time.Time
	err := writeProjectForTest(database, ctx, project.ID, func(tx store.ProjectWriteScope) error {
		go func() {
			var err error
			title := "Later"
			later, err = tasks.Update(ctx, principal, project.ID, b.ID, taskcore.UpdateTask{Version: b.Version, Title: &title})
			result <- err
		}()
		barrier, finishBarrier := context.WithTimeout(ctx, 5*time.Second)
		defer finishBarrier()
		waitForTaskWriters(t, barrier, database, 1)
		var waitingSince time.Time
		if err := database.Pool.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&waitingSince); err != nil {
			return err
		}
		observed, err := waitForTaskSyncDatabaseTime(ctx, database, waitingSince.Add(taskSyncLockTestOverlap))
		if err != nil {
			return err
		}
		afterWait = observed
		select {
		case err := <-result:
			return fmt.Errorf("second writer crossed the held Project lock: %v", err)
		default:
		}
		first, err = tx.TaskDAO().UpdateTask(ctx, a.ID, store.TaskWrite{Title: "First", Status: model.TaskTodo})
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
	if !first.UpdatedAt.After(afterWait) {
		t.Fatalf("holder used a timestamp before its delayed write: observed %v first %v", afterWait, first.UpdatedAt)
	}
	if !later.UpdatedAt.After(first.UpdatedAt) {
		t.Fatalf("waiter used an earlier transaction timestamp: first %v later %v", first.UpdatedAt, later.UpdatedAt)
	}
	baseline, err := taskservice.NewTaskSync(database, sessioncore.NewEngine(nil), taskSyncLockTestOverlap).Get(ctx, principal, project.ID, taskservice.TaskSyncRequest{})
	if err != nil {
		t.Fatal(err)
	}
	delta, err := taskservice.NewTaskSync(database, sessioncore.NewEngine(nil), taskSyncLockTestOverlap).Get(ctx, principal, project.ID, taskservice.TaskSyncRequest{Epoch: baseline.Epoch, Since: &first.UpdatedAt})
	if err != nil || len(delta.Tasks) != 2 || delta.Tasks[0].ID != a.ID || delta.Tasks[0].Version != first.Version || delta.Tasks[1].ID != b.ID || delta.Tasks[1].Version != later.Version {
		t.Fatalf("long waiter skipped by window: %#v %v", delta, err)
	}
}

func TestTaskSyncUncommittedWriteBeyondOverlapRemainsDiscoverable(t *testing.T) {
	tasks, database, project, _, principal := taskService(t)
	a := createTask(t, tasks, principal, project.ID, "Uncommitted")
	b := createTask(t, tasks, principal, project.ID, "Waiting")
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	// The baseline window contains both committed fixture rows regardless of setup latency.
	aligned, err := database.Pool.Exec(ctx, "UPDATE tasks SET updated_at=statement_timestamp() WHERE project_id=$1 AND id=ANY($2::uuid[])", project.ID, []string{a.ID, b.ID})
	if err != nil || aligned.RowsAffected() != 2 {
		t.Fatalf("align initial Task watermarks: rows=%d error=%v", aligned.RowsAffected(), err)
	}
	a, err = tasks.Get(ctx, principal, project.ID, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	b, err = tasks.Get(ctx, principal, project.ID, b.ID)
	if err != nil {
		t.Fatal(err)
	}
	sync := taskservice.NewTaskSync(database, sessioncore.NewEngine(nil), taskSyncLockTestOverlap)
	baseline, err := sync.Get(ctx, principal, project.ID, taskservice.TaskSyncRequest{})
	if err != nil {
		t.Fatal(err)
	}
	since := baseline.Tasks[1].UpdatedAt
	result := make(chan error, 1)
	var first, later model.Task
	var heldFor time.Duration
	err = writeProjectForTest(database, ctx, project.ID, func(tx store.ProjectWriteScope) error {
		var err error
		first, err = tx.TaskDAO().UpdateTask(ctx, a.ID, store.TaskWrite{Title: "Committed first", Status: model.TaskTodo})
		if err != nil {
			return err
		}
		started := time.Now()
		go func() {
			title := "Committed later"
			var err error
			later, err = tasks.Update(ctx, principal, project.ID, b.ID, taskcore.UpdateTask{Version: b.Version, Title: &title})
			result <- err
		}()
		barrier, finishBarrier := context.WithTimeout(ctx, 5*time.Second)
		defer finishBarrier()
		waitForTaskWriters(t, barrier, database, 1)
		var waitingSince time.Time
		if err := database.Pool.QueryRow(ctx, "SELECT clock_timestamp()").Scan(&waitingSince); err != nil {
			return err
		}
		if _, err := waitForTaskSyncDatabaseTime(ctx, database, waitingSince.Add(taskSyncLockTestOverlap)); err != nil {
			return err
		}
		heldFor = time.Since(started)
		old, err := sync.Get(ctx, principal, project.ID, taskservice.TaskSyncRequest{Epoch: baseline.Epoch, Since: &since})
		if err != nil {
			return err
		}
		if len(old.Tasks) != 2 || old.Tasks[0].Version != a.Version || old.Tasks[1].Version != b.Version || old.Tasks[0].UpdatedAt != a.UpdatedAt || old.Tasks[1].UpdatedAt != b.UpdatedAt || !old.ObservedAt.After(first.UpdatedAt.Add(taskSyncLockTestOverlap)) {
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
	delta, err := sync.Get(ctx, principal, project.ID, taskservice.TaskSyncRequest{Epoch: baseline.Epoch, Since: &since})
	if err != nil || !later.UpdatedAt.After(first.UpdatedAt) || len(delta.Tasks) != 2 || delta.Tasks[0].ID != a.ID || delta.Tasks[0].Version != first.Version || delta.Tasks[1].ID != b.ID || delta.Tasks[1].Version != later.Version {
		t.Fatalf("long uncommitted write skipped: held %s, first %v, later %v, delta %#v, error %v", heldFor, first.UpdatedAt, later.UpdatedAt, delta, err)
	}
	t.Logf("project lock held after task write for %s; old snapshot retained versions %d/%d; committed timestamps %s then %s", heldFor, a.Version, b.Version, first.UpdatedAt.Format(time.RFC3339Nano), later.UpdatedAt.Format(time.RFC3339Nano))
}
