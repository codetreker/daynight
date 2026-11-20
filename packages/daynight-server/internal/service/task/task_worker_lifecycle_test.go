package task_test

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"testing"
)

func TestClaimWorkerLifecycleRefusalPrecedesClaimMutation(t *testing.T) {
	for _, code := range []string{"worker_disabled", "lifecycle_unavailable"} {
		t.Run(code, func(t *testing.T) {
			current, owner, descriptor := workerTestCurrent(t, "")
			f := workerMockWrite(t, current, owner)
			checks := 0
			f.Admission.check = func(ctx context.Context, user, worker string) error {
				if ctx != f.Context || user != owner.UserID || worker != descriptor.WorkerID {
					t.Fatal("changed gate identity")
				}
				checks++
				return &model.Fault{Code: code, Message: "Worker admission refused."}
			}
			_, err := f.Tasks.ClaimWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor})
			requireFault(t, err, code)
			if checks != 1 {
				t.Fatalf("checks=%d", checks)
			}
		})
	}
}
