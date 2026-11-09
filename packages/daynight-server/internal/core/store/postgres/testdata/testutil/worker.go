package testutil

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgxpool"
)

func WorkerSnapshotFixture(userID, workerID string, stamp time.Time) model.WorkerSnapshot {
	return model.WorkerSnapshot{
		UserID: userID, WorkerID: workerID, CreatedAt: stamp, LastReportedAt: stamp,
		Telemetry:    model.WorkerTelemetry{Machine: model.WorkerMachine{ID: QueryID(999), Name: "Worker"}, Platform: model.PlatformLinux, WorkingDirectory: "/workspace", SampledAt: stamp},
		TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}},
	}
}

func WorkerStoredUTF8(size int) string {
	return strings.Repeat("界", size/3) + strings.Repeat("x", size%3)
}

func WorkerClaim(number int, userID, workerID string, state model.WorkerState) *model.WorkerClaim {
	return &model.WorkerClaim{ClaimID: QueryID(number + 100), State: state, UserID: userID, WorkerID: workerID,
		Machine: model.WorkerMachine{ID: QueryID(4), Name: "Build"}, Platform: model.PlatformLinux,
		Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: QueryID(number + 200), Phase: model.WorkerPreparing, ClaimedAt: time.Now().UTC()}
}

func WorkerConfiguration() model.WorkerConfiguration {
	return model.WorkerConfiguration{MaxConcurrent: 1, PollIntervalMs: 60000, RecoveryLimit: 3, Native: model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}}, Projects: []model.WorkerProjectConfiguration{}}
}

func WriteWorker(database store.WorkerWriter, ctx context.Context, operation func(store.WorkerScope) error) error {
	_, err := database.WriteWorker(ctx, operation)
	return err
}

func PutWorkerSnapshot(t *testing.T, database store.WorkerWriter, worker model.WorkerSnapshot) model.WorkerSnapshot {
	t.Helper()
	var result model.WorkerSnapshot
	err := WriteWorker(database, context.Background(), func(scope store.WorkerScope) error {
		var err error
		result, err = scope.WorkerDAO().UpsertWorker(context.Background(), worker)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func ReadWorkerSnapshot(t *testing.T, database store.SnapshotReader, userID, workerID string, observedAt time.Time) model.WorkerSnapshot {
	t.Helper()
	var result model.WorkerSnapshot
	err := database.ReadSnapshot(context.Background(), func(snapshot store.SnapshotScope) error {
		var err error
		result, err = snapshot.WorkerDAO().Worker(context.Background(), userID, workerID, observedAt)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func SetSnapshotTaskClaim(t *testing.T, pool *pgxpool.Pool, database store.ProjectWriter, projectID string, taskNumber int, owner, workerID string) model.WorkerTaskReference {
	t.Helper()
	task := QueryTask(t, database, projectID, taskNumber, model.TaskInProgress)
	claim := &model.WorkerClaim{ClaimID: QueryID(taskNumber + 100), State: model.WorkerActive, UserID: owner, WorkerID: workerID,
		Machine: model.WorkerMachine{ID: QueryID(999), Name: "Worker"}, Platform: model.PlatformLinux, Agent: model.AgentClaude,
		AgentControlMode: model.AgentControlModeWeb, WorktreeID: QueryID(taskNumber + 200), Phase: model.WorkerExecuting, ClaimedAt: task.CreatedAt}
	properties := TaskProperties(t, claim)
	PutTaskProperty(t, pool, task.ID, "worker", properties["worker"])
	PutTaskProperty(t, pool, task.ID, "pullRequests", []byte(`[{"url":"\u0000","title":"\ud800"}]`))
	return model.WorkerTaskReference{ProjectID: projectID, TaskID: task.ID, ClaimID: claim.ClaimID}
}
