package bot_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	bothttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/bot"
)

func (f *botDefinitionsFixture) DeletionRecovery(ctx context.Context, p model.Principal, id string) (botcore.DeletionRecovery, error) {
	return botDefinitionResult[botcore.DeletionRecovery](f.invoke(ctx, p, "DeletionRecovery", id, nil))
}
func (f *botDefinitionsFixture) ResolveDeletion(ctx context.Context, p model.Principal, id string, input botcore.ResolveDeletion) (botcore.DeletionRecovery, error) {
	return botDefinitionResult[botcore.DeletionRecovery](f.invoke(ctx, p, "ResolveDeletion", id, input))
}

func TestBotDeletionRecoveryHTTPContract(t *testing.T) {
	f := newBotDefinitionsFixture(t, io.Discard)
	path := botDefinitionsPath + "/deletion-recovery"
	value := botcore.DeletionRecovery{BotID: botDefinitionsID, Version: 9007199254740993, DeletionID: botDefinitionsIntent, RequestedVersion: 7, WorkerID: botDefinitionsWorker, HostingWorkerID: botDefinitionsOtherID,
		RequiresStopProof: true, RecoveryRequired: true, OriginalBinding: &model.BotDeletionBinding{SessionID: botDefinitionsID, TestExecutionID: botDefinitionsOtherID, ExecutionGeneration: "2", ControllerID: botDefinitionsWorker, ControllerInstanceID: botDefinitionsIntent},
		WorkerCleanup: model.BotCleanupResult{State: "failed", Code: botObservationPointer("execution_evidence_missing")}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
	response := f.request(http.MethodGet, path, "", &botDefinitionCall{method: "DeletionRecovery", id: botDefinitionsID, result: value})
	got := decodeResponse[api.BotDeletionRecovery](t, response, 200)
	if got.SchemaVersion != 1 || got.Version != value.Version || got.HostingWorkerID != botDefinitionsOtherID || !got.RequiresStopProof || !got.RecoveryRequired || got.OriginalBinding.ControllerID != botDefinitionsWorker || got.Decision != nil || !strings.Contains(response.Body.String(), `"version":"9007199254740993"`) {
		t.Fatalf("sidecar: %s", response.Body)
	}
	input := botcore.ResolveDeletion{Action: "accept_unverified", Version: value.Version, DeletionID: value.DeletionID, OperationID: botDefinitionsOtherID, AcknowledgeLocalUnverified: true, Reason: "Missing execution\n本地未核实"}
	body := jsonBody(t, map[string]any{"action": input.Action, "ifVersion": "9007199254740993", "deletionId": input.DeletionID, "operationId": input.OperationID, "acknowledgeLocalUnverified": true, "reason": input.Reason})
	value.Decision = &model.BotDeletionDecision{OperationID: input.OperationID, RequestedVersion: input.Version, ActorUserID: f.principal.UserID, Reason: input.Reason, AcknowledgedAt: time.Date(2026, 11, 23, 1, 0, 0, 0, time.FixedZone("test", 3600)), LocalDisposition: "unverified"}
	value.RecoveryRequired = false
	response = f.request(http.MethodPost, path, body, &botDefinitionCall{method: "ResolveDeletion", id: botDefinitionsID, input: input, result: value})
	got = decodeResponse[api.BotDeletionRecovery](t, response, 200)
	if got.Decision == nil || got.Decision.OperationID != input.OperationID || got.Decision.LocalDisposition != "unverified" || strings.Contains(response.Body.String(), "+01:00") {
		t.Fatalf("decision: %s", response.Body)
	}
	retry := botcore.ResolveDeletion{Action: "retry_cleanup", Version: input.Version, DeletionID: input.DeletionID, OperationID: input.OperationID}
	body = jsonBody(t, map[string]any{"action": retry.Action, "ifVersion": "9007199254740993", "deletionId": retry.DeletionID, "operationId": retry.OperationID})
	response = f.request(http.MethodPost, path, body, &botDefinitionCall{method: "ResolveDeletion", id: botDefinitionsID, input: retry, result: value})
	decodeResponse[api.BotDeletionRecovery](t, response, 200)
	legacy := model.Bot{ID: value.BotID, WorkerID: value.WorkerID, Version: value.Version, Deletion: &model.BotDeletion{DeletionID: value.DeletionID, RequestedVersion: value.RequestedVersion, WorkerCleanup: value.WorkerCleanup, ServerCleanup: value.ServerCleanup, Recovery: &model.BotDeletionRecovery{WorkerID: value.HostingWorkerID, OriginalBinding: value.OriginalBinding, Decision: *value.Decision}}}
	raw, err := json.Marshal(bothttp.Response(legacy))
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 4 || strings.Contains(string(raw), "recovery") || strings.Contains(string(raw), "originalBinding") || strings.Contains(string(raw), "actorUserId") {
		t.Fatalf("old DTO changed: %s", raw)
	}
}

func TestBotDeletionRecoveryHTTPRefusals(t *testing.T) {
	f := newBotDefinitionsFixture(t, io.Discard)
	path := botDefinitionsPath + "/deletion-recovery"
	base := map[string]any{"action": "accept_unverified", "ifVersion": "2", "deletionId": botDefinitionsIntent, "operationId": botDefinitionsOtherID, "acknowledgeLocalUnverified": true, "reason": "missing"}
	for name, mutate := range map[string]func(map[string]any){
		"no ack": func(m map[string]any) { delete(m, "acknowledgeLocalUnverified") }, "false ack": func(m map[string]any) { m["acknowledgeLocalUnverified"] = false }, "null ack": func(m map[string]any) { m["acknowledgeLocalUnverified"] = nil },
		"no action": func(m map[string]any) { delete(m, "action") }, "bad action": func(m map[string]any) { m["action"] = "force" }, "no operation": func(m map[string]any) { delete(m, "operationId") }, "bad id": func(m map[string]any) { m["operationId"] = "bad" },
		"no reason": func(m map[string]any) { delete(m, "reason") }, "blank reason": func(m map[string]any) { m["reason"] = " \t" }, "long reason": func(m map[string]any) { m["reason"] = strings.Repeat("中", 1001) }, "nul reason": func(m map[string]any) { m["reason"] = "x\x00" },
		"numeric version": func(m map[string]any) { m["ifVersion"] = 2 }, "retry replacement": func(m map[string]any) { m["action"] = "retry_cleanup" }, "extra": func(m map[string]any) { m["unknown"] = true },
	} {
		t.Run(name, func(t *testing.T) {
			m := map[string]any{}
			for k, v := range base {
				m[k] = v
			}
			mutate(m)
			assertProjectError(t, f.request(http.MethodPost, path, jsonBody(t, m), nil), 400, "invalid_input")
		})
	}
	for _, body := range []string{"null", "[]", "{}", `{"action":"retry_cleanup","action":"retry_cleanup"}`} {
		assertProjectError(t, f.request(http.MethodPost, path, body, nil), 400, "invalid_input")
	}
	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		r := f.request(method, path, "{}", nil)
		assertProjectError(t, r, 405, "method_not_allowed")
		if r.Header().Get("Allow") != "GET, HEAD, POST" {
			t.Fatal(r.Header())
		}
	}
	assertProjectError(t, f.dispatch(http.MethodGet, path, "", botDefinitionAnonymous, nil), 401, "unauthenticated")
	for _, code := range []string{"resource_conflict", "version_conflict", "forbidden"} {
		status := 409
		if code == "forbidden" {
			status = 403
		}
		assertProjectError(t, f.request(http.MethodGet, path, "", &botDefinitionCall{method: "DeletionRecovery", id: botDefinitionsID, err: &model.Fault{Code: code, Message: "refusal"}}), status, code)
	}
	response := f.request(http.MethodHead, path, "", &botDefinitionCall{method: "DeletionRecovery", id: botDefinitionsID, result: botcore.DeletionRecovery{}})
	if response.Code != 200 {
		t.Fatalf("HEAD: %s", response.Body)
	}
}
