package service

import (
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"

	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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
	if err != nil || len(page.Items) != 1 || page.Items[0].ActiveTaskCount == nil || *page.Items[0].ActiveTaskCount != 0 {
		t.Fatalf("list and detail permission filters disagree: %+v, %v", page, err)
	}
	if _, err := workers.Report(ctx, owner, descriptor.WorkerID, report); err != nil {
		t.Fatalf("ordinary completion/revocation race rejected machine report: %v", err)
	}
}
