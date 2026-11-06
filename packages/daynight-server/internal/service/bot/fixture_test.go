package bot

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

func serviceDatabaseURL(t *testing.T) string { return testsupport.ServiceDatabaseURL(t) }
func servicePrincipal(t *testing.T, db *store.Store) model.Principal {
	return testsupport.ServicePrincipal(t, db)
}
func pointer[T any](value T) *T { return &value }

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

func threadWait(t *testing.T, ctx context.Context, condition func() (bool, error)) {
	t.Helper()
	for {
		ok, err := condition()
		if err != nil {
			t.Fatal(err)
		}
		if ok {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func stepsStoredState(t *testing.T, database *store.Store, taskID string, excludeParentRevision bool) string {
	t.Helper()
	var state string
	err := database.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object(
 'task',(SELECT CASE WHEN $2 THEN to_jsonb(t)-'version'-'updated_at' ELSE to_jsonb(t) END FROM tasks t WHERE id=$1),
 'steps',(SELECT jsonb_agg(to_jsonb(s) ORDER BY position) FROM task_steps s WHERE task_id=$1),
 'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY name) FROM task_properties p WHERE task_id=$1),
 'dependencies',(SELECT jsonb_agg(to_jsonb(d) ORDER BY depends_on_task_id) FROM task_dependencies d WHERE task_id=$1),
 'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM task_sessions s WHERE task_id=$1))::text`, taskID, excludeParentRevision).Scan(&state)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func requireFault(t *testing.T, err error, code string) *model.Fault {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code || fault.Message == "" || err.Error() != fault.Message {
		t.Fatalf("expected %s fault, got %#v", code, err)
	}
	return fault
}

type entropyFailure struct{ err error }
