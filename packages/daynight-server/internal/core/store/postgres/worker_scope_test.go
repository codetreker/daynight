package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	tagcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/tag"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var workerSnapshotFixture = testutil.WorkerSnapshotFixture
var workerStoredUTF8 = testutil.WorkerStoredUTF8
var putWorkerSnapshot = testutil.PutWorkerSnapshot
var readWorkerSnapshot = testutil.ReadWorkerSnapshot
var writeWorkerForTest = testutil.WriteWorker
var storeWorkerConfiguration = testutil.WorkerConfiguration
var sentinelConfigurationRollback = errors.New("intentional configuration transaction rollback")

func setSnapshotTaskClaim(t *testing.T, database *Store, projectID string, taskNumber int, owner, workerID string) model.WorkerTaskReference {
	t.Helper()
	return testutil.SetSnapshotTaskClaim(t, database.Pool, database, projectID, taskNumber, owner, workerID)
}

func TestWorkerSnapshotErrorsRollbackAndPreserveCauses(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	stamp := time.Date(2026, 10, 29, 1, 0, 0, 0, time.UTC)
	worker := workerSnapshotFixture(queryID(1), queryID(2), stamp)
	want := errors.New("observation unavailable")
	err := writeWorkerForTest(database, ctx, func(tx WorkerScope) error {
		if _, err := tx.WorkerDAO().UpsertWorker(ctx, worker); err != nil {
			return err
		}
		return want
	})
	if !errors.Is(err, want) {
		t.Fatalf("write did not preserve callback cause: %v", err)
	}
	var count int
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM workers`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed worker transaction committed: %d %v", count, err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if err := writeWorkerForTest(database, canceled, func(WorkerScope) error { t.Error("canceled transaction entered"); return nil }); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled transaction: %v", err)
	}

}

func TestWorkerConfigurationStoreFailuresRetainCauses(t *testing.T) {
	parallelRootDatabaseTest(t)
	ctx := context.Background()
	database := isolatedStore(t)
	userID, workerID := queryID(1), queryID(2)
	worker := putWorkerSnapshot(t, database, workerSnapshotFixture(userID, workerID, time.Now().UTC()))
	if err := writeWorkerForTest(database, ctx, func(tx WorkerScope) error {
		_, err := tx.WorkerDAO().SetWorkerConfiguration(ctx, userID, workerID, 1, storeWorkerConfiguration())
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := database.Pool.QueryRow(ctx, `SELECT row_to_json(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2`, userID, workerID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	for _, operation := range []func(WorkerWriteDAO) error{
		func(dao WorkerWriteDAO) error {
			bad := storeWorkerConfiguration()
			bad.Projects = append(bad.Projects, model.WorkerProjectConfiguration{ProjectID: queryID(3), NativeOverrides: map[string]json.RawMessage{"args": json.RawMessage(`invalid`)}})
			_, err := dao.SetWorkerConfiguration(ctx, userID, workerID, 2, bad)
			return err
		},
		func(dao WorkerWriteDAO) error {
			observation := model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{{AppliedValue: json.RawMessage(`invalid`)}}}
			return dao.SetWorkerConfigurationObservation(ctx, userID, workerID, 1, observation)
		},
	} {
		var encodingFailure error
		completion, err := database.WriteWorker(ctx, func(tx WorkerScope) error {
			updated := worker
			updated.LastReportedAt = worker.LastReportedAt.Add(time.Second)
			updated.Telemetry.Machine.Name = "Uncommitted replacement"
			written, err := tx.WorkerDAO().UpsertWorker(ctx, updated)
			if err != nil {
				return err
			}
			if written.Telemetry.Machine.Name != updated.Telemetry.Machine.Name {
				t.Fatal("configuration failure did not follow the actual telemetry write")
			}
			encodingFailure = operation(tx.WorkerDAO())
			return encodingFailure
		})
		var after string
		if readErr := database.Pool.QueryRow(ctx, `SELECT row_to_json(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2`, userID, workerID).Scan(&after); readErr != nil {
			t.Fatal(readErr)
		}
		if encodingFailure == nil || !errors.Is(err, encodingFailure) || completion.Outcome != TransactionNotCommitted || before != after {
			t.Fatalf("encoding failure lost its cause or partially committed telemetry/configuration: %+v %v", completion, err)
		}
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		if err := snapshot.(*Snapshot).tx.Rollback(ctx); err != nil {
			return err
		}
		_, err := snapshot.WorkerDAO().WorkerConfiguration(ctx, userID, workerID)
		if !errors.Is(err, pgx.ErrTxClosed) {
			t.Fatalf("closed read failure lost: %v", err)
		}
		return sentinelConfigurationRollback
	}); !errors.Is(err, sentinelConfigurationRollback) {
		t.Fatalf("read operation error lost: %v", err)
	}
}

func admissionCompletionRows(t *testing.T, database *Store, ctx context.Context, owner string) string {
	t.Helper()
	var rows string
	if err := database.Pool.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY worker_id),'[]'::jsonb)::text FROM workers w WHERE user_id=$1`, owner).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	return rows
}

func admissionCompletionSeed(t *testing.T, database *Store, ctx context.Context, owner, id string) model.WorkerSnapshot {
	t.Helper()
	var saved model.WorkerSnapshot
	completion, err := database.WriteWorker(ctx, func(scope WorkerScope) error {
		admission, err := scope.AdmitWorker(ctx, owner, id, 120*time.Second)
		if err != nil {
			return err
		}
		value := workerSnapshotFixture(owner, id, admission.ObservedAt)
		value.Telemetry.SampledAt = admission.ObservedAt.Add(24 * time.Hour)
		saved, err = scope.WorkerDAO().UpsertWorker(ctx, value)
		if err != nil {
			return err
		}
		if _, err := scope.WorkerDAO().SetWorkerConfiguration(ctx, owner, id, 1, storeWorkerConfiguration()); err != nil {
			return err
		}
		return scope.WorkerDAO().SetWorkerConfigurationObservation(ctx, owner, id, 1, model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{}})
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("seed Worker transaction: %+v %v", completion, err)
	}
	return saved
}

func TestWorkerAdmissionCompletionClockRollbackAndSQLFailure(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	owner, id := uuid.NewString(), uuid.NewString()
	initial := admissionCompletionSeed(t, database, ctx, owner, id)
	if _, err := database.Pool.Exec(ctx, `UPDATE workers SET last_seen_at=statement_timestamp()+interval '1 hour' WHERE user_id=$1 AND worker_id=$2`, owner, id); err != nil {
		t.Fatal(err)
	}
	var stored model.WorkerSnapshot
	var admission WorkerAdmission
	var afterWrite time.Time
	completion, err := database.WriteWorker(ctx, func(scope WorkerScope) error {
		var err error
		admission, err = scope.AdmitWorker(ctx, owner, id, 120*time.Second)
		if err != nil {
			return err
		}
		if admission.ActiveCount != 0 || admission.LastSeenAt == nil || !admission.LastSeenAt.After(admission.ObservedAt) {
			t.Errorf("future target counted as active: %+v", admission)
		}
		updated := initial
		updated.LastReportedAt = admission.ObservedAt
		updated.Telemetry.Machine.Name = "Database-clock report"
		stored, err = scope.WorkerDAO().UpsertWorker(ctx, updated)
		if err != nil {
			return err
		}
		afterWrite, err = scope.ObservedAt(ctx)
		return err
	})
	if err != nil || completion.Outcome != TransactionCommitted || !stored.LastReportedAt.Equal(admission.ObservedAt) || afterWrite.Before(stored.LastReportedAt) || afterWrite.Sub(stored.LastReportedAt) > 10*time.Second || !stored.Telemetry.SampledAt.After(stored.LastReportedAt) {
		t.Fatalf("database clock was not persisted: %+v stored=%+v observed=%v err=%v", completion, stored, afterWrite, err)
	}
	stored.Alias = model.WorkerAlias{Version: 1}
	if actual := readWorkerSnapshot(t, database, owner, id, afterWrite); !reflect.DeepEqual(actual, stored) {
		t.Fatalf("future timestamp repair did not persist: got=%+v want=%+v", actual, stored)
	}

	before := admissionCompletionRows(t, database, ctx, owner)
	refusal := &model.Fault{Code: "not_found", Message: "Configuration Project was not found.", Cause: model.ErrNotFound}
	newID := uuid.NewString()
	completion, err = database.WriteWorker(ctx, func(scope WorkerScope) error {
		admission, err := scope.AdmitWorker(ctx, owner, newID, 120*time.Second)
		if err != nil {
			return err
		}
		if _, err := scope.WorkerDAO().UpsertWorker(ctx, workerSnapshotFixture(owner, newID, admission.ObservedAt)); err != nil {
			return err
		}
		return refusal
	})
	if completion.Outcome != TransactionNotCommitted || !errors.Is(err, refusal) || !errors.Is(err, model.ErrNotFound) || admissionCompletionRows(t, database, ctx, owner) != before {
		t.Fatalf("callback refusal committed a partial report: %+v %v", completion, err)
	}
	admissionCompletionSeed(t, database, ctx, owner, newID)
	before = admissionCompletionRows(t, database, ctx, owner)
	if _, err := database.Pool.Exec(ctx, `ALTER TABLE workers RENAME COLUMN last_seen_at TO unavailable_last_seen_at`); err != nil {
		t.Fatal(err)
	}
	restored := false
	t.Cleanup(func() {
		if !restored {
			cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			if _, err := database.Pool.Exec(cleanup, `ALTER TABLE workers RENAME COLUMN unavailable_last_seen_at TO last_seen_at`); err != nil {
				t.Errorf("restore Worker timestamp column: %v", err)
			}
		}
	})
	completion, admissionErr := database.WriteWorker(ctx, func(scope WorkerScope) error {
		_, err := scope.AdmitWorker(ctx, owner, id, 120*time.Second)
		return err
	})
	if _, err := database.Pool.Exec(ctx, `ALTER TABLE workers RENAME COLUMN unavailable_last_seen_at TO last_seen_at`); err != nil {
		t.Fatal(err)
	}
	restored = true
	var driver *pgconn.PgError
	if completion.Outcome != TransactionNotCommitted || !errors.As(admissionErr, &driver) || driver.Code != "42703" || admissionCompletionRows(t, database, ctx, owner) != before {
		t.Fatalf("failed admission changed rows or lost SQL cause: %+v %v", completion, admissionErr)
	}
	completion, err = database.WriteWorker(ctx, func(scope WorkerScope) error {
		admission, err := scope.AdmitWorker(ctx, owner, id, 120*time.Second)
		if err != nil {
			return err
		}
		updated := stored
		updated.LastReportedAt = admission.ObservedAt
		updated.Telemetry.Machine.Name = "Recovered after SQL failure"
		stored, err = scope.WorkerDAO().UpsertWorker(ctx, updated)
		return err
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("SQL failure retained its admission lock: %+v %v", completion, err)
	}
	stored.Alias = model.WorkerAlias{Version: 1}
	if actual := readWorkerSnapshot(t, database, owner, id, stored.LastReportedAt); !reflect.DeepEqual(actual, stored) {
		t.Fatalf("recovered report did not persist: got=%+v want=%+v", actual, stored)
	}
}

func admissionCompletionLock(t *testing.T, database *Store, ctx context.Context, owner string) pgx.Tx {
	t.Helper()
	tx, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tx.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Errorf("release admission holder: %v", err)
		}
	})
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('worker-admission:' || $1::uuid::text, 0))`, owner); err != nil {
		t.Fatal(err)
	}
	return tx
}

func admissionCompletionWait(t *testing.T, database *Store, ctx context.Context, holder pgx.Tx, done <-chan struct{}) {
	t.Helper()
	for {
		var blocked bool
		if err := database.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=current_schema() AND $1=ANY(pg_blocking_pids(pid)))`, holder.Conn().PgConn().PID()).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		select {
		case <-done:
			t.Fatal("Worker transaction completed before the owner lock was released")
		case <-ctx.Done():
			t.Fatal("Worker transaction did not wait for the owner lock")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestWorkerAdmissionCompletionWaitResamplesAndCancellationReleasesLock(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	owner, active, added := uuid.NewString(), uuid.NewString(), uuid.NewString()
	initial := admissionCompletionSeed(t, database, ctx, owner, active)
	if _, err := database.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot)
 SELECT user_id,gen_random_uuid(),created_at,last_seen_at,telemetry,task_snapshot
 FROM workers CROSS JOIN generate_series(1,99) WHERE user_id=$1 AND worker_id=$2`, owner, active); err != nil {
		t.Fatal(err)
	}
	holder := admissionCompletionLock(t, database, ctx, owner)
	type result struct {
		completion Completion
		admission  WorkerAdmission
		stored     model.WorkerSnapshot
		err        error
	}
	out, done := make(chan result, 1), make(chan struct{})
	go func() {
		var value result
		value.completion, value.err = database.WriteWorker(ctx, func(scope WorkerScope) error {
			var err error
			value.admission, err = scope.AdmitWorker(ctx, strings.ToUpper(owner), added, 120*time.Second)
			if err != nil {
				return err
			}
			value.stored, err = scope.WorkerDAO().UpsertWorker(ctx, workerSnapshotFixture(owner, added, value.admission.ObservedAt))
			return err
		})
		out <- value
		close(done)
	}()
	received := false
	t.Cleanup(func() {
		cancel()
		if !received {
			select {
			case <-out:
			case <-time.After(5 * time.Second):
				t.Error("waiting Worker transaction did not exit")
			}
		}
	})
	admissionCompletionWait(t, database, ctx, holder, done)
	admissionCompletionSeed(t, database, ctx, uuid.NewString(), uuid.NewString())
	var fixtureAt time.Time
	if err := database.Pool.QueryRow(ctx, `UPDATE workers SET last_seen_at=statement_timestamp()-interval '121 seconds' WHERE user_id=$1 AND worker_id=$2 RETURNING statement_timestamp()`, owner, active).Scan(&fixtureAt); err != nil {
		t.Fatal(err)
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	written := <-out
	received = true
	if written.err != nil || written.completion.Outcome != TransactionCommitted || written.admission.ActiveCount != 99 || !written.admission.ObservedAt.After(fixtureAt) || !written.stored.LastReportedAt.Equal(written.admission.ObservedAt) {
		t.Fatalf("waiting transaction did not resample after lock: %+v", written)
	}
	written.stored.Alias = model.WorkerAlias{Version: 1}
	if actual := readWorkerSnapshot(t, database, owner, added, written.admission.ObservedAt); !reflect.DeepEqual(actual, written.stored) {
		t.Fatalf("waiting report did not persist: got=%+v want=%+v", actual, written.stored)
	}

	holder = admissionCompletionLock(t, database, ctx, owner)
	before := admissionCompletionRows(t, database, ctx, owner)
	canceled, stop := context.WithCancel(ctx)
	defer stop()
	cancelOut, cancelDone := make(chan result, 1), make(chan struct{})
	go func() {
		var value result
		value.completion, value.err = database.WriteWorker(canceled, func(scope WorkerScope) error {
			var err error
			value.admission, err = scope.AdmitWorker(canceled, owner, active, 120*time.Second)
			if err != nil {
				return err
			}
			initial.LastReportedAt = value.admission.ObservedAt
			value.stored, err = scope.WorkerDAO().UpsertWorker(canceled, initial)
			return err
		})
		cancelOut <- value
		close(cancelDone)
	}()
	cancelReceived := false
	t.Cleanup(func() {
		stop()
		if !cancelReceived {
			select {
			case <-cancelOut:
			case <-time.After(5 * time.Second):
				t.Error("canceled Worker transaction did not exit")
			}
		}
	})
	admissionCompletionWait(t, database, ctx, holder, cancelDone)
	stop()
	canceledResult := <-cancelOut
	cancelReceived = true
	var cancellation *TransactionError
	if !errors.Is(canceledResult.err, context.Canceled) || !errors.As(canceledResult.err, &cancellation) || cancellation.CommitAttempted || canceledResult.completion.Outcome != cancellation.Outcome {
		t.Fatalf("lock-wait cancellation lost its completion facts: %+v", canceledResult)
	}
	if cancellation.CleanupFailed {
		if cancellation.Phase != "cleanup" || canceledResult.completion.Outcome != TransactionUnknown {
			t.Fatalf("failed cleanup manufactured a confirmed rollback: %+v", canceledResult)
		}
	} else if cancellation.Phase != "operation" || canceledResult.completion.Outcome != TransactionNotCommitted {
		t.Fatalf("successful rollback lost its completion: %+v", canceledResult)
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if after := admissionCompletionRows(t, database, ctx, owner); after != before {
		t.Fatal("canceled admission changed Worker rows")
	}
	var updated model.WorkerSnapshot
	completion, err := database.WriteWorker(ctx, func(scope WorkerScope) error {
		admission, err := scope.AdmitWorker(ctx, owner, added, 120*time.Second)
		if err != nil {
			return err
		}
		if admission.ActiveCount != 100 || admission.LastSeenAt == nil || !admission.LastSeenAt.Equal(written.stored.LastReportedAt) {
			t.Errorf("later transaction lost committed count or target: %+v", admission)
		}
		next := written.stored
		next.LastReportedAt = admission.ObservedAt
		next.Telemetry.Machine.Name = "Active report after cancellation"
		updated, err = scope.WorkerDAO().UpsertWorker(ctx, next)
		return err
	})
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("cancellation retained the owner lock: %+v %v", completion, err)
	}
	updated.Alias = model.WorkerAlias{Version: 1}
	if actual := readWorkerSnapshot(t, database, owner, added, updated.LastReportedAt); !reflect.DeepEqual(actual, updated) {
		t.Fatalf("active report at capacity did not persist: got=%+v want=%+v", actual, updated)
	}
}

type claimTagBarrierStore struct {
	*Store
	acquired chan struct{}
	proceed  chan struct{}
}
type claimTagBarrierScope struct {
	ProjectWriteScope
	acquired chan struct{}
	proceed  chan struct{}
}
type claimTagBarrierDAO struct {
	WorkerClaimAdmissionDAO
	acquired chan struct{}
	proceed  chan struct{}
}

func (s *claimTagBarrierStore) WriteProject(ctx context.Context, project string, operation func(ProjectWriteScope) error) (Completion, error) {
	return s.Store.WriteProject(ctx, project, func(scope ProjectWriteScope) error {
		return operation(claimTagBarrierScope{scope, s.acquired, s.proceed})
	})
}
func (s claimTagBarrierScope) WorkerClaimAdmissionDAO() WorkerClaimAdmissionDAO {
	return claimTagBarrierDAO{s.ProjectWriteScope.WorkerClaimAdmissionDAO(), s.acquired, s.proceed}
}
func (d claimTagBarrierDAO) ClaimWorkerConfiguration(ctx context.Context, user, worker string) (*model.WorkerDesiredConfiguration, error) {
	value, err := d.WorkerClaimAdmissionDAO.ClaimWorkerConfiguration(ctx, user, worker)
	if err != nil {
		return nil, err
	}
	close(d.acquired)
	select {
	case <-d.proceed:
		return value, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func TestWorkerClaimTagFilterLinearizesWithConfiguration(t *testing.T) {
	for _, first := range []string{"configuration", "claim"} {
		t.Run(first, func(t *testing.T) {
			s, principal, _, project := membershipFixture(t)
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			workerID := uuid.NewString()
			testutil.PutWorkerSnapshot(t, s, testutil.WorkerSnapshotFixture(principal.UserID, workerID, time.Now().UTC()))
			oldRaw := `{"taskTagFilter":{"names":["backend"],"match":"any"},"other":"future"}`
			newRaw := `{"taskTagFilter":{"names":["urgent"],"match":"any"},"other":"future"}`
			mustQueryExec(t, s, `UPDATE workers SET desired_configuration=$3::jsonb,configuration_revision=1,configuration_updated_at=now() WHERE user_id=$1 AND worker_id=$2`, principal.UserID, workerID, oldRaw)
			current := queryTask(t, s, project.ID, 501, model.TaskTodo)
			tagID := uuid.NewString()
			mustQueryExec(t, s, `INSERT INTO project_tags(id,project_id,name,name_key,created_at,updated_at) VALUES($1,$2,'Backend','backend',now(),now())`, tagID, project.ID)
			mustQueryExec(t, s, `INSERT INTO task_tags(project_id,task_id,tag_id) VALUES($1,$2,$3)`, project.ID, current.ID, tagID)
			mustQueryExec(t, s, `UPDATE tasks SET assigned_to=$2,allow_agents=true WHERE id=$1`, current.ID, principal.UserID)
			current = snapshotTask(t, s, project.ID, current.ID)
			key, err := tagcore.NameFilterDigest(model.TagNameFilter{Names: []string{"backend"}, Match: "any"})
			if err != nil {
				t.Fatal(err)
			}
			descriptor := taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: workerID, Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString()}
			claim := func(db interface {
				SnapshotReader
				ProjectWriter
			}) (model.Task, error) {
				return taskservice.NewTasks(db).ClaimWorker(ctx, principal, project.ID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor, TaskTagFilterKey: &key})
			}
			tx, err := s.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			if first == "configuration" {
				if _, err = tx.Exec(ctx, `UPDATE workers SET desired_configuration=$3::jsonb,configuration_revision=2,configuration_updated_at=now() WHERE user_id=$1 AND worker_id=$2`, principal.UserID, workerID, newRaw); err != nil {
					t.Fatal(err)
				}
				type result struct {
					task model.Task
					err  error
				}
				done := make(chan result, 1)
				go func() { task, err := claim(s); done <- result{task, err} }()
				// Wait until the claim is blocked by this exact transaction, then commit it.
				for {
					var blocked bool
					err = s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE '%SELECT configuration_revision,configuration_updated_at,desired_configuration%')`, int32(tx.Conn().PgConn().PID())).Scan(&blocked)
					if err != nil {
						t.Fatal(err)
					}
					if blocked {
						break
					}
					select {
					case <-ctx.Done():
						t.Fatal("claim did not wait for configuration lock")
					case <-time.After(10 * time.Millisecond):
					}
				}
				if err = tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				res := <-done
				var fault *model.Fault
				if !errors.As(res.err, &fault) || fault.Code != "claim_conflict" {
					t.Fatalf("old proof: %+v %v", res.task, res.err)
				}
				if got := snapshotTask(t, s, project.ID, current.ID); got.Status != model.TaskTodo || got.Version != current.Version {
					t.Fatalf("refusal wrote task: %+v", got)
				}
			} else {
				barrier := &claimTagBarrierStore{Store: s, acquired: make(chan struct{}), proceed: make(chan struct{})}
				type result struct {
					task model.Task
					err  error
				}
				done := make(chan result, 1)
				go func() { task, err := claim(barrier); done <- result{task, err} }()
				select {
				case <-barrier.acquired:
				case <-ctx.Done():
					t.Fatal("claim did not acquire Worker lock")
				}
				update := make(chan error, 1)
				go func() {
					_, err := tx.Exec(ctx, `UPDATE workers SET desired_configuration=$3::jsonb,configuration_revision=2,configuration_updated_at=now() WHERE user_id=$1 AND worker_id=$2`, principal.UserID, workerID, newRaw)
					update <- err
				}()
				testutil.WaitThreadBackendLock(t, s.Pool, tx.Conn().PgConn().PID())
				close(barrier.proceed)
				res := <-done
				if res.err != nil || res.task.Status != model.TaskInProgress {
					t.Fatalf("claim before configuration: %+v %v", res.task, res.err)
				}
				if err = <-update; err != nil {
					t.Fatal(err)
				}
				if err = tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				got := snapshotTask(t, s, project.ID, current.ID)
				if got.Status != model.TaskInProgress || got.Version != current.Version+1 {
					t.Fatalf("claim lost after configuration: %+v", got)
				}
				var raw []byte
				if err = s.Pool.QueryRow(ctx, `SELECT desired_configuration FROM workers WHERE user_id=$1 AND worker_id=$2`, principal.UserID, workerID).Scan(&raw); err != nil {
					t.Fatal(err)
				}
				var v map[string]json.RawMessage
				if err = json.Unmarshal(raw, &v); err != nil || string(v["taskTagFilter"]) == "" {
					t.Fatal(fmt.Errorf("target unreadable: %w", err))
				}
			}
		})
	}
}

// A stored exact-limit configuration may include the additional canonical empty
// filter member while a legacy PUT still omits that field.
func TestWorkerTaskTagFilterCapacityAndLegacyPut(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 90*time.Second)
	defer cancel()
	db := isolatedStore(t)
	pool := db.Pool
	user, id := queryID(1), queryID(2)
	putWorkerSnapshot(t, db, workerSnapshotFixture(user, id, time.Now().UTC()))
	value := model.WorkerConfiguration{PlatformTaskMode: model.PlatformTaskAll, MaxConcurrent: 1, PollIntervalMs: 60000, RecoveryLimit: 3, Native: model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}}, Projects: make([]model.WorkerProjectConfiguration, 128)}
	args := make([][]string, 128)
	for i := range value.Projects {
		args[i] = make([]string, 8)
		for j := range args[i] {
			args[i][j] = strings.Repeat("x", 4096)
		}
		value.Projects[i] = model.WorkerProjectConfiguration{ProjectID: queryID(100 + i), NativeOverrides: map[string]json.RawMessage{}}
	}
	encode := func() []byte {
		t.Helper()
		for i := range value.Projects {
			b, err := json.Marshal(args[i])
			if err != nil {
				t.Fatal(err)
			}
			value.Projects[i].NativeOverrides["args"] = b
		}
		b, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	raw := encode()
	excess := len(raw) - workercore.MaxConfigurationJSONBytes
	if excess <= 0 {
		t.Fatalf("fixture did not exceed budget: %d", len(raw))
	}
	for i := len(args) - 1; i >= 0 && excess > 0; i-- {
		for j := len(args[i]) - 1; j >= 0 && excess > 0; j-- {
			trim := min(excess, len(args[i][j])-1)
			args[i][j] = args[i][j][:len(args[i][j])-trim]
			excess -= trim
		}
	}
	raw = encode()
	if excess != 0 || len(raw) != workercore.MaxConfigurationJSONBytes {
		t.Fatalf("fixture length=%d remainder=%d", len(raw), excess)
	}
	if _, err := workercore.ParseWorkerConfiguration(raw); err != nil {
		t.Fatalf("legacy exact-limit input: %v", err)
	}
	mustQueryExec(t, db, `UPDATE workers SET configuration_revision=2,configuration_updated_at=now(),
		desired_configuration=$3::text::jsonb || '{"taskTagFilter":{"names":[],"match":"any"}}'::jsonb WHERE user_id=$1 AND worker_id=$2`, user, id, string(raw))
	read := func() model.WorkerConfigurationResource {
		t.Helper()
		var result model.WorkerConfigurationResource
		if err := db.ReadSnapshot(ctx, func(s SnapshotScope) error {
			var err error
			result, err = s.WorkerDAO().WorkerConfiguration(ctx, user, id)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return result
	}
	observed := read()
	if observed.Desired == nil || !observed.Desired.ValueValid || observed.Desired.Revision != "2" || observed.Desired.Value.TaskTagFilter == nil || len(observed.Desired.Value.TaskTagFilter.Names) != 0 {
		t.Fatal("stored target was not readable with canonical empty filter")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(observed.Desired.Raw, &fields); err != nil {
		t.Fatal(err)
	}
	compact, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	if len(compact) != workercore.MaxConfigurationJSONBytes+int(workerprotocol.EmptyTaskTagFilterMemberBytes) {
		t.Fatalf("stored size=%d", len(compact))
	}
	old, err := workercore.ParseWorkerConfigurationProtocol(raw, workerprotocol.Capabilities{ToolPaths: true, PlatformTaskMode: true})
	if err != nil {
		t.Fatal(err)
	}
	old.MaxConcurrent = 2
	var result model.WorkerConfigurationResource
	completion, err := db.WriteWorker(ctx, func(s WorkerScope) error {
		var err error
		result, err = workercore.PutConfiguration(ctx, s.WorkerDAO(), model.Principal{UserID: user}, id, 2, old)
		return err
	})
	if err != nil || completion.Outcome != TransactionCommitted || result.Desired.Revision != "3" {
		t.Fatalf("legacy PUT: %+v %v", completion, err)
	}
	after := read()
	if after.Desired.Revision != "3" || after.Desired.Value.MaxConcurrent != 2 || after.Desired.Value.TaskTagFilter == nil || len(after.Desired.Value.TaskTagFilter.Names) != 0 {
		t.Fatal("legacy PUT lost empty field or edit")
	}

	// A supported Worker cannot expand a full target with a nonempty filter.
	if _, err := pool.Exec(ctx, `UPDATE workers SET configuration_observation_revision=1, configuration_observation=$3 WHERE user_id=$1 AND worker_id=$2`, user, id, `{"baseRevision":"0","desiredRevision":"3","items":[{"key":{"kind":"taskTagFilter"},"targetRevision":"3","appliedValue":null,"state":"pending","error":null,"lastFailure":null,"nextAttemptAt":null}],"reportedAt":"2026-01-01T00:00:00Z"}`); err != nil {
		t.Fatal(err)
	}
	tooLarge := after.Desired.Value
	tooLarge.TaskTagFilter = &model.TagNameFilter{Names: []string{"backend"}, Match: "any"}
	completion, err = db.WriteWorker(ctx, func(s WorkerScope) error {
		_, e := workercore.PutConfiguration(ctx, s.WorkerDAO(), model.Principal{UserID: user}, id, 3, tooLarge)
		return e
	})
	var fault *model.Fault
	if err == nil || completion.Outcome != TransactionNotCommitted || !errors.As(err, &fault) {
		t.Fatalf("oversized nonempty filter was not refused: %+v %v", completion, err)
	}
	unchanged := read()
	if unchanged.Desired.Revision != "3" || unchanged.Desired.Value.TaskTagFilter == nil || len(unchanged.Desired.Value.TaskTagFilter.Names) != 0 {
		t.Fatal("failed expansion changed target")
	}
	if got := fmt.Sprint(fault.Code); got != "limit_exceeded" && got != "invalid_input" {
		t.Fatalf("unexpected fault: %s %v", got, err)
	}
}
