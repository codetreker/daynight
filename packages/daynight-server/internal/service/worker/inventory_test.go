package worker

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

type inventoryReportStore struct {
	store.WorkerWriteDAO
	t             *testing.T
	ctx           context.Context
	calls         []string
	user          string
	worker        string
	at, read      time.Time
	input         model.WorkerTaskInventory
	sources       []store.WorkerTaskSource
	expectedWrite model.WorkerSnapshot
	result        model.WorkerSnapshot
	completion    store.Completion
	observation   model.WorkerSnapshot
}

func (s *inventoryReportStore) take(ctx context.Context, call string) {
	s.t.Helper()
	if len(s.calls) == 0 {
		s.t.Fatalf("unexpected inventory report call: %s", call)
	}
	want := s.calls[0]
	s.calls = s.calls[1:]
	if want != call || ctx != nil && ctx != s.ctx {
		s.t.Fatalf("inventory report call %s, want %s with original context", call, want)
	}
}
func (s *inventoryReportStore) WriteWorker(ctx context.Context, operation func(store.WorkerScope) error) (store.Completion, error) {
	s.take(ctx, "write")
	return s.completion, operation(s)
}
func (s *inventoryReportStore) WorkerDAO() store.WorkerWriteDAO {
	s.take(nil, "dao")
	return s
}
func (s *inventoryReportStore) AdmitWorker(ctx context.Context, user, worker string, window time.Duration) (store.WorkerAdmission, error) {
	s.take(ctx, "admit")
	if user != s.user || worker != s.worker || window != workercore.ActiveWindow {
		s.t.Fatalf("admission: %s %s %s", user, worker, window)
	}
	return store.WorkerAdmission{ObservedAt: s.at}, nil
}
func (s *inventoryReportStore) ReportTaskSnapshots(ctx context.Context, user string, input model.WorkerTaskInventory) ([]store.WorkerTaskSource, error) {
	s.take(ctx, "sources")
	if user != s.user || !reflect.DeepEqual(input, s.input) {
		s.t.Fatalf("normalized inventory: %s %+v, want %+v", user, input, s.input)
	}
	return s.sources, nil
}
func (s *inventoryReportStore) UpsertWorker(ctx context.Context, value model.WorkerSnapshot) (model.WorkerSnapshot, error) {
	s.take(ctx, "upsert")
	if !reflect.DeepEqual(value, s.expectedWrite) {
		s.t.Fatalf("authoritative inventory write: %+v, want %+v", value, s.expectedWrite)
	}
	return s.result, nil
}
func (s *inventoryReportStore) ObservedAt(ctx context.Context) (time.Time, error) {
	s.take(ctx, "observed")
	return s.read, nil
}

func (s *inventoryReportStore) ReadSnapshot(ctx context.Context, operation func(store.SnapshotScope) error) error {
	s.take(ctx, "snapshot")
	return operation(inventoryReportReadScope{source: s})
}

type inventoryReportReadScope struct {
	store.SnapshotScope
	source *inventoryReportStore
}

func (s inventoryReportReadScope) ObservedAt(ctx context.Context) (time.Time, error) {
	s.source.take(ctx, "read-observed")
	return s.source.read, nil
}
func (s inventoryReportReadScope) WorkerDAO() store.WorkerReader {
	s.source.take(nil, "read-dao")
	return inventoryReportReader{source: s.source}
}

type inventoryReportReader struct {
	store.WorkerReader
	source *inventoryReportStore
}

func (r inventoryReportReader) Worker(ctx context.Context, user, worker string, observed time.Time) (model.WorkerSnapshot, error) {
	r.source.take(ctx, "read-worker")
	if user != r.source.user || worker != r.source.worker || observed != r.source.read {
		r.source.t.Fatalf("worker read scope: %s %s %v", user, worker, observed)
	}
	return r.source.observation, nil
}

func TestReportUsesCanonicalReferencesAndAuthoritativeTaskSnapshot(t *testing.T) {
	const user = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const worker = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	const project = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	const task = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	const claimID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	claim := model.WorkerClaim{ClaimID: claimID, State: model.WorkerActive, UserID: user, WorkerID: worker,
		Machine: model.WorkerMachine{ID: worker, Name: "Build machine"}, Platform: model.PlatformLinux,
		Agent: model.AgentClaude, AgentControlMode: model.AgentControlModeWeb,
		WorktreeID: "ffffffff-ffff-4fff-8fff-ffffffffffff", Phase: model.WorkerPreparing, ClaimedAt: at}
	raw, err := taskproperty.EncodeWorker(&claim)
	if err != nil {
		t.Fatal(err)
	}
	report := serviceWorkerReport()
	inventoryAt := report.Telemetry.SampledAt
	missing := model.WorkerTaskReference{ProjectID: project, TaskID: "ab000000-0000-4000-8000-000000000001", ClaimID: "ab000000-0000-4000-8000-000000000002"}
	canonical := model.WorkerTaskInventory{ObservedAt: inventoryAt, Claims: []model.WorkerTaskReference{{ProjectID: project, TaskID: task, ClaimID: claimID}, missing}}
	report.TaskInventory = &model.WorkerTaskInventory{ObservedAt: inventoryAt, Claims: []model.WorkerTaskReference{{ProjectID: strings.ToUpper(project), TaskID: task, ClaimID: claimID}, missing}}
	ctx := t.Context()
	source := store.WorkerTaskSource{Task: model.Task{ID: task, ProjectID: project, Title: "Worker task", Status: model.TaskInProgress,
		Properties: model.TaskProperties{"worker": raw, "pullRequests": json.RawMessage(`[{"url":"opaque\u0000","title":"Unrelated PR"}]`)}}, ProjectName: "Tasks"}
	expected := model.WorkerSnapshot{UserID: user, WorkerID: worker, CreatedAt: at, LastReportedAt: at, Telemetry: report.Telemetry,
		TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &at, InventoryObservedAt: &inventoryAt,
			Items: []model.WorkerObservedTask{{ProjectID: project, TaskID: task, ClaimID: claimID, Title: "Worker task", ProjectName: "Tasks", Status: model.TaskInProgress, Phase: model.WorkerPreparing, Agent: model.AgentClaude}}}}
	// The read is a separately supplied observation, not state inferred from the write.
	observation := expected
	observation.TaskSnapshot.Items = append([]model.WorkerObservedTask(nil), expected.TaskSnapshot.Items...)
	database := &inventoryReportStore{t: t, ctx: ctx, user: user, worker: worker, at: at, read: at.Add(time.Millisecond),
		calls: []string{"write", "dao", "admit", "sources", "upsert", "observed", "snapshot", "read-observed", "read-dao", "read-worker"},
		input: canonical, sources: []store.WorkerTaskSource{source}, expectedWrite: expected, result: expected, completion: store.Completion{Outcome: store.TransactionCommitted},
		observation: observation}
	t.Cleanup(func() {
		if len(database.calls) != 0 {
			t.Errorf("unconsumed inventory report calls: %v", database.calls)
		}
	})
	principal := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: "ab000000-0000-4000-8000-000000000003"}
	subject := NewWorkers(database)
	result, err := subject.Report(ctx, principal, worker, report)
	if err != nil || !result.LastReportedAt.Equal(at) || !result.ObservedAt.Equal(database.read) {
		t.Fatalf("report receipt: %+v %v", result, err)
	}
	detail, err := subject.Get(ctx, principal, worker)
	if err != nil || !reflect.DeepEqual(detail.Worker, expected) || !detail.ObservedAt.Equal(database.read) {
		t.Fatalf("authoritative inventory read: %+v %v", detail, err)
	}
}
