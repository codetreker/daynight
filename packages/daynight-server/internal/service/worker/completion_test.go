package worker

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type unconfirmedWriter struct{ outcome store.TransactionOutcome }

func (u unconfirmedWriter) ReadSnapshot(context.Context, func(store.SnapshotScope) error) error {
	panic("unexpected read")
}
func (u unconfirmedWriter) WriteWorker(context.Context, func(store.WorkerScope) error) (store.Completion, error) {
	return store.Completion{Outcome: u.outcome}, nil
}

func TestUnconfirmedWorkerWritesDoNotReturnSuccess(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	id := uuid.NewString()
	now := time.Now().UTC()
	code := "unavailable"
	report := model.WorkerReport{Telemetry: model.WorkerTelemetry{
		Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "worker"}, Platform: model.PlatformLinux,
		WorkingDirectory: "/work", SampledAt: now,
		OS:       model.WorkerProbe[model.WorkerOS]{State: "error", CheckedAt: now, Code: &code},
		CPU:      model.WorkerProbe[model.WorkerCPU]{State: "error", CheckedAt: now, Code: &code},
		Memory:   model.WorkerProbe[model.WorkerMemory]{State: "error", CheckedAt: now, Code: &code},
		Disk:     model.WorkerProbe[model.WorkerDisk]{State: "error", CheckedAt: now, Code: &code},
		Versions: model.WorkerVersions{Daynight: "1", Herdr: model.WorkerProbe[string]{State: "error", CheckedAt: now, Code: &code}, Codex: model.WorkerProbe[string]{State: "error", CheckedAt: now, Code: &code}, Copilot: model.WorkerProbe[string]{State: "error", CheckedAt: now, Code: &code}},
	}}
	configuration := model.WorkerConfiguration{MaxConcurrent: 2, PollIntervalMs: 60000, RecoveryLimit: 3, Native: model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}}, Projects: []model.WorkerProjectConfiguration{}}
	for _, outcome := range []store.TransactionOutcome{store.TransactionUnknown, store.TransactionNotCommitted} {
		workers := NewWorkers(unconfirmedWriter{outcome})
		if _, err := workers.Report(context.Background(), principal, id, report); err == nil || !strings.Contains(err.Error(), "transaction did not confirm commit") {
			t.Fatalf("report accepted %s: %v", outcome, err)
		}
		if _, err := workers.PutConfiguration(context.Background(), principal, id, "1", configuration); err == nil || !strings.Contains(err.Error(), "transaction did not confirm commit") {
			t.Fatalf("configuration accepted %s: %v", outcome, err)
		}
	}
}
