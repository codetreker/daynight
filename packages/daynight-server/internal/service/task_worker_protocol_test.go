package service

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func TestLegacyWorkerProtocolPreservesSupportedLifecycle(t *testing.T) {
	tasks, _, project, _, principal := taskService(t)
	ctx := WithLegacyWorkerProtocol(context.Background())
	manual := createTask(t, tasks, principal, project.ID, "Manual task")
	manual, err := tasks.Update(ctx, principal, project.ID, manual.ID, UpdateTask{Version: manual.Version, Title: pointer("Updated manual task")})
	if err != nil || manual.Title != "Updated manual task" {
		t.Fatalf("legacy manual update: %#v, %v", manual, err)
	}
	manual, err = tasks.SetStatus(ctx, principal, project.ID, manual.ID, SetTaskStatus{Version: manual.Version, Status: core.TaskInProgress})
	if err != nil || manual.Properties.Worker != nil || manual.Status != core.TaskInProgress {
		t.Fatalf("legacy manual lifecycle: %#v, %v", manual, err)
	}
	for _, agent := range []core.WorkerAgent{core.AgentCodex, core.AgentCopilot} {
		t.Run(string(agent), func(t *testing.T) {
			candidate := claimableTask(t, tasks, principal, project.ID)
			descriptor := workerDescriptor()
			descriptor.Agent = agent
			claimed, err := tasks.ClaimWorker(ctx, principal, project.ID, candidate.ID, ClaimWorker{Version: candidate.Version, WorkerDescriptor: descriptor})
			if err != nil || claimed.Properties.Worker == nil || claimed.Properties.Worker.AgentControlMode != core.AgentControlModeHerdr {
				t.Fatalf("legacy claim must retain default Herdr: %#v, %v", claimed, err)
			}
			updated, err := tasks.Update(ctx, principal, project.ID, claimed.ID, UpdateTask{Version: claimed.Version, Title: pointer("Updated worker task")})
			if err != nil || updated.Title != "Updated worker task" || updated.Properties.Worker.ClaimID != descriptor.ClaimID {
				t.Fatalf("legacy metadata update: %#v, %v", updated, err)
			}
			completed, err := tasks.SetStatus(ctx, principal, project.ID, updated.ID, SetTaskStatus{Version: updated.Version, Status: core.TaskDone, ClaimID: &descriptor.ClaimID})
			if err != nil || completed.Properties.Worker.State != core.WorkerCompleted {
				t.Fatalf("legacy completion: %#v, %v", completed, err)
			}
		})
	}
}

func TestLegacyWorkerProtocolRefusesUnsupportedExecutionsWithoutWrites(t *testing.T) {
	for _, entry := range []struct {
		mode  core.WorkerAgentControlMode
		agent core.WorkerAgent
	}{
		{core.AgentControlModeWeb, core.AgentCodex},
		{core.AgentControlModeWeb, core.AgentCopilot},
		{core.AgentControlModeWeb, core.AgentClaude},
		{core.AgentControlModeHerdr, core.AgentClaude},
	} {
		t.Run(string(entry.mode)+"/"+string(entry.agent), func(t *testing.T) {
			tasks, _, project, _, principal := taskService(t)
			ctx := WithLegacyWorkerProtocol(context.Background())
			candidate := claimableTask(t, tasks, principal, project.ID)
			descriptor := workerDescriptor()
			descriptor.Agent, descriptor.AgentControlMode = entry.agent, entry.mode
			_, err := tasks.ClaimWorker(ctx, principal, project.ID, candidate.ID, ClaimWorker{Version: candidate.Version, WorkerDescriptor: descriptor})
			requireFault(t, err, "invalid_transition")
			assertTaskUnchanged(t, tasks, principal, candidate)

			claimed := claimWorkerTask(t, tasks, principal, candidate, descriptor)
			for _, version := range []int64{claimed.Version - 1, claimed.Version} {
				want := "invalid_transition"
				if version != claimed.Version {
					want = "version_conflict"
				}
				_, err = tasks.Update(ctx, principal, project.ID, claimed.ID, UpdateTask{Version: version, Title: pointer("Must not change")})
				requireFault(t, err, want)
				_, err = tasks.SetStatus(ctx, principal, project.ID, claimed.ID, SetTaskStatus{Version: version, Status: core.TaskDone, ClaimID: &descriptor.ClaimID})
				requireFault(t, err, want)
				_, err = tasks.ReleaseWorker(ctx, principal, project.ID, claimed.ID, ReleaseWorker{Version: version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
				requireFault(t, err, want)
				assertTaskUnchanged(t, tasks, principal, claimed)
			}
			_, err = tasks.ReleaseWorker(ctx, principal, project.ID, claimed.ID, ReleaseWorker{Version: claimed.Version - 1, ClaimID: "invalid", StoppedConfirmed: true})
			requireFault(t, err, "invalid_input")
			assertTaskUnchanged(t, tasks, principal, claimed)

			released, err := tasks.ReleaseWorker(context.Background(), principal, project.ID, claimed.ID, ReleaseWorker{Version: claimed.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
			if err != nil {
				t.Fatal(err)
			}
			err = tasks.Delete(ctx, principal, project.ID, released.ID, DeleteTask{Version: released.Version})
			requireFault(t, err, "invalid_transition")
			for _, next := range []WorkerDescriptor{descriptor, workerDescriptor()} {
				_, err = tasks.ResumeWorker(ctx, principal, project.ID, released.ID, ResumeWorker{ClaimWorker: ClaimWorker{Version: released.Version, WorkerDescriptor: next}, PreviousClaimID: descriptor.ClaimID})
				requireFault(t, err, "invalid_transition")
				assertTaskUnchanged(t, tasks, principal, released)
			}
		})
	}
}

func TestLegacyWorkerCompatibilityPreservesHistoricalMode(t *testing.T) {
	if !LegacyWorkerCompatible(nil) {
		t.Fatal("manual tasks must remain compatible")
	}
	for _, agent := range []core.WorkerAgent{core.AgentCodex, core.AgentCopilot, core.AgentClaude, "unknown"} {
		for _, mode := range []core.WorkerAgentControlMode{"", core.AgentControlModeHerdr, core.AgentControlModeWeb, "unknown"} {
			want := (mode == "" || mode == core.AgentControlModeHerdr) && (agent == core.AgentCodex || agent == core.AgentCopilot)
			if got := LegacyWorkerCompatible(&core.WorkerClaim{Agent: agent, AgentControlMode: mode}); got != want {
				t.Errorf("compatibility for %q/%q = %t, want %t", mode, agent, got, want)
			}
		}
	}
}
