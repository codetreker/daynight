package worker

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

func TestWorkerConfigurationServiceControlModeIntent(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		f := newConfigurationFixture(t)
		if legacy {
			f.value.PreserveAgentControlMode = true
		} else {
			web := model.AgentControlModeWeb
			f.value.AgentControlMode = &web
		}
		f.write(store.Completion{Outcome: store.TransactionCommitted}, nil, nil)
		result, err := f.workers.PutConfiguration(f.calls.ctx, f.principal, f.worker, "1", f.value)
		if err != nil || !reflect.DeepEqual(result, f.provided) {
			t.Fatalf("mode intent legacy=%v: %+v %v", legacy, result, err)
		}
	}
}

func TestWorkerReportServiceRejectsPrivateObservationSlotOverBudget(t *testing.T) {
	f := newAdmissionServiceFixture(t)
	observation := f.configuration.Observation
	observation.Items = []model.WorkerConfigurationItem{
		{Key: model.WorkerConfigurationItemKey{Kind: "projectNative", ProjectID: f.worker}, AppliedValue: json.RawMessage(`""`)},
		{Key: model.WorkerConfigurationItemKey{Kind: "agentControlMode"}, AppliedValue: json.RawMessage(`"web"`)},
	}
	// The DAO readback is supplied independently of the mocked Core exchange.
	// Its public encoding fits, while the actual stored extension exceeds 4 MiB.
	public, err := json.Marshal(observation)
	if err != nil {
		t.Fatal(err)
	}
	observation.Items[0].AppliedValue = json.RawMessage(`"` + strings.Repeat("x", workercore.MaxConfigurationJSONBytes-len(public)) + `"`)
	public, err = json.Marshal(observation)
	if err != nil || len(public) != workercore.MaxConfigurationJSONBytes {
		t.Fatalf("invalid boundary fixture: %d %v", len(public), err)
	}
	f.want = []string{"validate", "parse", "write", "dao", "admission", "admit", "sources", "match", "snapshot", "upsert", "exchange", "configuration", "completion"}
	f.completion = store.Completion{Outcome: store.TransactionNotCommitted}
	result, err := f.service.Report(f.ctx, f.principal, f.worker, f.input)
	requireFault(t, err, "invalid_input")
	requireFault(t, f.callbackError, "invalid_input")
	var violation *limit.Violation
	if !errors.As(err, &violation) || violation.Field != "worker.configuration.observation" || violation.Max != workercore.MaxConfigurationJSONBytes || !reflect.DeepEqual(result, WorkerReportResult{}) {
		t.Fatalf("stored-byte refusal or transaction result suppression lost: %+v %v", result, err)
	}
}

func TestWorkerReportServiceControlModeBootstrapNormalization(t *testing.T) {
	f := newAdmissionServiceFixture(t)
	web := model.AgentControlModeWeb
	f.input.Configuration.Bootstrap.AgentControlMode = &web
	f.input.Configuration.ControlModeBootstrap = &web
	f.parsed = f.input.Configuration
	f.receipt.ObservationAccepted = false
	f.want = []string{"validate", "parse", "write", "dao", "admission", "admit", "sources", "match", "snapshot", "upsert", "exchange", "clock", "completion"}
	f.service.report.parseConfiguration = func(raw json.RawMessage) (*model.WorkerConfigurationExchange, error) {
		f.take("parse")
		got, err := workercore.ParseWorkerConfigurationExchange(raw)
		if err != nil || !reflect.DeepEqual(got, f.parsed) {
			t.Fatalf("control mode exchange normalization: %+v %v", got, err)
		}
		return got, err
	}
	got, err := f.service.Report(f.ctx, f.principal, f.worker, f.input)
	if err != nil || !reflect.DeepEqual(got.Configuration, f.receipt) {
		t.Fatalf("mode report: %+v %v", got, err)
	}
}
