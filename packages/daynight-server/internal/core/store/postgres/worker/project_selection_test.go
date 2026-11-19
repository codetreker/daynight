package worker_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
	coreworker "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/google/uuid"
)

type afterSelection struct {
	store.WorkerProjectSelectionDAO
	after func() error
}

func (d afterSelection) ProjectSelectionCandidates(ctx context.Context, id string) ([]store.WorkerSelectionID, error) {
	ids, err := d.WorkerProjectSelectionDAO.ProjectSelectionCandidates(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := d.after(); err != nil {
		return nil, err
	}
	return ids, nil
}

func TestProjectSelectionSnapshotAndLatestRawConfiguration(t *testing.T) {
	db := workerStorage(t)
	ctx := t.Context()
	project, other := uuid.NewString(), uuid.NewString()
	users := []string{uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()}
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()}
	for i := range users {
		tx, err := db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = worker.NewWriter(tx).UpsertWorker(ctx, snapshot(users[i], ids[i], time.Now().UTC())); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}
	selected := `{"projects":[{"projectId":"` + project + `","custom":true},{"projectId":"` + other + `","future":{"k":3}}],"future":{"keep":true}}`
	late := `{"projects":[{"projectId":"` + other + `"}]}`
	for i, raw := range []string{selected, selected, late} {
		if _, err := db.Pool.Exec(ctx, `UPDATE workers SET configuration_revision=4,configuration_updated_at=statement_timestamp(),desired_configuration=$3,configuration_observation_revision=7,configuration_observation='{"future":"observation"}'::jsonb,archive_sessions=false WHERE user_id=$1 AND worker_id=$2`, users[i], ids[i], raw); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	dao := afterSelection{WorkerProjectSelectionDAO: worker.NewWriter(tx), after: func() error {
		// These commits occur after selection but before row locking.
		_, err := db.Pool.Exec(ctx, `UPDATE workers SET desired_configuration=$3,configuration_revision=5 WHERE user_id=$1 AND worker_id=$2`, users[0], ids[0], `{"projects":[{"projectId":"`+project+`"},{"projectId":"`+other+`","latest":true}],"concurrent":"preserved"}`)
		if err != nil {
			return err
		}
		_, err = db.Pool.Exec(ctx, `UPDATE workers SET desired_configuration=$3,configuration_revision=5 WHERE user_id=$1 AND worker_id=$2`, users[2], ids[2], selected)
		return err
	}}
	if err := coreworker.RemoveProjectSelections(ctx, dao, project); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	read := func(i int) (int64, map[string]any, int64, bool) {
		t.Helper()
		var rev, obs int64
		var raw []byte
		var archive bool
		if err := db.Pool.QueryRow(ctx, `SELECT configuration_revision,desired_configuration,configuration_observation_revision,archive_sessions FROM workers WHERE user_id=$1 AND worker_id=$2`, users[i], ids[i]).Scan(&rev, &raw, &obs, &archive); err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		if err := json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		return rev, value, obs, archive
	}
	rev, actual, obs, archive := read(0)
	want := map[string]any{"projects": []any{map[string]any{"projectId": other, "latest": true}}, "concurrent": "preserved"}
	if rev != 6 || obs != 7 || archive || !reflect.DeepEqual(actual, want) {
		t.Fatalf("latest: rev=%d obs=%d archive=%v value=%v", rev, obs, archive, actual)
	}
	rev, actual, obs, archive = read(1)
	want = map[string]any{"projects": []any{map[string]any{"projectId": other, "future": map[string]any{"k": float64(3)}}}, "future": map[string]any{"keep": true}}
	if rev != 5 || obs != 7 || archive || !reflect.DeepEqual(actual, want) {
		t.Fatalf("second: rev=%d obs=%d archive=%v value=%v", rev, obs, archive, actual)
	}
	rev, actual, _, _ = read(2)
	if rev != 5 || len(actual["projects"].([]any)) != 2 {
		t.Fatalf("late selection changed: rev=%d value=%v", rev, actual)
	}
	var uninitialized *int64
	if err := db.Pool.QueryRow(ctx, `SELECT configuration_revision FROM workers WHERE user_id=$1 AND worker_id=$2`, users[3], ids[3]).Scan(&uninitialized); err != nil || uninitialized != nil {
		t.Fatalf("uninitialized: %v %v", uninitialized, err)
	}
}

func TestProjectSelectionRollback(t *testing.T) {
	db := workerStorage(t)
	ctx := t.Context()
	project, user, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = worker.NewWriter(tx).UpsertWorker(ctx, snapshot(user, id, time.Now().UTC())); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE workers SET configuration_revision=1,configuration_updated_at=statement_timestamp(),desired_configuration=$3 WHERE user_id=$1 AND worker_id=$2`, user, id, `{"projects":[{"projectId":"`+project+`"}]}`); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = coreworker.RemoveProjectSelections(ctx, worker.NewWriter(tx), project); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(ctx); err != nil && !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	var revision int64
	var raw []byte
	if err := db.Pool.QueryRow(ctx, `SELECT configuration_revision,desired_configuration FROM workers WHERE user_id=$1 AND worker_id=$2`, user, id).Scan(&revision, &raw); err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	if revision != 1 || len(value["projects"].([]any)) != 1 {
		t.Fatalf("rollback: revision=%d value=%v", revision, value)
	}
}

func TestProjectSelectionWaitsForConcurrentConfiguration(t *testing.T) {
	db := workerStorage(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	project, user, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = worker.NewWriter(tx).UpsertWorker(ctx, snapshot(user, id, time.Now().UTC())); err != nil {
		t.Fatal(err)
	}
	raw := `{"projects":[{"projectId":"` + project + `"}],"old":true}`
	if _, err = tx.Exec(ctx, `UPDATE workers SET configuration_revision=1,configuration_updated_at=statement_timestamp(),desired_configuration=$3 WHERE user_id=$1 AND worker_id=$2`, user, id, raw); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	first, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Rollback(context.Background())
	raw = `{"projects":[{"projectId":"` + project + `"}],"new":true}`
	if _, err = first.Exec(ctx, `UPDATE workers SET configuration_revision=2,desired_configuration=$3 WHERE user_id=$1 AND worker_id=$2`, user, id, raw); err != nil {
		t.Fatal(err)
	}
	second, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Rollback(context.Background())
	var pid uint32
	if err = second.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- coreworker.RemoveProjectSelections(ctx, worker.NewWriter(second), project) }()
	testutil.WaitThreadBackendLock(t, db.Pool, pid)
	if err = first.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = testutil.ReceiveQueryResult(t, ctx, done); err != nil {
		t.Fatal(err)
	}
	if err = second.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var revision int64
	var result []byte
	if err = db.Pool.QueryRow(ctx, `SELECT configuration_revision,desired_configuration FROM workers WHERE user_id=$1 AND worker_id=$2`, user, id).Scan(&revision, &result); err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err = json.Unmarshal(result, &value); err != nil {
		t.Fatal(err)
	}
	if revision != 3 || !reflect.DeepEqual(value, map[string]any{"projects": []any{}, "new": true}) {
		t.Fatalf("revision=%d configuration=%v", revision, value)
	}
}

func TestProjectSelectionMissingAndUninitializedTargets(t *testing.T) {
	tx := workerTransaction(t)
	dao := worker.NewWriter(tx)
	user, id := uuid.NewString(), uuid.NewString()
	if _, err := dao.UpsertWorker(t.Context(), snapshot(user, id, time.Now().UTC())); err != nil {
		t.Fatal(err)
	}
	for _, target := range []store.WorkerSelectionID{{UserID: user, WorkerID: id}, {UserID: user, WorkerID: uuid.NewString()}} {
		got, err := dao.LockProjectSelection(t.Context(), target)
		if err != nil || got != nil {
			t.Fatalf("missing or uninitialized target: %+v %v", got, err)
		}
	}
}

func TestProjectSelectionErrorsPreserveStoredConfiguration(t *testing.T) {
	db := workerStorage(t)
	ctx := t.Context()
	user, id, project := uuid.NewString(), uuid.NewString(), uuid.NewString()
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := worker.NewWriter(tx).UpsertWorker(ctx, snapshot(user, id, time.Now().UTC())); err != nil {
		t.Fatal(err)
	}
	raw := `{"projects":[{"projectId":"` + project + `"}]}`
	if _, err := tx.Exec(ctx, `UPDATE workers SET configuration_revision=1,configuration_updated_at=statement_timestamp(),desired_configuration=$3 WHERE user_id=$1 AND worker_id=$2`, user, id, raw); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	// A failed JSONB write must not change the stored target or its version.
	tx, err = db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	err = worker.NewWriter(tx).SaveProjectSelection(ctx, store.WorkerSelectionID{UserID: user, WorkerID: id}, 2, json.RawMessage(`{`))
	if err == nil {
		t.Fatal("invalid JSONB was accepted")
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var revision int64
	var same bool
	if err := db.Pool.QueryRow(ctx, `SELECT configuration_revision,desired_configuration=$3::jsonb FROM workers WHERE user_id=$1 AND worker_id=$2`, user, id, raw).Scan(&revision, &same); err != nil || revision != 1 || !same {
		t.Fatalf("failed save changed target: %d %v %v", revision, same, err)
	}

	for _, name := range []string{"candidates", "lock"} {
		t.Run(name, func(t *testing.T) {
			tx, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			cancelled, cancel := context.WithCancel(ctx)
			cancel()
			if name == "candidates" {
				_, err = worker.NewWriter(tx).ProjectSelectionCandidates(cancelled, project)
			} else {
				_, err = worker.NewWriter(tx).LockProjectSelection(cancelled, store.WorkerSelectionID{UserID: user, WorkerID: id})
			}
			if err == nil || !errors.Is(err, context.Canceled) {
				t.Fatalf("cancelled %s: %v", name, err)
			}
		})
	}
}
