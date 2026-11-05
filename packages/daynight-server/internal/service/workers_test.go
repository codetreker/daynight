package service

import (
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"

	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func serviceWorkerReport() model.WorkerReport {
	now := time.Now().UTC()
	return model.WorkerReport{Telemetry: model.WorkerTelemetry{
		Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "Snapshot worker"}, Platform: model.PlatformLinux,
		WorkingDirectory: "/workspace", SampledAt: now,
		OS:       model.WorkerProbe[model.WorkerOS]{State: "ok", CheckedAt: now, Value: pointer(model.WorkerOS{Type: "Linux", Release: "6.8", Version: "Linux kernel", Arch: "x64"})},
		CPU:      model.WorkerProbe[model.WorkerCPU]{State: "ok", CheckedAt: now, Value: pointer(model.WorkerCPU{Model: "Test CPU", LogicalProcessors: 4, UsagePercent: 25})},
		Memory:   model.WorkerProbe[model.WorkerMemory]{State: "ok", CheckedAt: now, Value: pointer(model.WorkerMemory{UsedBytes: 1024, TotalBytes: 4096})},
		Disk:     model.WorkerProbe[model.WorkerDisk]{State: "ok", CheckedAt: now, Value: pointer(model.WorkerDisk{AvailableBytes: 2048, TotalBytes: 8192})},
		Versions: model.WorkerVersions{Daynight: "1.0.0", Herdr: model.WorkerProbe[string]{State: "not_running", CheckedAt: now}, Codex: model.WorkerProbe[string]{State: "not_installed", CheckedAt: now}, Copilot: model.WorkerProbe[string]{State: "not_installed", CheckedAt: now}},
	}}
}

func TestWorkerSnapshotsPreserveUnknownEmptyAndStaleObservations(t *testing.T) {
	_, database, _, principal := projectService(t)
	workers := workerservice.NewWorkers(database)
	ctx := context.Background()
	id := uuid.NewString()
	report := serviceWorkerReport()
	for range 2 {
		result, err := workers.Report(ctx, principal, strings.ToUpper(id), report)
		if err != nil || result.LastReportedAt.IsZero() || result.ObservedAt.Before(result.LastReportedAt) {
			t.Fatalf("initial report: %+v, %v", result, err)
		}
		detail, err := workers.Get(ctx, principal, id)
		if err != nil || detail.Worker.TaskSnapshot.State != model.WorkerTasksUnavailable || detail.Worker.TaskSnapshot.ObservedAt != nil || len(detail.Worker.TaskSnapshot.Items) != 0 {
			t.Fatalf("unknown inventory became idle: %+v, %v", detail, err)
		}
	}
	before, err := workers.Get(ctx, principal, id)
	if err != nil {
		t.Fatal(err)
	}
	report.TaskInventory = &model.WorkerTaskInventory{ObservedAt: time.Now().UTC(), Claims: []model.WorkerTaskReference{}}
	if _, err := workers.Report(ctx, principal, id, report); err != nil {
		t.Fatal(err)
	}
	idle, err := workers.Get(ctx, principal, id)
	if err != nil || idle.Worker.TaskSnapshot.State != model.WorkerTasksObserved || idle.Worker.TaskSnapshot.ObservedAt == nil || !idle.Worker.CreatedAt.Equal(before.Worker.CreatedAt) {
		t.Fatalf("known empty inventory: %+v, %v", idle, err)
	}
	report.TaskInventory = nil
	report.Telemetry.Machine.Name = "Reconnected worker"
	report.Telemetry.Memory = model.WorkerProbe[model.WorkerMemory]{State: "error", CheckedAt: time.Now().UTC(), Code: pointer("io_error")}
	if _, err := workers.Report(ctx, principal, id, report); err != nil {
		t.Fatal(err)
	}
	stale, err := workers.Get(ctx, principal, id)
	if err != nil || stale.Worker.TaskSnapshot.State != model.WorkerTasksStale || !reflect.DeepEqual(stale.Worker.TaskSnapshot.ObservedAt, idle.Worker.TaskSnapshot.ObservedAt) || stale.Worker.Telemetry.Machine.Name != report.Telemetry.Machine.Name || stale.Worker.Telemetry.Memory.State != "error" {
		t.Fatalf("reconnect lost truthful task or field state: %+v, %v", stale, err)
	}
	other := servicePrincipal(t, database)
	_, err = workers.Get(ctx, other, id)
	requireFault(t, err, "not_found")
	page, err := workers.List(ctx, other, model.PageRequest{Limit: 50})
	if err != nil || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatalf("worker leaked to another account: %+v, %v", page, err)
	}
}

func TestWorkerSnapshotsNormalizeClaimsAndFilterCurrentPermissions(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	ctx := context.Background()
	owner := workerMember(t, database, project.ID)
	descriptor := workerDescriptor()
	descriptor.Agent, descriptor.AgentControlMode = model.AgentClaude, model.AgentControlModeWeb
	task := claimWorkerTask(t, tasks, owner, claimableTask(t, tasks, owner, project.ID), descriptor)
	task = updateTask(t, tasks, admin, task, taskcore.UpdateTask{Properties: propertyPatch(model.PullRequestProperty{URL: "opaque\x00", Title: "Unrelated PR"})})
	before := task
	workers := workerservice.NewWorkers(database)
	report := serviceWorkerReport()
	report.TaskInventory = &model.WorkerTaskInventory{ObservedAt: time.Now().UTC(), Claims: []model.WorkerTaskReference{{ProjectID: strings.ToUpper(project.ID), TaskID: task.ID, ClaimID: descriptor.ClaimID}, {ProjectID: project.ID, TaskID: uuid.NewString(), ClaimID: uuid.NewString()}}}
	if _, err := workers.Report(ctx, owner, descriptor.WorkerID, report); err != nil {
		t.Fatal(err)
	}
	detail, err := workers.Get(ctx, owner, descriptor.WorkerID)
	if err != nil || len(detail.Worker.TaskSnapshot.Items) != 1 {
		t.Fatalf("normalized task inventory: %+v, %v", detail, err)
	}
	observed := detail.Worker.TaskSnapshot.Items[0]
	if observed.TaskID != task.ID || observed.Agent != model.AgentClaude || observed.Title != task.Title || observed.Phase != model.WorkerPreparing || observed.Status != model.TaskInProgress {
		t.Fatalf("snapshot did not use authoritative task fields: %+v", observed)
	}
	after, err := tasks.Get(ctx, admin, project.ID, task.ID)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("report mutated task ownership/version: %+v, %v", after, err)
	}
	if _, err := tasks.SetStatus(ctx, owner, project.ID, task.ID, taskcore.SetTaskStatus{Version: after.Version, Status: model.TaskDone, ClaimID: &descriptor.ClaimID}); err != nil {
		t.Fatal(err)
	}
	detail, err = workers.Get(ctx, owner, descriptor.WorkerID)
	if err != nil || len(detail.Worker.TaskSnapshot.Items) != 1 || detail.Worker.TaskSnapshot.Items[0].Status != model.TaskInProgress {
		t.Fatalf("completion erased or rewrote historical observation: %+v, %v", detail, err)
	}
	if _, err := database.Pool.Exec(ctx, "DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2", project.ID, owner.UserID); err != nil {
		t.Fatal(err)
	}
	detail, err = workers.Get(ctx, owner, descriptor.WorkerID)
	if err != nil || len(detail.Worker.TaskSnapshot.Items) != 0 {
		t.Fatalf("revoked membership leaked old titles: %+v, %v", detail, err)
	}
	page, err := workers.List(ctx, owner, model.PageRequest{Limit: 50})
	if err != nil || len(page.Items) != 1 || len(page.Items[0].TaskSnapshot.Items) != 0 {
		t.Fatalf("list and detail permission filters disagree: %+v, %v", page, err)
	}
	if _, err := workers.Report(ctx, owner, descriptor.WorkerID, report); err != nil {
		t.Fatalf("ordinary completion/revocation race rejected machine report: %v", err)
	}
}

func TestWorkerSnapshotsPaginationClockAndExpiredDetail(t *testing.T) {
	_, database, _, principal := projectService(t)
	ctx := context.Background()
	workers := workerservice.NewWorkers(database)
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	for _, id := range ids {
		if _, err := workers.Report(ctx, principal, id, serviceWorkerReport()); err != nil {
			t.Fatal(err)
		}
	}
	request := model.PageRequest{Limit: 1}
	seen := make(map[string]bool)
	for range ids {
		page, err := workers.List(ctx, principal, request)
		if err != nil || len(page.Items) != 1 || seen[page.Items[0].WorkerID] || page.ObservedAt.Before(page.Items[0].LastReportedAt) {
			t.Fatalf("stable worker page: %+v, %v", page, err)
		}
		seen[page.Items[0].WorkerID] = true
		for _, id := range ids {
			if _, err := workers.Report(ctx, principal, id, serviceWorkerReport()); err != nil {
				t.Fatal(err)
			}
		}
		if page.NextCursor != nil {
			_, err := workers.List(ctx, servicePrincipal(t, database), model.PageRequest{Limit: 1, Cursor: page.NextCursor})
			requireFault(t, err, "invalid_input")
		}
		request.Cursor = page.NextCursor
	}
	if request.Cursor != nil || len(seen) != len(ids) {
		t.Fatalf("pagination lost or repeated workers: %v", seen)
	}
	var lastReported time.Time
	if err := database.Pool.QueryRow(ctx, "UPDATE workers SET last_seen_at=statement_timestamp()-interval '121 seconds' WHERE worker_id=$1 RETURNING last_seen_at", ids[0]).Scan(&lastReported); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		detail, err := workers.Get(ctx, principal, ids[0])
		if err != nil || !detail.Worker.LastReportedAt.Equal(lastReported) || detail.ObservedAt.Sub(detail.Worker.LastReportedAt) < 120*time.Second {
			t.Fatalf("reads refreshed or misreported the liveness clock: %+v, %v", detail, err)
		}
	}
	if _, err := database.Pool.Exec(ctx, "UPDATE workers SET last_seen_at=statement_timestamp()-interval '73 hours' WHERE worker_id=$1", ids[0]); err != nil {
		t.Fatal(err)
	}
	_, err := workers.Get(ctx, principal, ids[0])
	requireFault(t, err, "not_found")
}

func TestWorkerSnapshotServiceRefusalsAndStorageFailures(t *testing.T) {
	_, database, _, principal := projectService(t)
	workers := workerservice.NewWorkers(database)
	ctx := context.Background()
	id := uuid.NewString()
	_, err := workers.Report(ctx, model.Principal{}, id, serviceWorkerReport())
	requireFault(t, err, "unauthenticated")
	_, err = workers.List(ctx, model.Principal{}, model.PageRequest{Limit: 1})
	requireFault(t, err, "unauthenticated")
	_, err = workers.Get(ctx, model.Principal{}, id)
	requireFault(t, err, "unauthenticated")
	_, err = workers.Report(ctx, principal, "invalid", serviceWorkerReport())
	requireFault(t, err, "invalid_input")
	_, err = workers.Report(ctx, principal, id, model.WorkerReport{})
	requireFault(t, err, "invalid_input")
	_, err = workers.List(ctx, principal, model.PageRequest{Limit: 0})
	requireFault(t, err, "invalid_input")
	_, err = workers.Get(ctx, principal, "invalid")
	requireFault(t, err, "invalid_input")
	_, err = workers.Get(ctx, principal, id)
	requireFault(t, err, "not_found")
	database.Close()
	for _, invoke := range []func() error{
		func() error { _, err := workers.Report(ctx, principal, id, serviceWorkerReport()); return err },
		func() error { _, err := workers.List(ctx, principal, model.PageRequest{Limit: 1}); return err },
		func() error { _, err := workers.Get(ctx, principal, id); return err },
	} {
		var stored *store.Error
		if err := invoke(); !errors.As(err, &stored) || errors.Unwrap(err) == nil {
			t.Fatalf("storage failure was hidden: %v", err)
		}
	}
}
