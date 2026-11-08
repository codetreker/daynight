package service

import (
	"context"
	"encoding/json"
	"errors"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	"math"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func cloudWorkerConfiguration(projectID string) model.WorkerConfiguration {
	projects := []model.WorkerProjectConfiguration{}
	if projectID != "" {
		projects = append(projects, model.WorkerProjectConfiguration{ProjectID: projectID, NativeOverrides: map[string]json.RawMessage{}})
	}
	return model.WorkerConfiguration{MaxConcurrent: 2, PollIntervalMs: 60000, RecoveryLimit: 3, Native: model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}}, Projects: projects}
}

func importWorkerConfiguration(t *testing.T, workers *workerservice.Workers, principal model.Principal, workerID string, value model.WorkerConfiguration) workerservice.WorkerReportResult {
	t.Helper()
	report := serviceWorkerReport()
	report.Configuration = &model.WorkerConfigurationExchange{Bootstrap: &value}
	result, err := workers.Report(context.Background(), principal, workerID, report)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestWorkerConfigurationRetainsLostProjectsButRejectsChangesAndNewSelections(t *testing.T) {
	_, database, project, _, _ := taskService(t)
	ctx := context.Background()
	workers := workerservice.NewWorkers(database)
	member := workerMember(t, database, project.ID)
	id := uuid.NewString()
	value := cloudWorkerConfiguration(project.ID)
	importWorkerConfiguration(t, workers, member, id, value)
	if _, err := database.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, member.UserID); err != nil {
		t.Fatal(err)
	}
	value.MaxConcurrent = 4
	result, err := workers.PutConfiguration(ctx, member, id, "1", value)
	if err != nil || result.Desired.Revision != "2" {
		t.Fatalf("lost unchanged project blocked unrelated change: %+v %v", result, err)
	}
	value.Projects[0].NativeOverrides = map[string]json.RawMessage{"model": json.RawMessage(`null`)}
	_, err = workers.PutConfiguration(ctx, member, id, "2", value)
	if fault := requireFault(t, err, "not_found"); fault.Message != "A selected project was not found or is inaccessible." {
		t.Fatalf("wrong inaccessible project message: %s", fault.Message)
	}
	value.Projects = []model.WorkerProjectConfiguration{}
	result, err = workers.PutConfiguration(ctx, member, id, "2", value)
	if err != nil || result.Desired.Revision != "3" {
		t.Fatalf("lost project removal failed: %+v %v", result, err)
	}
	value.Projects = []model.WorkerProjectConfiguration{{ProjectID: project.ID, NativeOverrides: map[string]json.RawMessage{}}}
	_, err = workers.PutConfiguration(ctx, member, id, "3", value)
	requireFault(t, err, "not_found")
}

func TestWorkerConfigurationRevisionExhaustionAndRollback(t *testing.T) {
	_, database, _, principal := projectService(t)
	ctx := context.Background()
	workers := workerservice.NewWorkers(database)
	id := uuid.NewString()
	value := cloudWorkerConfiguration("")
	importWorkerConfiguration(t, workers, principal, id, value)
	high := strconv.FormatInt(math.MaxInt64, 10)
	if _, err := database.Pool.Exec(ctx, `UPDATE workers SET configuration_revision=$3,configuration_observation_revision=$3 WHERE user_id=$1 AND worker_id=$2`, principal.UserID, id, int64(math.MaxInt64)); err != nil {
		t.Fatal(err)
	}
	noop, err := workers.PutConfiguration(ctx, principal, id, high, value)
	if err != nil || noop.Desired.Revision != high {
		t.Fatalf("max revision no-op: %+v %v", noop, err)
	}
	value.MaxConcurrent++
	_, err = workers.PutConfiguration(ctx, principal, id, high, value)
	requireFault(t, err, "version_exhausted")
	report := serviceWorkerReport()
	report.Configuration = &model.WorkerConfigurationExchange{Observation: &model.WorkerConfigurationObservation{BaseRevision: high, DesiredRevision: high, Items: []model.WorkerConfigurationItem{}}}
	_, err = workers.Report(ctx, principal, id, report)
	requireFault(t, err, "version_exhausted")
	before, err := workers.Get(ctx, principal, id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE workers SET configuration_observation_revision=0; CREATE FUNCTION refuse_config_observation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.configuration_observation_revision <> OLD.configuration_observation_revision THEN RAISE EXCEPTION 'injected configuration observation failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_config_observation BEFORE UPDATE ON workers FOR EACH ROW EXECUTE FUNCTION refuse_config_observation()`); err != nil {
		t.Fatal(err)
	}
	report.Telemetry.Machine.Name = "Must roll back"
	report.Configuration.Observation.BaseRevision = "0"
	_, err = workers.Report(ctx, principal, id, report)
	var fault *model.Fault
	var pgError *pgconn.PgError
	if err == nil || errors.As(err, &fault) || !errors.As(err, &pgError) || !strings.Contains(pgError.Message, "injected configuration observation failure") {
		t.Fatalf("database failure hidden: %v", err)
	}
	after, err := workers.Get(ctx, principal, id)
	if err != nil || !reflect.DeepEqual(before.Worker, after.Worker) {
		t.Fatalf("partial heartbeat transaction committed: %+v %v", after, err)
	}
}

func TestWorkerConfigurationConcurrentObservationSingleWinner(t *testing.T) {
	_, database, _, principal := projectService(t)
	workers := workerservice.NewWorkers(database)
	id := uuid.NewString()
	importWorkerConfiguration(t, workers, principal, id, cloudWorkerConfiguration(""))
	ctx := context.Background()
	var wg sync.WaitGroup
	results := make(chan workerservice.WorkerReportResult, 2)
	failures := make(chan error, 2)
	barrier := make(chan struct{})
	for range 2 {
		wg.Go(func() {
			<-barrier
			report := serviceWorkerReport()
			report.Configuration = &model.WorkerConfigurationExchange{Observation: &model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{}}}
			result, err := workers.Report(ctx, principal, id, report)
			results <- result
			failures <- err
		})
	}
	close(barrier)
	wg.Wait()
	accepted := 0
	for range 2 {
		result, err := <-results, <-failures
		if err != nil {
			t.Fatal(err)
		}
		if result.Configuration.ObservationAccepted {
			accepted++
		}
		if result.Configuration.ObservationRevision != "1" {
			t.Fatalf("observation version: %+v", result)
		}
	}
	if accepted != 1 {
		t.Fatalf("observation CAS winners: %d", accepted)
	}
}

func TestWorkerConfigurationJSONBRoundtripPreservesSemanticEquality(t *testing.T) {
	for _, test := range []struct {
		name       string
		lostAccess bool
	}{{"identical PUT", false}, {"unrelated edit with lost access", true}} {
		t.Run(test.name, func(t *testing.T) {
			_, database, project, _, _ := taskService(t)
			principal := workerMember(t, database, project.ID)
			ctx := context.Background()
			workers := workerservice.NewWorkers(database)
			id := uuid.NewString()
			value := cloudWorkerConfiguration(project.ID)
			value.Projects[0].NativeOverrides = map[string]json.RawMessage{
				"args":  json.RawMessage(`["--foo","b\u0061r","quote\"value","\\path","中文"]`),
				"model": json.RawMessage(`"model/\u006eame"`),
			}
			imported := importWorkerConfiguration(t, workers, principal, id, value)
			read, err := workers.Configuration(ctx, principal, id)
			if err != nil {
				t.Fatal(err)
			}
			if test.lostAccess {
				if _, err := database.Pool.Exec(ctx, `DELETE FROM project_grants WHERE project_id=$1 AND user_id=$2`, project.ID, principal.UserID); err != nil {
					t.Fatal(err)
				}
				read.Desired.Value.MaxConcurrent++
			}
			result, err := workers.PutConfiguration(ctx, principal, id, "1", read.Desired.Value)
			if err != nil {
				t.Fatalf("semantically unchanged project was rejected after JSONB roundtrip: %v", err)
			}
			if test.lostAccess {
				if result.Desired.Revision != "2" || result.Desired.Value.MaxConcurrent != 3 {
					t.Fatalf("unrelated scalar update was not applied: %+v", result)
				}
			} else if result.Desired.Revision != "1" || !result.Desired.UpdatedAt.Equal(imported.Configuration.Desired.UpdatedAt) {
				t.Fatalf("identical PUT changed configuration after JSONB roundtrip: %+v", result.Desired)
			}
		})
	}
}

func TestWorkerConfigurationRejectsUnencodableOverrides(t *testing.T) {
	value := cloudWorkerConfiguration("")
	value.Projects = []model.WorkerProjectConfiguration{{ProjectID: uuid.NewString(), NativeOverrides: map[string]json.RawMessage{"args": json.RawMessage(`invalid`)}}}
	_, err := workercore.NormalizeConfiguration(value)
	requireFault(t, err, "invalid_input")
}
