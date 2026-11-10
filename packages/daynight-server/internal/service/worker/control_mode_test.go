package worker

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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
