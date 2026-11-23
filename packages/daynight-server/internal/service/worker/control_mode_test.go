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

func TestWorkerReportServiceRejectsPrivateObservationSlotOverBudget(t *testing.T) {
	f := newAdmissionServiceFixture(t)
	observation := f.configuration.Observation
	observation.Items = []model.WorkerConfigurationItem{
		{Key: model.WorkerConfigurationItemKey{Kind: "projectNative", ProjectID: f.worker}, AppliedValue: json.RawMessage(`""`)},
		{Key: model.WorkerConfigurationItemKey{Kind: "archiveSessions"}, AppliedValue: json.RawMessage(`true`)},
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
