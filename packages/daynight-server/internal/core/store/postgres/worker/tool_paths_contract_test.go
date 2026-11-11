package worker_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	pgworker "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/worker"
)

func toolChoice(path string) *model.ToolPathChoice {
	return &model.ToolPathChoice{Kind: "path", Path: path}
}
func toolStoredObservation(stamp time.Time) *model.ToolPathTelemetry {
	count := int64(1)
	revision := "8"
	actual := model.ToolPathActual{Selection: *toolChoice("/opt/工具<&/codex"), SelectionKey: strings.Repeat("a", 64), EntryPath: "/opt/工具<&/codex", ExecutablePath: "/opt/native/codex", InterpreterPath: nil, Source: "explicit", Version: "1.2.3", CheckedAt: stamp}
	candidate := actual
	candidate.SelectionKey = strings.Repeat("b", 64)
	candidate.Selection = *toolChoice("/candidate/codex")
	candidate.EntryPath = "/candidate/codex"
	reason := "active_instance"
	return &model.ToolPathTelemetry{SchemaVersion: 1, ObservedAt: stamp, Entries: []model.ToolPathObservation{{Tool: "codex", Context: "web", ConfigurationSource: "cloud", TargetRevision: &revision, Target: candidate.Selection, State: "pending", Reason: &reason, Actual: &actual, Candidate: &candidate, ActiveSelectionCount: &count, ActiveSelectionsComplete: true, ActiveSelections: []model.ToolPathActiveSelection{{Actual: actual, ExecutionCount: &count, InstanceCount: nil, UnconfirmedCount: 0}}}}}
}

func TestWorkerToolPathsJSONBRoundtripLegacyAndRollback(t *testing.T) {
	database := workerStorage(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user, id := testutil.QueryID(1), testutil.QueryID(2)
	stamp := time.Now().UTC().Truncate(time.Microsecond)
	original := testutil.PutWorkerSnapshot(t, database, testutil.WorkerSnapshotFixture(user, id, stamp))
	value := testutil.WorkerConfiguration()
	if err := testutil.WriteWorker(database, ctx, func(s store.WorkerScope) error {
		_, err := s.WorkerDAO().SetWorkerConfiguration(ctx, user, id, 7, value)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE workers SET desired_configuration=desired_configuration-'toolPaths' WHERE user_id=$1 AND worker_id=$2`, user, id); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
		got, err := s.WorkerDAO().WorkerConfiguration(ctx, user, id)
		if err == nil && got.Desired.Value.ToolPaths != (model.WorkerToolPaths{}) {
			t.Fatal("legacy choices invented")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	value.ToolPaths = model.WorkerToolPaths{Codex: toolChoice("/opt/工具<&/codex"), Copilot: toolChoice(`\\?\C:\tools\copilot.exe`)}
	updated := original
	updated.Telemetry.ToolPaths = toolStoredObservation(stamp)
	if err := testutil.WriteWorker(database, ctx, func(s store.WorkerScope) error {
		if _, err := s.WorkerDAO().SetWorkerConfiguration(ctx, user, id, 8, value); err != nil {
			return err
		}
		_, err := s.WorkerDAO().UpsertWorker(ctx, updated)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	got := testutil.ReadWorkerSnapshot(t, database, user, id, stamp)
	if !reflect.DeepEqual(got.Telemetry.ToolPaths, updated.Telemetry.ToolPaths) {
		t.Fatalf("tool facts lost in JSONB: %+v", got.Telemetry.ToolPaths)
	}
	if err := database.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
		got, err := s.WorkerDAO().WorkerConfiguration(ctx, user, id)
		if err == nil && (got.Desired.Revision != "8" || !reflect.DeepEqual(got.Desired.Value.ToolPaths, value.ToolPaths)) {
			t.Fatalf("choices lost: %+v", got)
		}
		_, foreign := s.WorkerDAO().WorkerConfiguration(ctx, testutil.QueryID(3), id)
		if !errors.Is(foreign, model.ErrNotFound) {
			t.Fatalf("foreign owner read configuration: %v", foreign)
		}
		_, foreign = s.WorkerDAO().Worker(ctx, testutil.QueryID(3), id, stamp)
		if !errors.Is(foreign, model.ErrNotFound) {
			t.Fatalf("foreign owner read tool paths: %v", foreign)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	completion, err := database.WriteWorker(ctx, func(s store.WorkerScope) error {
		changed := updated
		changed.Telemetry.Machine.Name = "Must roll back"
		changed.Telemetry.ToolPaths = nil
		if _, err := s.WorkerDAO().UpsertWorker(ctx, changed); err != nil {
			return err
		}
		bad := value
		bad.ToolPaths.Herdr = toolChoice("/local/herdr")
		bad.Projects = []model.WorkerProjectConfiguration{{ProjectID: testutil.QueryID(4), NativeOverrides: map[string]json.RawMessage{"args": json.RawMessage(`invalid`)}}}
		_, err := s.WorkerDAO().SetWorkerConfiguration(ctx, user, id, 9, bad)
		return err
	})
	if err == nil || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("encoding failure committed: %+v %v", completion, err)
	}
	after := testutil.ReadWorkerSnapshot(t, database, user, id, stamp)
	if !reflect.DeepEqual(after, got) {
		t.Fatal("encoding failure partially committed heartbeat")
	}
	if err := database.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
		got, err := s.WorkerDAO().WorkerConfiguration(ctx, user, id)
		if err == nil && (got.Desired.Revision != "8" || got.Desired.Value.ToolPaths.Herdr != nil) {
			t.Fatalf("encoding failure partially adopted paths: %+v", got)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	// A later old Worker report replaces the capability instead of retaining stale facts.
	testutil.PutWorkerSnapshot(t, database, original)
	if got := testutil.ReadWorkerSnapshot(t, database, user, id, stamp); got.Telemetry.ToolPaths != nil {
		t.Fatal("legacy heartbeat retained stale tool capability")
	}
}

func TestWorkerToolPathsLockedReadBothAdoptionOrders(t *testing.T) {
	for _, webFirst := range []bool{false, true} {
		t.Run(map[bool]string{false: "bootstrap first", true: "web choice first"}[webFirst], func(t *testing.T) {
			database := workerStorage(t)
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			user, id := testutil.QueryID(1), testutil.QueryID(2)
			testutil.PutWorkerSnapshot(t, database, testutil.WorkerSnapshotFixture(user, id, time.Now().UTC()))
			initial := testutil.WorkerConfiguration()
			if err := testutil.WriteWorker(database, ctx, func(s store.WorkerScope) error {
				_, err := s.WorkerDAO().SetWorkerConfiguration(ctx, user, id, 7, initial)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			first, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer first.Rollback(context.Background())
			firstDAO := pgworker.NewWriter(first)
			if _, err := firstDAO.WorkerConfiguration(ctx, user, id); err != nil {
				t.Fatal(err)
			}
			second, err := database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer second.Rollback(context.Background())
			type result struct {
				value model.WorkerConfigurationResource
				err   error
			}
			ready := make(chan result, 1)
			go func() {
				value, err := pgworker.NewWriter(second).WorkerConfiguration(ctx, user, id)
				ready <- result{value, err}
			}()
			testutil.WaitThreadBackendLock(t, database.Pool, second.Conn().PgConn().PID())
			chosen := initial
			if webFirst {
				chosen.ToolPaths.Codex = toolChoice("/cloud/codex")
			} else {
				chosen.ToolPaths = model.WorkerToolPaths{Codex: toolChoice("/local/codex"), Copilot: toolChoice("/local/copilot"), Herdr: &model.ToolPathChoice{Kind: "auto"}}
			}
			if _, err := firstDAO.SetWorkerConfiguration(ctx, user, id, 8, chosen); err != nil {
				t.Fatal(err)
			}
			if err := first.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			var locked result
			select {
			case locked = <-ready:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if locked.err != nil || locked.value.Desired.Revision != "8" || !reflect.DeepEqual(locked.value.Desired.Value.ToolPaths, chosen.ToolPaths) {
				t.Fatalf("waiting writer did not see committed choices and CAS revision: %+v %v", locked.value, locked.err)
			}
			if webFirst {
				// The Core adoption test owns the merge decision; this write proves its complete result persists under the same lock.
				final := chosen
				final.ToolPaths.Copilot = toolChoice("/local/copilot")
				final.ToolPaths.Herdr = &model.ToolPathChoice{Kind: "auto"}
				if _, err := pgworker.NewWriter(second).SetWorkerConfiguration(ctx, user, id, 9, final); err != nil {
					t.Fatal(err)
				}
				if err := second.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				chosen = final
			} else {
				if err := second.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
			}
			if err := database.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
				got, err := s.WorkerDAO().WorkerConfiguration(ctx, user, id)
				if err == nil && !reflect.DeepEqual(got.Desired.Value.ToolPaths, chosen.ToolPaths) {
					t.Fatalf("fresh read lost interleaved choices: %+v", got)
				}
				return err
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}
