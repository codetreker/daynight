package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type lifecycleHTTPStub struct {
	workerService
	call func(context.Context, model.Principal, string, string, any) error
}

func (s *lifecycleHTTPStub) Lifecycle(ctx context.Context, p model.Principal, id string) (model.LifecycleResource, error) {
	return model.LifecycleResource{}, s.call(ctx, p, id, "read", nil)
}
func (s *lifecycleHTTPStub) LifecycleOperation(ctx context.Context, p model.Principal, id string, operation string) (model.LifecycleOperationResult, error) {
	return model.LifecycleOperationResult{}, s.call(ctx, p, id, "query", operation)
}
func (s *lifecycleHTTPStub) RegisterLifecycle(ctx context.Context, p model.Principal, id string, input model.LifecycleInstanceRequest) (model.LifecycleInstanceReceipt, error) {
	return model.LifecycleInstanceReceipt{}, s.call(ctx, p, id, "instances", input)
}
func (s *lifecycleHTTPStub) SetLifecycleIntent(ctx context.Context, p model.Principal, id string, input model.LifecycleIntentRequest) (model.LifecycleIntentReceipt, error) {
	return model.LifecycleIntentReceipt{}, s.call(ctx, p, id, "operations", input)
}
func (s *lifecycleHTTPStub) ActivateLifecycle(ctx context.Context, p model.Principal, id string, input model.LifecycleActivationRequest) (model.LifecycleActivationReceipt, error) {
	return model.LifecycleActivationReceipt{}, s.call(ctx, p, id, "activations", input)
}
func (s *lifecycleHTTPStub) ObserveLifecycle(ctx context.Context, p model.Principal, id string, input model.LifecycleObservationEnvelope) (model.LifecycleObservationReceipt, error) {
	return model.LifecycleObservationReceipt{}, s.call(ctx, p, id, "observations", input)
}
func (s *lifecycleHTTPStub) ResolveLifecycle(ctx context.Context, p model.Principal, id string, operation string, input model.LifecycleResolveRequest) (model.LifecycleOperationResult, error) {
	return model.LifecycleOperationResult{}, s.call(ctx, p, id, "resolve", input)
}

func lifecycleHTTPMux(s workerService, log io.Writer) *http.ServeMux {
	h := &workersHandler{workers: s, logger: slog.New(slog.NewTextHandler(log, nil))}
	mux := http.NewServeMux()
	registerRoutes(mux, h, func(next httpx.AuthenticatedHandler) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			next(w, r, model.Principal{UserID: "11111111-1111-4111-8111-111111111111"})
		}
	})
	return mux
}

const lifecycleWorkerURL = "/api/v1/me/workers/22222222-2222-4222-8222-222222222222/lifecycle"
const lifecycleOperationID = "33333333-3333-4333-8333-333333333333"
const lifecycleInstanceID = "44444444-4444-4444-8444-444444444444"
const lifecycleDisableJSON = `{"protocolVersion":1,"operationId":"33333333-3333-4333-8333-333333333333","action":"disable","expectedVersion":"1","source":"web","localEpoch":null,"originOperationId":null}`
const lifecycleInstanceJSON = `{"protocolVersion":1,"operationId":"33333333-3333-4333-8333-333333333333","instanceId":"44444444-4444-4444-8444-444444444444","previousInstanceEpoch":null,"capabilities":{"disable":true,"resume":true,"inventory":1,"dispatchFence":1},"platform":"macos"}`
const lifecycleActivationJSON = `{"protocolVersion":1,"operationId":"33333333-3333-4333-8333-333333333333","instanceId":"44444444-4444-4444-8444-444444444444","instanceEpoch":"1","intentVersion":"3","localEpoch":"2","scopeGeneration":"2","reportSequence":"5"}`

func lifecycleObservationJSON(t *testing.T) string {
	t.Helper()
	zero := int64(0)
	b, e := json.Marshal(model.LifecycleObservationEnvelope{ProtocolVersion: 1, InstanceID: lifecycleInstanceID, InstanceEpoch: "1", IntentVersion: "2", OperationID: ptrLifecycle(lifecycleOperationID), LocalEpoch: "2", ScopeGeneration: "1", ReportSequence: "1", Observation: model.LifecycleObservation{Phase: "disabled", Stop: "confirmed", Save: "durable", Sync: "complete", InventoryComplete: true, DetailsComplete: true, InventoryRevision: "1", InventoryDigest: strings.Repeat("a", 64), ResourceCount: &zero, StoppedCount: &zero, PendingCount: &zero, BlockedCount: &zero, Resources: []model.LifecycleResourceObservation{}, Recovery: []model.LifecycleRecoveryObservation{}}})
	if e != nil {
		t.Fatal(e)
	}
	return string(b)
}
func ptrLifecycle(s string) *string { return &s }

func TestLifecycleHTTPRoutes(t *testing.T) {
	for _, tc := range []struct {
		suffix, method, body, action string
		status                       int
	}{
		{"", "GET", "", "read", 200},
		{"/operations/" + lifecycleOperationID, "GET", "", "query", 200},
		{"/instances", "POST", lifecycleInstanceJSON, "instances", 200},
		{"/operations", "POST", lifecycleDisableJSON, "operations", 202},
		{"/activations", "POST", lifecycleActivationJSON, "activations", 200},
		{"/observations", "POST", lifecycleObservationJSON(t), "observations", 200},
		{"/operations/" + lifecycleOperationID + "/resolve", "POST", `{"protocolVersion":1,"requestKind":"intent","request":` + lifecycleDisableJSON + `}`, "resolve", 200},
	} {
		t.Run(tc.action, func(t *testing.T) {
			calls := 0
			stub := &lifecycleHTTPStub{call: func(ctx context.Context, p model.Principal, id, action string, input any) error {
				calls++
				if p.UserID != "11111111-1111-4111-8111-111111111111" || id != "22222222-2222-4222-8222-222222222222" || action != tc.action {
					t.Fatalf("identity/action mismatch: %v %s %s", p, id, action)
				}
				if _, ok := ctx.Deadline(); !ok {
					t.Fatal("missing deadline")
				}
				if tc.action == "query" && input != lifecycleOperationID {
					t.Fatal("query identity changed")
				}
				if tc.action == "operations" {
					r := input.(model.LifecycleIntentRequest)
					if r.Action != "disable" || r.OperationID != lifecycleOperationID || r.ExpectedVersion != "1" || r.LocalEpoch != nil {
						t.Fatalf("input changed: %#v", r)
					}
				}
				return nil
			}}
			r := httptest.NewRequest(tc.method, lifecycleWorkerURL+tc.suffix, strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			lifecycleHTTPMux(stub, io.Discard).ServeHTTP(w, r)
			if w.Code != tc.status || calls != 1 || w.Header().Get(lifecycleHeader) != "1" || !strings.HasSuffix(w.Body.String(), "\n") {
				t.Fatalf("response: %d %s calls=%d", w.Code, w.Body.String(), calls)
			}
		})
	}
}

func TestLifecycleHTTPRefusals(t *testing.T) {
	for _, tc := range []struct {
		name, url, method, body, header string
		status                          int
	}{
		{"query", lifecycleWorkerURL + "?x=1", "GET", "", "", 400},
		{"empty query", lifecycleWorkerURL + "?", "GET", "", "", 400},
		{"header", lifecycleWorkerURL, "GET", "", "2", 422},
		{"bad worker", "/api/v1/me/workers/invalid/lifecycle", "GET", "", "", 400},
		{"unknown field", lifecycleWorkerURL + "/operations", "POST", strings.Replace(lifecycleDisableJSON, `"action"`, `"extra":1,"action"`, 1), "1", 400},
		{"malformed", lifecycleWorkerURL + "/instances", "POST", "{", "1", 400},
		{"large", lifecycleWorkerURL + "/observations", "POST", strings.Repeat(" ", 256*1024+1), "1", 413},
		{"method", lifecycleWorkerURL, "DELETE", "", "", 405},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &lifecycleHTTPStub{call: func(context.Context, model.Principal, string, string, any) error {
				t.Fatal("rejected request reached service")
				return nil
			}}
			r := httptest.NewRequest(tc.method, tc.url, strings.NewReader(tc.body))
			r.Header.Set("Content-Type", "application/json")
			if tc.header != "" {
				r.Header.Set(lifecycleHeader, tc.header)
			}
			w := httptest.NewRecorder()
			lifecycleHTTPMux(s, io.Discard).ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("got %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestLifecycleHTTPErrors(t *testing.T) {
	for code, status := range map[string]int{"operation_conflict": 409, "operation_resolved_not_committed": 409, "stale_instance": 409, "stale_intent": 409, "stale_report": 409, "disable_incomplete": 409, "safety_blocked": 409, "worker_disabled": 423, "lifecycle_unavailable": 503, "lifecycle_unsupported": 422, "not_found": 404} {
		t.Run(code, func(t *testing.T) {
			s := &lifecycleHTTPStub{call: func(context.Context, model.Principal, string, string, any) error {
				return &model.Fault{Code: code, Message: "Lifecycle request refused."}
			}}
			w := httptest.NewRecorder()
			lifecycleHTTPMux(s, io.Discard).ServeHTTP(w, httptest.NewRequest("GET", lifecycleWorkerURL, nil))
			if w.Code != status || !strings.Contains(w.Body.String(), code) {
				t.Fatalf("got %d %s", w.Code, w.Body.String())
			}
		})
	}
}

type lifecycleShortWriter struct{ http.ResponseWriter }

func (w lifecycleShortWriter) Write(p []byte) (int, error) { return 0, errors.New("closed") }
func TestLifecycleHTTPWriteFailureDoesNotRepeat(t *testing.T) {
	calls := 0
	s := &lifecycleHTTPStub{call: func(context.Context, model.Principal, string, string, any) error { calls++; return nil }}
	var logs bytes.Buffer
	r := httptest.NewRequest("POST", lifecycleWorkerURL+"/operations", strings.NewReader(lifecycleDisableJSON))
	r.Header.Set("Content-Type", "application/json")
	lifecycleHTTPMux(s, &logs).ServeHTTP(lifecycleShortWriter{httptest.NewRecorder()}, r)
	if calls != 1 || !strings.Contains(logs.String(), "write_outcome_unknown") {
		t.Fatalf("calls=%d logs=%s", calls, logs.String())
	}
}
