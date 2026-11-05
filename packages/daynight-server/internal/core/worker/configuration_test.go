package worker

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type configurationDAO struct {
	current                                        model.WorkerConfigurationResource
	readErr, accessErr, desiredErr, observationErr error
	accesses                                       []string
	desiredWrites, observationWrites               int
}

func (d *configurationDAO) ReportTaskSnapshots(context.Context, string, model.WorkerTaskInventory) ([]store.WorkerTaskSource, error) {
	panic("unexpected task read")
}
func (d *configurationDAO) UpsertWorker(context.Context, model.WorkerSnapshot) (model.WorkerSnapshot, error) {
	panic("unexpected worker write")
}
func (d *configurationDAO) WorkerConfiguration(context.Context, string, string) (model.WorkerConfigurationResource, error) {
	return d.current, d.readErr
}
func (d *configurationDAO) ConfigurationProjectAccess(_ context.Context, _, project string) error {
	d.accesses = append(d.accesses, project)
	return d.accessErr
}
func (d *configurationDAO) SetWorkerConfiguration(_ context.Context, _, _ string, revision int64, value model.WorkerConfiguration) (model.WorkerDesiredConfiguration, error) {
	d.desiredWrites++
	return model.WorkerDesiredConfiguration{Revision: strconv.FormatInt(revision, 10), Value: value}, d.desiredErr
}
func (d *configurationDAO) SetWorkerConfigurationObservation(_ context.Context, _, _ string, _ int64, _ model.WorkerConfigurationObservation) error {
	d.observationWrites++
	return d.observationErr
}

func configurationFixture() model.WorkerConfiguration {
	return model.WorkerConfiguration{MaxConcurrent: 1, PollIntervalMs: 60000, RecoveryLimit: 3,
		Native: model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}}, Projects: []model.WorkerProjectConfiguration{}}
}
func configuredDAO(revision string) *configurationDAO {
	return &configurationDAO{current: model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Revision: revision, Value: configurationFixture()}, ObservationRevision: "0"}}
}

func TestPutConfigurationCASNoopAndProjectAdmission(t *testing.T) {
	ctx, principal := context.Background(), model.Principal{UserID: "user"}
	d := configuredDAO("3")
	value := configurationFixture()
	got, err := PutConfiguration(ctx, d, principal, "worker", 3, value)
	if err != nil || got.Desired.Revision != "3" || d.desiredWrites != 0 {
		t.Fatalf("no-op changed revision: %+v %v", got, err)
	}
	value.MaxConcurrent = 2
	got, err = PutConfiguration(ctx, d, principal, "worker", 3, value)
	if err != nil || got.Desired.Revision != "4" || d.desiredWrites != 1 {
		t.Fatalf("desired update: %+v %v", got, err)
	}
	_, err = PutConfiguration(ctx, d, principal, "worker", 2, value)
	requireFault(t, err, "version_conflict")

	project := model.WorkerProjectConfiguration{ProjectID: configurationInputProjectA, NativeOverrides: map[string]json.RawMessage{}}
	d.current.Desired.Value.Projects = []model.WorkerProjectConfiguration{project}
	d.accessErr = model.ErrNotFound
	value = d.current.Desired.Value
	if _, err = PutConfiguration(ctx, d, principal, "worker", 3, value); err != nil || len(d.accesses) != 0 {
		t.Fatalf("unchanged revoked project must remain: %v", err)
	}
	value.Projects = []model.WorkerProjectConfiguration{}
	if _, err = PutConfiguration(ctx, d, principal, "worker", 3, value); err != nil || len(d.accesses) != 0 {
		t.Fatalf("revoked project must be removable: %v", err)
	}
	value.Projects = []model.WorkerProjectConfiguration{{ProjectID: configurationInputProjectB, NativeOverrides: map[string]json.RawMessage{}}}
	_, err = PutConfiguration(ctx, d, principal, "worker", 3, value)
	requireFault(t, err, "not_found")
	if len(d.accesses) != 1 || d.accesses[0] != configurationInputProjectB {
		t.Fatalf("wrong project admission: %v", d.accesses)
	}
	failure := errors.New("access unavailable")
	d.accessErr = failure
	if _, err = PutConfiguration(ctx, d, principal, "worker", 3, value); !errors.Is(err, failure) {
		t.Fatalf("access failure lost: %v", err)
	}
}

func TestPutConfigurationFailuresAndExhaustion(t *testing.T) {
	ctx, principal, value := context.Background(), model.Principal{UserID: "user"}, configurationFixture()
	sentinel := errors.New("database failure")
	d := &configurationDAO{readErr: model.ErrNotFound}
	_, err := PutConfiguration(ctx, d, principal, "worker", 1, value)
	requireFault(t, err, "not_found")
	d.readErr = sentinel
	if _, err = PutConfiguration(ctx, d, principal, "worker", 1, value); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	d.readErr = nil
	_, err = PutConfiguration(ctx, d, principal, "worker", 1, value)
	requireFault(t, err, "configuration_not_initialized")
	d = configuredDAO("1")
	d.current.Desired.Value.Native.Args = nil
	_, err = PutConfiguration(ctx, d, principal, "worker", 1, value)
	requireFault(t, err, "invalid_input")
	d = configuredDAO(strconv.FormatInt(math.MaxInt64, 10))
	value.MaxConcurrent++
	_, err = PutConfiguration(ctx, d, principal, "worker", math.MaxInt64, value)
	requireFault(t, err, "version_exhausted")
	d = configuredDAO("1")
	d.desiredErr = sentinel
	if _, err = PutConfiguration(ctx, d, principal, "worker", 1, value); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	value.Projects = []model.WorkerProjectConfiguration{{ProjectID: configurationInputProjectA, NativeOverrides: map[string]json.RawMessage{"args": json.RawMessage(`invalid`)}}}
	_, err = NormalizeConfiguration(value)
	requireFault(t, err, "invalid_input")
}

func TestExchangeConfigurationBootstrapAndIndependentObservationCAS(t *testing.T) {
	ctx, principal, value := context.Background(), model.Principal{UserID: "user"}, configurationFixture()
	d := &configurationDAO{current: model.WorkerConfigurationResource{ObservationRevision: "0"}}
	observation := &model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{}}
	receipt, err := ExchangeConfiguration(ctx, d, principal, "worker", model.WorkerConfigurationExchange{Bootstrap: &value, Observation: observation})
	if err != nil || receipt.Desired.Revision != "1" || !receipt.ObservationAccepted || receipt.ObservationRevision != "1" || d.desiredWrites != 1 || d.observationWrites != 1 {
		t.Fatalf("bootstrap and observation: %+v %v", receipt, err)
	}
	d = configuredDAO("4")
	d.current.ObservationRevision = "2"
	receipt, err = ExchangeConfiguration(ctx, d, principal, "worker", model.WorkerConfigurationExchange{Bootstrap: &value, Observation: observation})
	if err != nil || receipt.Desired.Revision != "4" || receipt.ObservationRevision != "2" || receipt.ObservationAccepted || d.desiredWrites != 0 || d.observationWrites != 0 {
		t.Fatalf("stale observation or bootstrap overwrote cloud: %+v %v", receipt, err)
	}
	observation.BaseRevision, observation.DesiredRevision = "2", "5"
	_, err = ExchangeConfiguration(ctx, d, principal, "worker", model.WorkerConfigurationExchange{Observation: observation})
	requireFault(t, err, "invalid_input")
	observation.DesiredRevision = "4"
	d.current.ObservationRevision = strconv.FormatInt(math.MaxInt64, 10)
	observation.BaseRevision = d.current.ObservationRevision
	_, err = ExchangeConfiguration(ctx, d, principal, "worker", model.WorkerConfigurationExchange{Observation: observation})
	requireFault(t, err, "version_exhausted")
}

func TestExchangeConfigurationFailurePaths(t *testing.T) {
	ctx, principal, value := context.Background(), model.Principal{UserID: "user"}, configurationFixture()
	sentinel := errors.New("database failure")
	d := &configurationDAO{readErr: sentinel}
	if _, err := ExchangeConfiguration(ctx, d, principal, "worker", model.WorkerConfigurationExchange{}); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	d = &configurationDAO{current: model.WorkerConfigurationResource{ObservationRevision: "0"}}
	obs := &model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1"}
	_, err := ExchangeConfiguration(ctx, d, principal, "worker", model.WorkerConfigurationExchange{Observation: obs})
	requireFault(t, err, "invalid_input")
	value.Projects = []model.WorkerProjectConfiguration{{ProjectID: configurationInputProjectA, NativeOverrides: map[string]json.RawMessage{}}}
	d.accessErr = model.ErrNotFound
	_, err = ExchangeConfiguration(ctx, d, principal, "worker", model.WorkerConfigurationExchange{Bootstrap: &value})
	requireFault(t, err, "not_found")
	d.accessErr = nil
	d.desiredErr = sentinel
	if _, err = ExchangeConfiguration(ctx, d, principal, "worker", model.WorkerConfigurationExchange{Bootstrap: &value}); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	d = configuredDAO("1")
	d.observationErr = sentinel
	if _, err = ExchangeConfiguration(ctx, d, principal, "worker", model.WorkerConfigurationExchange{Observation: obs}); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
}
