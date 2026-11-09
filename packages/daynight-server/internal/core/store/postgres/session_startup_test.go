package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func waitForStartupTaskLock(ctx context.Context, database *Store, blocker uint32) error {
	if err := waitForTaskStoreLock(ctx, database, blocker); err != nil {
		return err
	}
	var query string
	if err := database.Pool.QueryRow(ctx, `SELECT query FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid)) LIMIT 1`, blocker).Scan(&query); err != nil {
		return err
	}
	if !strings.Contains(query, "FROM tasks") {
		return fmt.Errorf("startup transaction acquired its Session lock before waiting for the Task: %s", query)
	}
	return nil
}

func TestSessionStartupFenceRejectsForeignAndStaleIdentity(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	var releases []func()
	var finished []<-chan struct{}
	defer func() {
		cancel()
		for _, release := range releases {
			release()
		}
		for _, done := range finished {
			<-done
		}
	}()
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	target := queryTask(t, db, project.ID, 2, model.TaskInProgress)
	worker := workerWitnessClaim(2, uuid.NewString(), uuid.NewString(), model.WorkerActive)
	worker.AgentControlMode = model.AgentControlModeWeb
	putTaskPropertyFixture(t, db, target.ID, "worker", fixtureTaskProperties(t, worker)["worker"])
	report := sp.StartupReport{SchemaVersion: 1, Source: "worker", SessionID: uuid.NewString(), ClaimID: worker.ClaimID, ExecutionGeneration: "2", ControllerInstanceID: uuid.NewString(), Revision: "2", ObservedAt: "2026-11-05T00:00:00Z"}
	report.Startup.State, report.Startup.ReasonCode = "failed", "native_rejected"
	report.Recovery.State, report.Recovery.ReasonCode = "blocked", workerWitnessPointer("native_identity_missing")
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: report.SessionID, ClaimID: worker.ClaimID, ExecutionGeneration: "2"}}, Lifecycle: "active", Identity: sp.Identity{ControllerInstanceID: report.ControllerInstanceID, WorkerID: worker.WorkerID, WorktreeID: worker.WorktreeID}}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, db, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`, report.SessionID, project.ID, target.ID, worker.ClaimID, worker.UserID, uuid.NewString(), raw)
	check := func(ctx context.Context, w model.WorkerClaim, r sp.StartupReport) (bool, error) {
		var matched bool
		completion, err := db.WriteProject(ctx, project.ID, func(tx ProjectWriteScope) error {
			if _, err := tx.TaskDAO().Task(ctx, target.ID); err != nil {
				return err
			}
			var err error
			matched, err = tx.SessionDAO().MatchSessionStartup(ctx, target.ID, &w, r)
			return err
		})
		if err == nil && completion.Outcome != TransactionCommitted {
			return false, fmt.Errorf("startup identity transaction did not commit: %s", completion.Outcome)
		}
		return matched, err
	}
	if matched, err := check(ctx, *worker, report); err != nil || !matched {
		t.Fatalf("current identity: %t %v", matched, err)
	}
	before := snapshotTask(t, db, project.ID, target.ID)
	reportBytes, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	updatedWorker := *worker
	updatedWorker.Phase = model.WorkerWaiting
	values := taskPropertyWriteValues(before)
	values.Properties = fixtureTaskProperties(t, &updatedWorker)
	values.Properties["sessionStartup"] = reportBytes
	var updated model.Task
	completion, err := db.WriteProject(ctx, project.ID, func(tx ProjectWriteScope) error {
		current, err := tx.TaskDAO().Task(ctx, target.ID)
		if err != nil {
			return err
		}
		if current.Version != before.Version {
			return errors.New("startup fixture Task version changed")
		}
		matched, err := tx.SessionDAO().MatchSessionStartup(ctx, target.ID, worker, report)
		if err != nil {
			return err
		}
		if !matched {
			return errors.New("current startup binding was not locked")
		}
		updated, err = tx.TaskDAO().UpdateTask(ctx, target.ID, values)
		return err
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("startup property commit: %+v %v", completion, err)
	}
	persisted := snapshotTask(t, db, project.ID, target.ID)
	storedReport, err := taskproperties.SessionStartup(persisted.Properties)
	storedWorker := fixtureWorker(t, persisted.Properties)
	if err != nil || !reflect.DeepEqual(persisted, updated) || persisted.Version != before.Version+1 || !reflect.DeepEqual(storedReport, &report) || !reflect.DeepEqual(storedWorker, &updatedWorker) || storedWorker.Herdr != nil || storedWorker.NativeSessionID != nil {
		t.Fatalf("committed startup and waiting state did not roundtrip: %#v %v", persisted, err)
	}
	if matched, err := check(ctx, updatedWorker, report); err != nil || !matched || !reflect.DeepEqual(snapshotTask(t, db, project.ID, target.ID), persisted) {
		t.Fatalf("read-only startup replay changed Task facts: %t %v", matched, err)
	}
	for name, mutate := range map[string]func(*model.WorkerClaim, *sp.StartupReport){
		"old generation":   func(_ *model.WorkerClaim, r *sp.StartupReport) { r.ExecutionGeneration = "1" },
		"foreign session":  func(_ *model.WorkerClaim, r *sp.StartupReport) { r.SessionID = uuid.NewString() },
		"old claim":        func(_ *model.WorkerClaim, r *sp.StartupReport) { r.ClaimID = uuid.NewString() },
		"foreign instance": func(_ *model.WorkerClaim, r *sp.StartupReport) { r.ControllerInstanceID = uuid.NewString() },
		"foreign owner":    func(w *model.WorkerClaim, _ *sp.StartupReport) { w.UserID = uuid.NewString() },
		"foreign worker":   func(w *model.WorkerClaim, _ *sp.StartupReport) { w.WorkerID = uuid.NewString() },
		"foreign worktree": func(w *model.WorkerClaim, _ *sp.StartupReport) { w.WorktreeID = uuid.NewString() },
	} {
		t.Run(name, func(t *testing.T) {
			w, r := updatedWorker, report
			mutate(&w, &r)
			if matched, err := check(ctx, w, r); err != nil || matched {
				t.Fatalf("identity mismatch accepted: %t %v", matched, err)
			}
		})
	}
	run := func(work func() error) <-chan error {
		result := make(chan error, 1)
		done := make(chan struct{})
		finished = append(finished, done)
		go func() { defer close(done); result <- work() }()
		return result
	}
	hold := func() (<-chan struct{}, func()) {
		ready := make(chan struct{})
		var once sync.Once
		release := func() { once.Do(func() { close(ready) }) }
		releases = append(releases, release)
		return ready, release
	}
	awaitPID := func(ready <-chan uint32, result <-chan error) uint32 {
		select {
		case pid := <-ready:
			return pid
		case err := <-result:
			t.Fatalf("startup transaction finished before its lock barrier: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		return 0
	}
	awaitResult := func(result <-chan error) {
		select {
		case err := <-result:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	grant := func(generation, instance string, ready chan<- uint32, release <-chan struct{}) error {
		completion, err := db.WriteSession(ctx, func(scope SessionScope) error {
			dao := scope.SessionDAO()
			if _, err := dao.LockTask(ctx, project.ID, target.ID); err != nil {
				return err
			}
			if _, err := dao.SessionBotID(ctx, report.SessionID); err != nil {
				return err
			}
			record, err := dao.LockSession(ctx, report.SessionID)
			if err != nil {
				return err
			}
			if err := dao.SetSessionGenerationStop(ctx, report.SessionID, []byte(`{"kind":"stopped"}`)); err != nil {
				return err
			}
			record.Snapshot.ExecutionGeneration, record.Snapshot.Identity.ControllerInstanceID = generation, instance
			if err := dao.SaveSession(ctx, record); err != nil {
				return err
			}
			if ready != nil {
				var pid uint32
				if err := scope.(*sessionScope).tx.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
					return err
				}
				ready <- pid
				select {
				case <-release:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			return nil
		})
		if err == nil && completion.Outcome != TransactionCommitted {
			return fmt.Errorf("generation grant did not commit: %s", completion.Outcome)
		}
		return err
	}
	newer := report
	newer.Revision = "3"
	newerBytes, err := json.Marshal(newer)
	if err != nil {
		t.Fatal(err)
	}
	reportReady := make(chan uint32, 1)
	reportHold, releaseReport := hold()
	reportResult := run(func() error {
		completion, err := db.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
			current, err := scope.TaskDAO().Task(ctx, target.ID)
			if err != nil {
				return err
			}
			matched, err := scope.SessionDAO().MatchSessionStartup(ctx, target.ID, &updatedWorker, newer)
			if err != nil {
				return err
			}
			if !matched {
				return errors.New("report lost its current generation before lock")
			}
			values := taskPropertyWriteValues(current)
			values.Properties = taskproperties.Clone(current.Properties)
			values.Properties["sessionStartup"] = newerBytes
			if _, err := scope.TaskDAO().UpdateTask(ctx, target.ID, values); err != nil {
				return err
			}
			var pid uint32
			if err := scope.(*ProjectTx).tx.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
				return err
			}
			reportReady <- pid
			select {
			case <-reportHold:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		})
		if err == nil && completion.Outcome != TransactionCommitted {
			return fmt.Errorf("report did not commit: %s", completion.Outcome)
		}
		return err
	})
	reportPID := awaitPID(reportReady, reportResult)
	generationThreeInstance := uuid.NewString()
	grantResult := run(func() error { return grant("3", generationThreeInstance, nil, nil) })
	if err := waitForStartupTaskLock(ctx, db, reportPID); err != nil {
		t.Fatal(err)
	}
	releaseReport()
	awaitResult(reportResult)
	awaitResult(grantResult)
	afterReport := snapshotTask(t, db, project.ID, target.ID)
	if afterReport.Version != persisted.Version+1 {
		t.Fatal("generation grant changed Task version independently of the report")
	}
	if matched, err := check(ctx, updatedWorker, newer); err != nil || matched {
		t.Fatalf("committed generation switch accepted old report: %t %v", matched, err)
	}
	oldGeneration := newer
	oldGeneration.ExecutionGeneration, oldGeneration.ControllerInstanceID = "3", generationThreeInstance
	if matched, err := check(ctx, updatedWorker, oldGeneration); err != nil || !matched {
		t.Fatalf("new generation identity was not valid before its lock wait: %t %v", matched, err)
	}
	grantReady := make(chan uint32, 1)
	grantHold, releaseGrant := hold()
	generationFourInstance := uuid.NewString()
	grantResult = run(func() error { return grant("4", generationFourInstance, grantReady, grantHold) })
	grantPID := awaitPID(grantReady, grantResult)
	reportResult = run(func() error {
		matched, err := check(ctx, updatedWorker, oldGeneration)
		if err == nil && matched {
			return errors.New("startup matcher did not recheck generation after the Task lock wait")
		}
		return err
	})
	if err := waitForStartupTaskLock(ctx, db, grantPID); err != nil {
		t.Fatal(err)
	}
	releaseGrant()
	awaitResult(grantResult)
	awaitResult(reportResult)
	if !reflect.DeepEqual(snapshotTask(t, db, project.ID, target.ID), afterReport) {
		t.Fatal("generation advance or refused old report changed committed Task properties")
	}
	currentReport := newer
	currentReport.ExecutionGeneration, currentReport.ControllerInstanceID = "4", generationFourInstance
	if matched, err := check(ctx, updatedWorker, currentReport); err != nil || !matched {
		t.Fatalf("current identity was not valid before archiving: %t %v", matched, err)
	}
	mustQueryExec(t, db, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{lifecycle}','"archived"') WHERE id=$1`, report.SessionID)
	if matched, err := check(ctx, updatedWorker, currentReport); err != nil || matched {
		t.Fatalf("archived session accepted: %t %v", matched, err)
	}
	mustQueryExec(t, db, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{lifecycle}','"active"') WHERE id=$1`, report.SessionID)
	fresh := updatedWorker
	fresh.ClaimID, fresh.WorktreeID, fresh.Phase = uuid.NewString(), uuid.NewString(), model.WorkerPreparing
	completion, err = db.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
		current, err := scope.TaskDAO().Task(ctx, target.ID)
		if err != nil {
			return err
		}
		values := taskPropertyWriteValues(current)
		values.Properties = fixtureTaskProperties(t, &fresh)
		_, err = scope.TaskDAO().UpdateTask(ctx, target.ID, values)
		return err
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("fresh claim commit: %+v %v", completion, err)
	}
	freshTask := snapshotTask(t, db, project.ID, target.ID)
	if _, exists := freshTask.Properties["sessionStartup"]; exists || !reflect.DeepEqual(fixtureWorker(t, freshTask.Properties), &fresh) {
		t.Fatal("fresh claim did not clear committed startup evidence")
	}
	if matched, err := check(ctx, fresh, currentReport); err != nil || matched {
		t.Fatalf("fresh claim matched historical Session: %t %v", matched, err)
	}
	mustQueryExec(t, db, `UPDATE task_sessions SET snapshot='[]' WHERE id=$1`, report.SessionID)
	if _, err := check(ctx, updatedWorker, currentReport); err == nil {
		t.Fatal("corrupt persisted identity accepted")
	}
	canceled, cancelCheck := context.WithCancel(ctx)
	cancelCheck()
	if _, err := check(canceled, updatedWorker, currentReport); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled identity check lost its cause: %v", err)
	}
}
