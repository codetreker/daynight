package worker

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

func TestReportRejectsOversizedMergedSnapshotAtomically(t *testing.T) {
	_, database, _, principal := testsupport.ProjectService(t)
	ctx := context.Background()
	workers := NewWorkers(database)
	for _, state := range []model.WorkerTaskObservationState{model.WorkerTasksObserved, model.WorkerTasksStale, model.WorkerTasksUnavailable} {
		t.Run(string(state), func(t *testing.T) {
			id := uuid.NewString()
			config := cloudWorkerConfiguration("")
			importWorkerConfiguration(t, workers, principal, id, config)
			now := time.Now().UTC()
			old := model.WorkerTaskObservation{State: state, ObservedAt: &now, InventoryObservedAt: &now, Items: []model.WorkerObservedTask{{ProjectID: uuid.NewString(), TaskID: uuid.NewString(), ClaimID: uuid.NewString(), Title: strings.Repeat("x", workercore.MaxWorkerJSONBytes), ProjectName: "Project", Status: model.TaskInProgress, Phase: model.WorkerPreparing, Agent: model.AgentCodex}}}
			raw, err := json.Marshal(old)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := database.Pool.Exec(ctx, "UPDATE workers SET task_snapshot=$3 WHERE user_id=$1 AND worker_id=$2", principal.UserID, id, raw); err != nil {
				t.Fatal(err)
			}
			var before, after string
			query := "SELECT row_to_json(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2"
			if err := database.Pool.QueryRow(ctx, query, principal.UserID, id).Scan(&before); err != nil {
				t.Fatal(err)
			}
			report := serviceWorkerReport()
			report.Telemetry.Machine.Name = "Changed"
			report.Configuration = &model.WorkerConfigurationExchange{Observation: &model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{}}}
			_, err = workers.Report(ctx, principal, id, report)
			requireFault(t, err, "invalid_input")
			if err := database.Pool.QueryRow(ctx, query, principal.UserID, id).Scan(&after); err != nil {
				t.Fatal(err)
			}
			if before != after {
				t.Fatal("rejected report changed stored worker")
			}
		})
	}
}

func TestObservationWrapperBudgetRollsBackReport(t *testing.T) {
	_, database, _, principal := testsupport.ProjectService(t)
	ctx := context.Background()
	workers := NewWorkers(database)
	id := uuid.NewString()
	importWorkerConfiguration(t, workers, principal, id, cloudWorkerConfiguration(""))
	observation := model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: make([]model.WorkerConfigurationItem, 8)}
	args := make([][]string, len(observation.Items))
	for i := range args {
		args[i] = make([]string, workercore.MaxNativeArgs)
		for j := range args[i] {
			args[i][j] = strings.Repeat("x", workercore.MaxNativeArgBytes)
		}
		observation.Items[i] = model.WorkerConfigurationItem{Key: model.WorkerConfigurationItemKey{Kind: "projectNative", ProjectID: uuid.NewString()}, TargetRevision: "1", State: "applied"}
	}
	update := func() []byte {
		for i := range args {
			raw, err := json.Marshal(model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: args[i]})
			if err != nil {
				t.Fatal(err)
			}
			observation.Items[i].AppliedValue = raw
		}
		raw, err := json.Marshal(observation)
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	raw := update()
	excess := len(raw) - (workercore.MaxConfigurationJSONBytes - 16)
	if excess <= 0 {
		t.Fatalf("fixture is too small: %d", len(raw))
	}
	for i := range args {
		for j := range args[i] {
			reduce := min(excess, len(args[i][j])-1)
			args[i][j] = args[i][j][:len(args[i][j])-reduce]
			excess -= reduce
			if excess == 0 {
				break
			}
		}
		if excess == 0 {
			break
		}
	}
	if excess != 0 {
		t.Fatal("could not tune fixture")
	}
	raw = update()
	wrapped, err := json.Marshal(model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: observation, ReportedAt: time.Now().UTC()})
	if err != nil || len(raw) > workercore.MaxConfigurationJSONBytes || len(wrapped) <= workercore.MaxConfigurationJSONBytes {
		t.Fatalf("invalid fixture: raw %d wrapped %d: %v", len(raw), len(wrapped), err)
	}
	query := "SELECT row_to_json(w)::text FROM workers w WHERE user_id=$1 AND worker_id=$2"
	var before, after string
	if err := database.Pool.QueryRow(ctx, query, principal.UserID, id).Scan(&before); err != nil {
		t.Fatal(err)
	}
	report := serviceWorkerReport()
	report.Configuration = &model.WorkerConfigurationExchange{Observation: &observation}
	_, err = workers.Report(ctx, principal, id, report)
	requireFault(t, err, "invalid_input")
	if err := database.Pool.QueryRow(ctx, query, principal.UserID, id).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Fatal("rejected observation changed stored worker")
	}
	// A stale CAS does not persist the large observation and continues to report.
	observation.BaseRevision = "1"
	result, err := workers.Report(ctx, principal, id, report)
	if err != nil || result.Configuration.ObservationAccepted {
		t.Fatal(fmt.Sprintf("stale observation: %+v %v", result, err))
	}
}
