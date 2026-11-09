package worker

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestMatchTaskSnapshotsUsesActiveOwnedClaimsInInventoryOrder(t *testing.T) {
	user, id := "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"
	project := "33333333-3333-4333-8333-333333333333"
	stamp := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	claim := model.WorkerClaim{ClaimID: "44444444-4444-4444-8444-444444444444", State: model.WorkerActive, UserID: user, WorkerID: id,
		Machine: model.WorkerMachine{ID: id, Name: "worker"}, Platform: model.PlatformLinux, Agent: model.AgentCodex,
		AgentControlMode: model.AgentControlModeHerdr, WorktreeID: "55555555-5555-4555-8555-555555555555", Phase: model.WorkerExecuting, ClaimedAt: stamp}
	raw, err := taskproperty.EncodeWorker(&claim)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{"66666666-6666-4666-8666-666666666666", "77777777-7777-4777-8777-777777777777", "88888888-8888-4888-8888-888888888888"}
	source := func(taskID string) store.WorkerTaskSource {
		return store.WorkerTaskSource{Task: model.Task{ID: taskID, ProjectID: project, Title: taskID, Status: model.TaskInProgress, Properties: model.TaskProperties{"worker": raw}}, ProjectName: "Project"}
	}
	inventory := model.WorkerTaskInventory{Claims: []model.WorkerTaskReference{{TaskID: ids[1], ProjectID: project, ClaimID: claim.ClaimID}, {TaskID: ids[0], ProjectID: project, ClaimID: claim.ClaimID}, {TaskID: ids[2], ProjectID: project, ClaimID: "wrong"}}}
	items, err := MatchTaskSnapshots([]store.WorkerTaskSource{source(ids[0]), source(ids[1]), source(ids[2])}, inventory, user, id)
	if err != nil || len(items) != 2 || items[0].TaskID != ids[1] || items[1].TaskID != ids[0] || items[0].Phase != model.WorkerExecuting || items[0].ProjectName != "Project" {
		t.Fatalf("matching inventory: %+v %v", items, err)
	}
	for _, tc := range []struct {
		user, worker, project string
		status                model.TaskStatus
	}{
		{"other", id, project, model.TaskInProgress}, {user, "other", project, model.TaskInProgress}, {user, id, "other", model.TaskInProgress}, {user, id, project, model.TaskDone},
	} {
		s := source(ids[0])
		s.Task.Status = tc.status
		r := inventory.Claims[1]
		r.ProjectID = tc.project
		got, err := MatchTaskSnapshots([]store.WorkerTaskSource{s}, model.WorkerTaskInventory{Claims: []model.WorkerTaskReference{r}}, tc.user, tc.worker)
		if err != nil || len(got) != 0 {
			t.Fatalf("mismatched claim exposed: %+v %v", got, err)
		}
	}
}

func TestMatchTaskSnapshotsHandlesMissingSourcesAndJSONErrors(t *testing.T) {
	ref := model.WorkerTaskReference{TaskID: "task", ProjectID: "project", ClaimID: "claim"}
	inventory := model.WorkerTaskInventory{Claims: []model.WorkerTaskReference{ref}}
	items, err := MatchTaskSnapshots(nil, inventory, "user", "worker")
	if err != nil || items == nil || len(items) != 0 {
		t.Fatalf("missing source was not omitted: %+v %v", items, err)
	}
	source := store.WorkerTaskSource{Task: model.Task{ID: ref.TaskID, ProjectID: ref.ProjectID, Status: model.TaskInProgress,
		Properties: model.TaskProperties{"worker": json.RawMessage(`{"claimId":1}`)}}}
	if _, err := MatchTaskSnapshots([]store.WorkerTaskSource{source}, inventory, "user", "worker"); err == nil {
		t.Fatal("worker JSON type error was silently ignored")
	}
}

func TestSnapshotProjectionDistinguishesUnavailableAndEmpty(t *testing.T) {
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	report := model.WorkerReport{}
	unknown := SnapshotForReport("user", "worker", report, at, nil)
	if unknown.TaskSnapshot.State != model.WorkerTasksUnavailable || unknown.TaskSnapshot.Items == nil || ProjectSnapshot(unknown).ActiveTaskCount != nil {
		t.Fatal("unknown inventory changed")
	}
	report.TaskInventory = &model.WorkerTaskInventory{ObservedAt: at.Add(-time.Minute), Claims: []model.WorkerTaskReference{}}
	observed := SnapshotForReport("user", "worker", report, at, []model.WorkerObservedTask{})
	projection := ProjectSnapshot(observed)
	if observed.TaskSnapshot.State != model.WorkerTasksObserved || observed.TaskSnapshot.InventoryObservedAt == nil || !observed.TaskSnapshot.InventoryObservedAt.Equal(report.TaskInventory.ObservedAt) || projection.ActiveTaskCount == nil || *projection.ActiveTaskCount != 0 {
		t.Fatal("explicit empty inventory changed")
	}
	observed.TaskSnapshot.State = model.WorkerTasksStale
	if p := ProjectSnapshot(observed); p.ActiveTaskCount == nil || *p.ActiveTaskCount != 0 {
		t.Fatal("stale inventory count was lost")
	}
}
