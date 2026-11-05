package service

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestWorkerClaimRequiresAuthenticatedAssignee(t *testing.T) {
	tasks, database, project, _, admin := taskService(t)
	owner := workerMember(t, database, project.ID)
	other := workerMember(t, database, project.ID)
	for _, claimant := range []model.Principal{owner, admin} {
		for _, assigned := range []*string{nil, &other.UserID, &claimant.UserID} {
			before := createAssignedTask(t, tasks, admin, project.ID, assigned)
			before = updateTask(t, tasks, admin, before, UpdateTask{AllowAgents: pointer(true)})
			descriptor := workerDescriptor()
			after, err := tasks.ClaimWorker(context.Background(), claimant, project.ID, before.ID, ClaimWorker{Version: before.Version, WorkerDescriptor: descriptor})
			if assigned == nil || *assigned != claimant.UserID {
				requireFault(t, err, "invalid_transition")
				assertTaskUnchanged(t, tasks, admin, before)
				continue
			}
			if err != nil {
				t.Fatal(err)
			}
			worker := testWorker(t, after.Properties)
			if after.Status != model.TaskInProgress || !equalOptional(after.AssignedTo, assigned) || worker.UserID != claimant.UserID || worker.WorkerID != descriptor.WorkerID {
				t.Fatalf("claim did not bind the authenticated assignee: %#v", after)
			}
		}
	}
}
