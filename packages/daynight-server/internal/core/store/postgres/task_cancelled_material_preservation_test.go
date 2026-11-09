package postgres

import (
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch/query"
)

func cancelledMaterialWrite(t *testing.T, database *Store, current model.Task, change func(*store.TaskWrite)) model.Task {
	t.Helper()
	values := taskMutationValues(current)
	change(&values)
	var result model.Task
	completion, err := database.WriteProject(t.Context(), current.ProjectID, func(scope store.ProjectWriteScope) error {
		var err error
		result, err = scope.TaskDAO().UpdateTask(t.Context(), current.ID, values)
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("material write did not commit: %#v %v", completion, err)
	}
	if actual := snapshotTask(t, database, current.ProjectID, current.ID); !reflect.DeepEqual(actual, result) {
		t.Fatalf("material write result differs from persistence: %#v %#v", result, actual)
	}
	return result
}

func TestCancelledTaskStoragePreservesMaterialsAndTerminalProjections(t *testing.T) {
	database, owner, _, project := membershipFixture(t)
	ctx := t.Context()
	predecessor := queryTask(t, database, project.ID, 10, model.TaskTodo)
	target := queryTask(t, database, project.ID, 11, model.TaskTodo, predecessor.ID)
	other := queryTask(t, database, project.ID, 12, model.TaskTodo)
	external := queryTask(t, database, project.ID, 13, model.TaskCancelled)
	follower := queryTask(t, database, project.ID, 14, model.TaskTodo, target.ID, other.ID, external.ID)
	follower = cancelledMaterialWrite(t, database, follower, func(values *store.TaskWrite) {
		values.ExternalDependsOn = []string{external.ID}
	})
	platform := model.TaskPlatform(model.PlatformLinux)
	target = cancelledMaterialWrite(t, database, target, func(values *store.TaskWrite) {
		values.Title, values.Description = "Cancelled target", "Readable retained task material"
		values.AllowAgents, values.AssignedTo, values.RequiredPlatform = true, &owner.UserID, &platform
		values.Properties = taskMutationPR(t, "https://example.test/pr/1", "Retained result")
	})
	seedStoreStep(t, database, target.ID, "abcdef01", 0)
	message := appendStoredThread(t, database, target.ID, owner.UserID, "Retained discussion")
	attachment, created, err := database.PutAttachment(ctx, model.Attachment{
		ProjectID: project.ID, TaskID: target.ID, Path: "retained.txt", ContentType: "text/plain", SizeBytes: 25,
	})
	if err != nil || !created {
		t.Fatalf("attachment material fixture: %#v created=%t %v", attachment, created, err)
	}
	var beforeSteps []model.TaskStep
	if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		var err error
		beforeSteps, err = scope.TaskDAO().TaskSteps(ctx, target.ID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var beforeEpoch string
	if err := database.Pool.QueryRow(ctx, "SELECT task_cache_epoch::text FROM projects WHERE id=$1", project.ID).Scan(&beforeEpoch); err != nil {
		t.Fatal(err)
	}
	if target.Ready || !slices.Equal(target.BlockedBy, []string{predecessor.ID}) {
		t.Fatalf("target must have an unfinished prerequisite: %#v", target)
	}
	cancelled := cancelledMaterialWrite(t, database, target, func(values *store.TaskWrite) { values.Status = model.TaskCancelled })
	if cancelled.CancelledAt == nil || cancelled.CancelledAt.Location() != time.UTC || !cancelled.CancelledAt.Equal(cancelled.UpdatedAt) ||
		cancelled.Status != model.TaskCancelled || cancelled.Ready || cancelled.Version != target.Version+1 {
		t.Fatalf("cancellation did not retain a terminal database timestamp: %#v", cancelled)
	}
	comparable := cancelled
	comparable.Status, comparable.Version, comparable.UpdatedAt, comparable.CancelledAt = target.Status, target.Version, target.UpdatedAt, target.CancelledAt
	if !reflect.DeepEqual(comparable, target) {
		t.Fatalf("cancellation changed unrelated Task facts: before=%#v after=%#v", target, cancelled)
	}
	if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		presence, err := scope.TaskDAO().TaskPresence(ctx, project.ID, target.ID)
		if err != nil || !presence.Found || presence.DeletedAt != nil {
			t.Fatalf("cancelled Task became absent or deleted: %#v %v", presence, err)
		}
		steps, err := scope.TaskDAO().TaskSteps(ctx, target.ID)
		if err != nil || !reflect.DeepEqual(steps, beforeSteps) {
			t.Fatalf("cancellation changed or hid Steps: %#v %v", steps, err)
		}
		storedMessage, err := scope.TaskDAO().ThreadMessage(ctx, target.ID, message.ID)
		if err != nil || !reflect.DeepEqual(storedMessage, message) {
			t.Fatalf("cancellation changed or hid discussion: %#v %v", storedMessage, err)
		}
		storedAttachment, err := scope.AttachmentDAO().Attachment(ctx, project.ID, target.ID, attachment.Path)
		if err != nil || !reflect.DeepEqual(storedAttachment, attachment) {
			t.Fatalf("cancellation changed or hid attachment metadata: %#v %v", storedAttachment, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	remaining := snapshotTask(t, database, project.ID, follower.ID)
	if remaining.Ready || remaining.Version != follower.Version || !slices.Equal(remaining.BlockedBy, []string{other.ID}) ||
		!slices.Equal(remaining.DependsOn, follower.DependsOn) || !slices.Equal(remaining.ExternalDependsOn, []string{external.ID}) {
		t.Fatalf("cancelled ordinary/external prerequisites changed follower identity or remaining blockers: %#v", remaining)
	}
	cancelledMaterialWrite(t, database, other, func(values *store.TaskWrite) { values.Status = model.TaskDone })
	ready := snapshotTask(t, database, project.ID, follower.ID)
	if !ready.Ready || len(ready.BlockedBy) != 0 || ready.Version != follower.Version {
		t.Fatalf("cancelled ordinary/external prerequisites did not satisfy the follower: %#v", ready)
	}
	if err := database.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		graph, err := scope.TaskDAO().TaskGraphTasks(ctx, project.ID, target.ID, testGraphSelection(), 160)
		if err != nil {
			return err
		}
		found := false
		for _, node := range graph {
			if node.ID == target.ID {
				found = true
				if node.Status != model.TaskCancelled || !reflect.DeepEqual(node.CancelledAt, cancelled.CancelledAt) || !slices.Equal(node.DependsOn, target.DependsOn) {
					t.Fatalf("graph lost cancellation time or dependencies: %#v", node)
				}
			}
		}
		if !found {
			t.Fatal("graph omitted the live cancelled Task")
		}
		sync, err := scope.TaskDAO().TaskSyncTasks(ctx, project.ID, nil, 160)
		if err != nil {
			return err
		}
		found = false
		for _, record := range sync {
			if record.ID == target.ID {
				found = true
				if record.Status != model.TaskCancelled || !reflect.DeepEqual(record.CancelledAt, cancelled.CancelledAt) {
					t.Fatalf("sync lost cancellation time: %#v", record)
				}
			}
		}
		if !found {
			t.Fatal("sync omitted the live cancelled Task")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	expression, err := query.Parse("Cancelled")
	if err != nil {
		t.Fatal(err)
	}
	status := model.TaskCancelled
	if err := database.ReadTaskSearch(ctx, func(scope store.TaskSearchSnapshot) error {
		page, err := scope.Matches(ctx, project.ID, store.TaskSearchQuery{Expression: expression, Status: &status, Limit: 10})
		if err != nil || len(page.Items) != 1 || page.Items[0].ID != target.ID || !reflect.DeepEqual(page.Items[0].CancelledAt, cancelled.CancelledAt) {
			t.Fatalf("search lost cancelled status filtering or timestamp: %#v %v", page, err)
		}
		fence, err := scope.Fence(ctx, project.ID)
		if err != nil || fence.Epoch != beforeEpoch {
			t.Fatalf("cancellation rotated the deletion epoch: %#v %v", fence, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestCancelledTaskStoragePreservesCompletedIntervalAndReleasedWorker(t *testing.T) {
	database, owner, _, project := membershipFixture(t)
	target := queryTask(t, database, project.ID, 11, model.TaskTodo)
	started := cancelledMaterialWrite(t, database, target, func(values *store.TaskWrite) { values.Status = model.TaskInProgress })
	completed := cancelledMaterialWrite(t, database, started, func(values *store.TaskWrite) { values.Status = model.TaskDone })
	follower := queryTask(t, database, project.ID, 12, model.TaskInProgress, target.ID)
	cancelled := cancelledMaterialWrite(t, database, completed, func(values *store.TaskWrite) { values.Status = model.TaskCancelled })
	if cancelled.CancelledAt == nil || !reflect.DeepEqual(cancelled.StartedAt, completed.StartedAt) || !reflect.DeepEqual(cancelled.CompletedAt, completed.CompletedAt) {
		t.Fatalf("done cancellation replaced the execution interval: %#v %#v", completed, cancelled)
	}
	edited := cancelledMaterialWrite(t, database, cancelled, func(values *store.TaskWrite) { values.Description = "Readable edited cancellation" })
	if !reflect.DeepEqual(edited.CancelledAt, cancelled.CancelledAt) || !reflect.DeepEqual(edited.StartedAt, completed.StartedAt) || !reflect.DeepEqual(edited.CompletedAt, completed.CompletedAt) {
		t.Fatalf("cancelled metadata edit changed terminal timing: %#v", edited)
	}
	if got := snapshotTask(t, database, project.ID, follower.ID); !reflect.DeepEqual(got, follower) {
		t.Fatalf("done cancellation changed an already-started follower: %#v %#v", follower, got)
	}
	released := queryTask(t, database, project.ID, 13, model.TaskTodo)
	history := workerWitnessClaim(13, owner.UserID, queryID(50), model.WorkerReleased)
	released = cancelledMaterialWrite(t, database, released, func(values *store.TaskWrite) {
		values.AllowAgents = true
		values.Properties = fixtureTaskProperties(t, history)
	})
	beforeProperties := released.Properties
	retained := cancelledMaterialWrite(t, database, released, func(values *store.TaskWrite) { values.Status = model.TaskCancelled })
	if !reflect.DeepEqual(retained.Properties, beforeProperties) || !reflect.DeepEqual(fixtureWorker(t, retained.Properties), history) {
		t.Fatalf("cancellation rewrote released Worker history: %#v", retained)
	}
}
