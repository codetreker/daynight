package worker

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type configurationDAO struct {
	current                                        model.WorkerConfigurationResource
	readErr, accessErr, desiredErr, observationErr error
	accesses                                       []string
	desiredWrites, observationWrites               int
	scopes                                         [][2]string
	accessUsers                                    []string
}

func (d *configurationDAO) ReportTaskSnapshots(context.Context, string, model.WorkerTaskInventory) ([]store.WorkerTaskSource, error) {
	panic("unexpected task read")
}
func (d *configurationDAO) UpsertWorker(context.Context, model.WorkerSnapshot) (model.WorkerSnapshot, error) {
	panic("unexpected worker write")
}
func (d *configurationDAO) WorkerConfiguration(_ context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
	d.scopes = append(d.scopes, [2]string{user, worker})
	return d.current, d.readErr
}
func (d *configurationDAO) ConfigurationProjectAccess(_ context.Context, user, project string) error {
	d.accessUsers = append(d.accessUsers, user)
	d.accesses = append(d.accesses, project)
	return d.accessErr
}
func (d *configurationDAO) SetWorkerConfiguration(_ context.Context, user, worker string, revision int64, value model.WorkerConfiguration) (model.WorkerDesiredConfiguration, error) {
	d.scopes = append(d.scopes, [2]string{user, worker})
	d.desiredWrites++
	return model.WorkerDesiredConfiguration{Revision: strconv.FormatInt(revision, 10), Value: value}, d.desiredErr
}
func (d *configurationDAO) SetWorkerConfigurationObservation(_ context.Context, user, worker string, _ int64, _ model.WorkerConfigurationObservation) error {
	d.scopes = append(d.scopes, [2]string{user, worker})
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

func checkedConfigurationScope(t *testing.T, d *configurationDAO) *configurationDAO {
	t.Helper()
	t.Cleanup(func() {
		for _, scope := range d.scopes {
			if scope != [2]string{"user", "worker"} {
				t.Errorf("configuration operation used another owner or worker: %v", scope)
			}
		}
		for _, user := range d.accessUsers {
			if user != "user" {
				t.Errorf("configuration project admission used another owner: %q", user)
			}
		}
	})
	return d
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
	d = checkedConfigurationScope(t, configuredDAO("1"))
	d.current.Desired.Value.MaxConcurrent = 2
	d.current.Desired.Value.Projects = []model.WorkerProjectConfiguration{project}
	d.accessErr = model.ErrNotFound
	value = d.current.Desired.Value
	if _, err = PutConfiguration(ctx, d, principal, "worker", 1, value); err != nil || len(d.accesses) != 0 || d.desiredWrites != 0 {
		t.Fatalf("unchanged revoked project must remain: %v", err)
	}
	value.MaxConcurrent = 4
	got, err = PutConfiguration(ctx, d, principal, "worker", 1, value)
	if err != nil || got.Desired.Revision != "2" || got.Desired.Value.MaxConcurrent != 4 || len(d.accesses) != 0 || d.desiredWrites != 1 {
		t.Fatalf("unrelated edit rechecked revoked project: %+v %v", got, err)
	}
	d.current.Desired = &model.WorkerDesiredConfiguration{Revision: "2", Value: value}
	changed := value
	changed.Projects = []model.WorkerProjectConfiguration{{ProjectID: configurationInputProjectA, NativeOverrides: map[string]json.RawMessage{"model": json.RawMessage(`null`)}}}
	_, err = PutConfiguration(ctx, d, principal, "worker", 2, changed)
	if fault := requireFault(t, err, "not_found"); fault.Message != "A selected project was not found or is inaccessible." || d.desiredWrites != 1 {
		t.Fatalf("changed inaccessible project: %s, writes=%d", fault.Message, d.desiredWrites)
	}
	if len(d.accesses) != 1 || d.accesses[0] != configurationInputProjectA {
		t.Fatalf("changed project admission: %v", d.accesses)
	}
	d.accesses = nil
	value.Projects = []model.WorkerProjectConfiguration{}
	got, err = PutConfiguration(ctx, d, principal, "worker", 2, value)
	if err != nil || got.Desired.Revision != "3" || len(d.accesses) != 0 || d.desiredWrites != 2 {
		t.Fatalf("revoked project must be removable: %+v %v", got, err)
	}
	d.current.Desired = &model.WorkerDesiredConfiguration{Revision: "3", Value: value}
	value.Projects = []model.WorkerProjectConfiguration{project}
	_, err = PutConfiguration(ctx, d, principal, "worker", 3, value)
	requireFault(t, err, "not_found")
	if len(d.accesses) != 1 || d.accesses[0] != configurationInputProjectA || d.desiredWrites != 2 {
		t.Fatalf("reselected revoked project bypassed admission: %+v", d)
	}
	d.accesses = nil
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

func TestPutConfigurationNormalizesStoredJSONBeforeNoopAndProjectAdmission(t *testing.T) {
	for _, lostAccess := range []bool{false, true} {
		t.Run(strconv.FormatBool(lostAccess), func(t *testing.T) {
			value := configurationFixture()
			value.MaxConcurrent = 2
			value.Projects = []model.WorkerProjectConfiguration{{ProjectID: configurationInputProjectA, NativeOverrides: map[string]json.RawMessage{
				"args":  json.RawMessage(`["--foo","b\u0061r","quote\"value","\\path","中文"]`),
				"model": json.RawMessage(`"model/\u006eame"`),
			}}}
			incoming, err := NormalizeConfiguration(value)
			if err != nil {
				t.Fatal(err)
			}
			stored := configurationFixture()
			stored.MaxConcurrent = 2
			stored.Projects = []model.WorkerProjectConfiguration{{ProjectID: configurationInputProjectA, NativeOverrides: map[string]json.RawMessage{
				"args":  json.RawMessage(`["--foo", "bar", "quote\"value", "\\path", "中文"]`),
				"model": json.RawMessage(`"model/name"`),
			}}}
			stamp := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
			d := checkedConfigurationScope(t, configuredDAO("1"))
			d.current.Desired = &model.WorkerDesiredConfiguration{Revision: "1", UpdatedAt: stamp, Value: stored}
			if lostAccess {
				d.accessErr = model.ErrNotFound
				incoming.MaxConcurrent++
			}
			got, err := PutConfiguration(context.Background(), d, model.Principal{UserID: "user"}, "worker", 1, incoming)
			if err != nil || !reflect.DeepEqual(got.Desired.Value, incoming) || len(d.accesses) != 0 {
				t.Fatalf("equivalent stored project JSON caused admission: %+v accesses=%v %v", got, d.accesses, err)
			}
			if lostAccess {
				if got.Desired.Revision != "2" || d.desiredWrites != 1 {
					t.Fatalf("unrelated edit not applied: %+v writes=%d", got, d.desiredWrites)
				}
			} else if got.Desired.Revision != "1" || !got.Desired.UpdatedAt.Equal(stamp) || d.desiredWrites != 0 {
				t.Fatalf("equivalent stored JSON changed configuration: %+v writes=%d", got, d.desiredWrites)
			}
		})
	}
}

func TestPutConfigurationPreferenceToggleUsesConfigurationRevision(t *testing.T) {
	ctx, principal := context.Background(), model.Principal{UserID: "user"}
	d := configuredDAO("3")
	value := configurationFixture()
	value.PreferPlatformSpecificTasks = true
	got, err := PutConfiguration(ctx, d, principal, "worker", 3, value)
	if err != nil || got.Desired.Revision != "4" || !got.Desired.Value.PreferPlatformSpecificTasks || d.desiredWrites != 1 {
		t.Fatalf("enabling preference did not create its desired revision: %+v %v", got, err)
	}
	d.current = got
	got, err = PutConfiguration(ctx, d, principal, "worker", 4, value)
	if err != nil || got.Desired.Revision != "4" || d.desiredWrites != 1 {
		t.Fatalf("same preference changed configuration: %+v %v", got, err)
	}
	value.PreferPlatformSpecificTasks = false
	got, err = PutConfiguration(ctx, d, principal, "worker", 4, value)
	if err != nil || got.Desired.Revision != "5" || got.Desired.Value.PreferPlatformSpecificTasks || d.desiredWrites != 2 {
		t.Fatalf("disabling preference was lost: %+v %v", got, err)
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
	d = checkedConfigurationScope(t, configuredDAO(strconv.FormatInt(math.MaxInt64, 10)))
	unchanged, err := PutConfiguration(ctx, d, principal, "worker", math.MaxInt64, value)
	if err != nil || unchanged.Desired.Revision != strconv.FormatInt(math.MaxInt64, 10) || d.desiredWrites != 0 {
		t.Fatalf("maximum revision no-op changed state: %+v %v", unchanged, err)
	}
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

func TestPutConfigurationRejectsUnencodableStoredOverride(t *testing.T) {
	d := configuredDAO("1")
	d.current.Desired.Value.Projects = []model.WorkerProjectConfiguration{{
		ProjectID:       configurationInputProjectA,
		NativeOverrides: map[string]json.RawMessage{"args": json.RawMessage(`invalid`)},
	}}
	_, err := PutConfiguration(context.Background(), d, model.Principal{UserID: "user"}, "worker", 1, configurationFixture())
	requireFault(t, err, "invalid_input")
	if d.desiredWrites != 0 || len(d.accesses) != 0 {
		t.Fatalf("unencodable stored configuration caused project reads or writes: %+v", d)
	}
}

func TestExchangeConfigurationBootstrapAndIndependentObservationCAS(t *testing.T) {
	ctx, principal, value := context.Background(), model.Principal{UserID: "user"}, configurationFixture()
	d := &configurationDAO{current: model.WorkerConfigurationResource{ObservationRevision: "0"}}
	observation := &model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1", Items: []model.WorkerConfigurationItem{}}
	receipt, err := ExchangeConfiguration(ctx, d, principal, "worker", model.WorkerConfigurationExchange{Bootstrap: &value, Observation: observation})
	if err != nil || receipt.Desired.Revision != "1" || !receipt.ObservationAccepted || receipt.ObservationRevision != "1" || d.desiredWrites != 1 || d.observationWrites != 1 {
		t.Fatalf("bootstrap and observation: %+v %v", receipt, err)
	}
	value.Projects = []model.WorkerProjectConfiguration{{ProjectID: configurationInputProjectA, NativeOverrides: map[string]json.RawMessage{}}}
	d = checkedConfigurationScope(t, &configurationDAO{current: model.WorkerConfigurationResource{ObservationRevision: "0"}})
	receipt, err = ExchangeConfiguration(ctx, d, principal, "worker", model.WorkerConfigurationExchange{Bootstrap: &value})
	if err != nil || receipt.Desired.Revision != "1" || !reflect.DeepEqual(receipt.Desired.Value, value) || d.desiredWrites != 1 || len(d.accesses) != 1 || d.accesses[0] != configurationInputProjectA {
		t.Fatalf("initial selected project configuration: %+v accesses=%v %v", receipt, d.accesses, err)
	}
	value = configurationFixture()
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
