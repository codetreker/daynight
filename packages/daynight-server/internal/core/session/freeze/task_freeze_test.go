package freeze

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
)

type freezeDAO struct {
	store.ProjectSessionDAO
	drain      store.TaskSessionDrain
	receipts   store.TaskSessionReceiptTransition
	calls      []string
	drainError error
}

func (d *freezeDAO) DrainTaskSessions(_ context.Context, _ string, plan store.TaskSessionDrain) error {
	d.calls = append(d.calls, "drain")
	d.drain = plan
	return d.drainError
}
func (d *freezeDAO) TransitionTaskSessionReceipts(_ context.Context, _ string, plan store.TaskSessionReceiptTransition) error {
	d.calls = append(d.calls, "receipts")
	d.receipts = plan
	return nil
}

func TestFreezeTaskSessionsDefinesDrainAndReceiptPolicy(t *testing.T) {
	dao := &freezeDAO{}
	if err := FreezeTaskSessions(context.Background(), dao, "task", model.TaskDone, nil); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(dao.calls, []string{"drain", "receipts"}) {
		t.Fatalf("calls: %v", dao.calls)
	}
	if dao.drain.ActiveClaim != nil || dao.drain.SourceLifecycle != "active" || dao.drain.GraceSeconds != 60 || dao.drain.TimelineField != "lastTimelineSeq" || dao.drain.LifecycleField != "lifecycle" || !reflect.DeepEqual(dao.drain.RemoveFields, []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"}) || !reflect.DeepEqual(dao.drain.SnapshotValues, map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}) {
		t.Fatalf("drain policy: %+v", dao.drain)
	}
	if dao.receipts.Lifecycle != "draining" || dao.receipts.PreviousState != "accepted" || dao.receipts.NextState != "rejected" || dao.receipts.StateField != "state" || !reflect.DeepEqual(dao.receipts.RemoveFields, []string{"error"}) {
		t.Fatalf("receipt policy: %+v", dao.receipts)
	}
}

func TestFreezeTaskSessionsStopsOnDrainFailure(t *testing.T) {
	failure := errors.New("drain failure")
	dao := &freezeDAO{drainError: failure}
	if err := FreezeTaskSessions(context.Background(), dao, "task", model.TaskDone, nil); !errors.Is(err, failure) {
		t.Fatalf("lost error: %v", err)
	}
	if !reflect.DeepEqual(dao.calls, []string{"drain"}) {
		t.Fatalf("unexpected calls: %v", dao.calls)
	}
}

func TestFreezePreservesOnlyActiveWebClaim(t *testing.T) {
	worker := model.WorkerClaim{
		ClaimID: "00000000-0000-4000-8000-000000000001", State: model.WorkerActive,
		UserID: "00000000-0000-4000-8000-000000000002", WorkerID: "00000000-0000-4000-8000-000000000003",
		Machine:  model.WorkerMachine{ID: "00000000-0000-4000-8000-000000000004", Name: "machine"},
		Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb,
		WorktreeID: "00000000-0000-4000-8000-000000000005", Phase: model.WorkerExecuting,
		ClaimedAt: time.Date(2026, 10, 24, 1, 2, 3, 0, time.UTC),
	}
	props, err := properties.WithWorker(model.TaskProperties{}, &worker)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		status     model.TaskStatus
		properties model.TaskProperties
		preserve   bool
	}{
		{model.TaskInProgress, props, true},
		{model.TaskDone, props, false},
		{model.TaskInProgress, nil, false},
	} {
		dao := &freezeDAO{}
		if err := FreezeTaskSessions(context.Background(), dao, "task", tc.status, tc.properties); err != nil {
			t.Fatal(err)
		}
		if tc.preserve && (dao.drain.ActiveClaim == nil || *dao.drain.ActiveClaim != worker.ClaimID) {
			t.Fatalf("active claim not preserved: %+v", dao.drain)
		}
		if !tc.preserve && dao.drain.ActiveClaim != nil {
			t.Fatalf("stale claim preserved: %+v", dao.drain)
		}
	}
}

func TestFreezePropagatesWorkerDecodeFailureBeforeWriting(t *testing.T) {
	dao := &freezeDAO{}
	props := model.TaskProperties{"worker": []byte(`{"claimId":1}`)}
	if err := FreezeTaskSessions(context.Background(), dao, "task", model.TaskInProgress, props); err == nil {
		t.Fatal("worker decoding error was hidden")
	}
	if len(dao.calls) != 0 {
		t.Fatalf("session writes after worker decoding error: %v", dao.calls)
	}
}
