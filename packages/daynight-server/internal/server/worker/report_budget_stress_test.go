//go:build stress

package worker

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

func TestStressWorkerReportBodyLimits(t *testing.T) {
	for _, tc := range []struct {
		name, protocol string
		limit          int
	}{
		{"legacy", "", transport.MaxRESTJSONBodyBytes},
		{"configuration1", "1", transport.MaxWorkerConfigurationReportBytes},
		{"configuration2", "2", transport.MaxWorkerConfigurationReportBytes},
	} {
		for _, extra := range []int{0, 1} {
			t.Run(tc.name+map[int]string{0: "/at_limit", 1: "/over_limit"}[extra], func(t *testing.T) {
				f := newCapacityReportOperationFixture(t, "11111111-1111-4111-8111-111111111111")
				body := workerSnapshotReportBody()
				headers := http.Header{}
				if tc.protocol != "" {
					body["configuration"] = map[string]any{"bootstrap": nil, "observation": nil}
					headers.Set(workerConfigurationHeader, tc.protocol)
				}
				if tc.protocol == "2" {
					headers.Set(workerPromptsHeader, "[]")
				}
				encoded := jsonBody(t, body)
				encoded += strings.Repeat(" ", tc.limit+extra-len(encoded))
				calls := 0
				report := func(_ context.Context, principal model.Principal, worker string, input model.WorkerReport) (service.WorkerReportResult, error) {
					calls++
					if principal != f.handler.principal || worker != f.worker || (input.Configuration != nil) != (tc.protocol != "") || input.TaskInventory == nil {
						t.Errorf("unexpected report arguments: principal=%+v worker=%s input=%+v", principal, worker, input)
					}
					return service.WorkerReportResult{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt, Configuration: &model.WorkerConfigurationReceipt{ObservationRevision: "0"}}, nil
				}
				f.operations.report = report
				f.operations.sync = func(ctx context.Context, principal model.Principal, worker string, input model.WorkerReport, selectors []model.PromptSelector) (service.ConfigurationSyncResult, error) {
					if len(selectors) != 0 {
						t.Errorf("unexpected selectors: %+v", selectors)
					}
					result, err := report(ctx, principal, worker, input)
					return service.ConfigurationSyncResult{Native: result, Prompts: []model.PromptResult{}}, err
				}
				response := controlModeRequest(t, f, http.MethodPost, "/report", encoded, headers)
				wantStatus, wantCalls := http.StatusOK, 1
				if extra != 0 {
					wantStatus, wantCalls = http.StatusRequestEntityTooLarge, 0
				}
				if response.Code != wantStatus || calls != wantCalls {
					t.Fatalf("status=%d calls=%d body=%s", response.Code, calls, response.Body)
				}
			})
		}
	}
}

func TestStressWorkerReportLargeNativeApplication(t *testing.T) {
	args := make([]string, 128)
	for i := range args {
		args[i] = strings.Repeat(`\`, 4096)
	}
	item := map[string]any{"key": map[string]any{"kind": "native"}, "targetRevision": "1", "appliedValue": map[string]any{"agent": "codex", "model": nil, "args": args}, "state": "applied", "error": nil, "lastFailure": nil, "nextAttemptAt": nil}
	observation := map[string]any{"baseRevision": "0", "desiredRevision": "1", "items": []any{item}}
	body := jsonBody(t, configurationHTTPReportBody(nil, observation))
	if len(body) <= transport.MaxRESTJSONBodyBytes || len(body) > transport.MaxWorkerConfigurationReportBytes {
		t.Fatalf("unexpected encoded report size %d", len(body))
	}
	f := newCapacityReportOperationFixture(t, "11111111-1111-4111-8111-111111111111")
	calls := 0
	f.operations.report = func(_ context.Context, _ model.Principal, _ string, input model.WorkerReport) (service.WorkerReportResult, error) {
		calls++
		if input.Configuration == nil || input.Configuration.Observation == nil || len(input.Configuration.Observation.Items) != 1 {
			t.Fatalf("missing observation: %+v", input.Configuration)
		}
		var value model.WorkerNativeConfiguration
		if err := json.Unmarshal(input.Configuration.Observation.Items[0].AppliedValue, &value); err != nil || len(value.Args) != len(args) {
			t.Fatalf("native value invalid: args=%d err=%v", len(value.Args), err)
		}
		for _, arg := range value.Args {
			if arg != args[0] {
				t.Fatal("native argument was truncated")
			}
		}
		return service.WorkerReportResult{ObservedAt: capacityObservedAt, LastReportedAt: capacityObservedAt, Configuration: &model.WorkerConfigurationReceipt{ObservationRevision: "0"}}, nil
	}
	response := controlModeRequest(t, f, http.MethodPost, "/report", body, http.Header{workerConfigurationHeader: {"1"}})
	if response.Code != http.StatusOK || calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, calls, response.Body)
	}
}
