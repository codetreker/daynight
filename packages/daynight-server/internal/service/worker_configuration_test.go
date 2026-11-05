package service

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"

	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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

func importWorkerConfiguration(t *testing.T, workers *Workers, principal model.Principal, workerID string, value model.WorkerConfiguration) WorkerReportResult {
	t.Helper()
	report := serviceWorkerReport()
	report.Configuration = &model.WorkerConfigurationExchange{Bootstrap: &value}
	result, err := workers.Report(context.Background(), principal, workerID, report)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestWorkerConfigurationBootstrapCloudAuthorityAndPersistence(t *testing.T) {
	projects, database, _, principal := projectService(t)
	ctx := context.Background()
	workers := NewWorkers(database)
	id := uuid.NewString()
	project, err := projects.Create(ctx, principal, coreproject.CreateProject{Name: "Configuration project", RepoURL: "https://example.com/configuration.git", ExpectedUserID: principal.UserID})
	if err != nil {
		t.Fatal(err)
	}
	value := cloudWorkerConfiguration(project.ID)
	if _, err := workers.Configuration(ctx, principal, id); err == nil {
		t.Fatal("unknown Worker configuration exists")
	}
	legacy := serviceWorkerReport()
	if _, err := workers.Report(ctx, principal, id, legacy); err != nil {
		t.Fatal(err)
	}
	empty, err := workers.Configuration(ctx, principal, id)
	if err != nil || empty.Desired != nil || empty.Observation != nil || empty.ObservationRevision != "0" {
		t.Fatalf("legacy config: %+v %v", empty, err)
	}
	_, err = workers.PutConfiguration(ctx, principal, id, "1", value)
	requireFault(t, err, "configuration_not_initialized")
	_, err = workers.PutConfiguration(ctx, principal, id, "0", value)
	requireFault(t, err, "invalid_input")
	imported := importWorkerConfiguration(t, workers, principal, id, value)
	if imported.Configuration.Desired.Revision != "1" || imported.Configuration.ObservationAccepted {
		t.Fatalf("bootstrap: %+v", imported)
	}
	noop, err := workers.PutConfiguration(ctx, principal, id, "1", value)
	if err != nil || !noop.Desired.UpdatedAt.Equal(imported.Configuration.Desired.UpdatedAt) {
		t.Fatalf("no-op changed version/time: %+v %v", noop, err)
	}
	value.MaxConcurrent = 7
	changed, err := workers.PutConfiguration(ctx, principal, id, "1", value)
	if err != nil || changed.Desired.Revision != "2" {
		t.Fatalf("PUT: %+v %v", changed, err)
	}
	_, err = workers.PutConfiguration(ctx, principal, id, "1", value)
	requireFault(t, err, "version_conflict")
	candidate := cloudWorkerConfiguration(uuid.NewString())
	received := importWorkerConfiguration(t, workers, principal, id, candidate)
	if received.Configuration.Desired.Revision != "2" || received.Configuration.Desired.Value.MaxConcurrent != 7 {
		t.Fatalf("candidate replaced cloud value: %+v", received)
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE workers SET last_seen_at=statement_timestamp()-interval '73 hours' WHERE user_id=$1 AND worker_id=$2`, principal.UserID, id); err != nil {
		t.Fatal(err)
	}
	retained, err := workers.Configuration(ctx, principal, id)
	if err != nil || retained.Desired.Revision != "2" {
		t.Fatalf("configuration expired with telemetry: %+v %v", retained, err)
	}
	_, err = workers.Get(ctx, principal, id)
	requireFault(t, err, "not_found")
	page, err := workers.List(ctx, principal, model.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 0 {
		t.Fatalf("recent list changed: %+v %v", page, err)
	}
	other := servicePrincipal(t, database)
	_, err = workers.Configuration(ctx, other, id)
	requireFault(t, err, "not_found")
	_, err = workers.PutConfiguration(ctx, other, id, "2", value)
	requireFault(t, err, "not_found")
}

func TestWorkerConfigurationConcurrentBootstrapAndIndependentCAS(t *testing.T) {
	_, database, _, principal := projectService(t)
	ctx := context.Background()
	workers := NewWorkers(database)
	id := uuid.NewString()
	barrier := make(chan struct{})
	results := make(chan WorkerReportResult, 2)
	failures := make(chan error, 2)
	for index := range 2 {
		go func(index int) {
			<-barrier
			value := cloudWorkerConfiguration("")
			value.MaxConcurrent = int64(index + 2)
			report := serviceWorkerReport()
			report.Configuration = &model.WorkerConfigurationExchange{Bootstrap: &value}
			result, err := workers.Report(ctx, principal, id, report)
			results <- result
			failures <- err
		}(index)
	}
	close(barrier)
	var chosen int64
	for range 2 {
		result, err := <-results, <-failures
		if err != nil {
			t.Fatal(err)
		}
		if chosen == 0 {
			chosen = result.Configuration.Desired.Value.MaxConcurrent
		}
		if result.Configuration.Desired.Revision != "1" || result.Configuration.Desired.Value.MaxConcurrent != chosen {
			t.Fatalf("bootstrap raced: %+v", result)
		}
	}
	initial, err := workers.Configuration(ctx, principal, id)
	if err != nil {
		t.Fatal(err)
	}
	barrier = make(chan struct{})
	mutations := make(chan error, 2)
	for index := range 2 {
		go func(index int) {
			<-barrier
			value := initial.Desired.Value
			value.MaxConcurrent = int64(index + 10)
			_, err := workers.PutConfiguration(ctx, principal, id, "1", value)
			mutations <- err
		}(index)
	}
	close(barrier)
	winners := 0
	for range 2 {
		err := <-mutations
		if err == nil {
			winners++
		} else {
			requireFault(t, err, "version_conflict")
		}
	}
	if winners != 1 {
		t.Fatalf("CAS winners: %d", winners)
	}
	report := serviceWorkerReport()
	report.Configuration = &model.WorkerConfigurationExchange{Observation: &model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{}}}
	observation, err := workers.Report(ctx, principal, id, report)
	if err != nil || !observation.Configuration.ObservationAccepted || observation.Configuration.Desired.Revision != "2" {
		t.Fatalf("old desired observation versus PUT: %+v %v", observation, err)
	}
	stored, err := workers.Configuration(ctx, principal, id)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Observation.DesiredRevision != "1" || stored.Observation.ReportedAt.IsZero() {
		t.Fatalf("stored observation: %+v", stored)
	}
	stale, err := workers.Report(ctx, principal, id, report)
	if err != nil || stale.Configuration.ObservationAccepted || stale.Configuration.ObservationRevision != "1" {
		t.Fatalf("stale observation: %+v %v", stale, err)
	}
	legacy := serviceWorkerReport()
	if _, err := workers.Report(ctx, principal, id, legacy); err != nil {
		t.Fatal(err)
	}
	after, err := workers.Configuration(ctx, principal, id)
	if err != nil || !reflect.DeepEqual(stored.Observation, after.Observation) {
		t.Fatalf("non-accepted report advanced confirmation: %+v %v", after, err)
	}
	report.Configuration.Observation.BaseRevision = "1"
	report.Configuration.Observation.DesiredRevision = "3"
	_, err = workers.Report(ctx, principal, id, report)
	requireFault(t, err, "invalid_input")
}

func TestWorkerConfigurationRetainsLostProjectsButRejectsChangesAndNewSelections(t *testing.T) {
	_, database, project, _, _ := taskService(t)
	ctx := context.Background()
	workers := NewWorkers(database)
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
	requireFault(t, err, "not_found")
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
	workers := NewWorkers(database)
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

func TestWorkerConfigurationValidationAndTransactionFailures(t *testing.T) {
	_, database, _, principal := projectService(t)
	workers := NewWorkers(database)
	ctx := context.Background()
	id := uuid.NewString()
	value := cloudWorkerConfiguration("")
	for _, operation := range []func(model.Principal, string) error{
		func(p model.Principal, id string) error { _, err := workers.Configuration(ctx, p, id); return err },
		func(p model.Principal, id string) error {
			_, err := workers.PutConfiguration(ctx, p, id, "1", value)
			return err
		},
	} {
		requireFault(t, operation(model.Principal{}, id), "unauthenticated")
		requireFault(t, operation(principal, "invalid"), "invalid_input")
	}
	value.Native.Args = nil
	_, err := workers.PutConfiguration(ctx, principal, id, "1", value)
	requireFault(t, err, "invalid_input")
	value = cloudWorkerConfiguration("")
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := workers.Configuration(canceled, principal, id); !errors.Is(err, context.Canceled) {
		t.Fatalf("read cancellation lost: %v", err)
	}
	if _, err := workers.PutConfiguration(canceled, principal, id, "1", value); !errors.Is(err, context.Canceled) {
		t.Fatalf("write cancellation lost: %v", err)
	}
	// The configuration transaction remains independent even when Task storage is unavailable.
	importWorkerConfiguration(t, workers, principal, id, value)
	if _, err := database.Pool.Exec(ctx, `DROP TABLE tasks CASCADE`); err != nil {
		t.Fatal(err)
	}
	value.MaxConcurrent++
	if _, err := workers.PutConfiguration(ctx, principal, id, "1", value); err != nil {
		t.Fatal(err)
	}
	if result, err := workers.Configuration(ctx, principal, id); err != nil || result.Desired.Revision != "2" {
		t.Fatalf("configuration queried Tasks: %+v %v", result, err)
	}
}

func TestWorkerConfigurationConcurrentObservationSingleWinner(t *testing.T) {
	_, database, _, principal := projectService(t)
	workers := NewWorkers(database)
	id := uuid.NewString()
	importWorkerConfiguration(t, workers, principal, id, cloudWorkerConfiguration(""))
	ctx := context.Background()
	var wg sync.WaitGroup
	results := make(chan WorkerReportResult, 2)
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

func TestWorkerConfigurationRefusalDoesNotHideTransactionFailure(t *testing.T) {
	refusal := &model.Fault{Code: "version_conflict", Message: "Configuration changed."}
	cleanup := errors.New("rollback failed")
	for _, failure := range []*store.TransactionError{
		{Phase: "cleanup", Cause: errors.Join(refusal, cleanup), Outcome: store.TransactionUnknown, CleanupFailed: true},
		{Phase: "commit", Cause: refusal, Outcome: store.TransactionUnknown, CommitAttempted: true},
		{Phase: "operation", Cause: refusal, Outcome: store.TransactionUnknown},
	} {
		err := workerConfigurationError("save worker configuration", failure)
		if err == refusal || !errors.Is(err, failure) {
			t.Fatalf("operational failure replaced with refusal: %v", err)
		}
	}
	failure := &store.TransactionError{Phase: "operation", Cause: refusal, Outcome: store.TransactionNotCommitted}
	if err := workerConfigurationError("save worker configuration", failure); err != refusal {
		t.Fatalf("rolled back refusal not returned: %v", err)
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
			workers := NewWorkers(database)
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
	_, err := normalizeWorkerConfiguration(value)
	requireFault(t, err, "invalid_input")
}
