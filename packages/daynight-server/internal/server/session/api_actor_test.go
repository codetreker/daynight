package session

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestVerifiedAPISessionActorRetainsCommandAndReceiptHTTPContract(t *testing.T) {
	actor := model.Principal{Kind: model.OAuthCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	project, task, id, operation := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	base := "/api/v1/projects/" + project + "/tasks/" + task + "/sessions/" + id
	location := base + "/operations/" + operation
	command := sp.Command{Fence: sp.Fence{SessionID: id, ClaimID: uuid.NewString(), ExecutionGeneration: "2"}, Protocol: sp.Protocol, RequestID: "api-command", OperationID: operation, Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"API\nmessage"}],"expectedTurnId":null}`)}
	receipt := sp.Operation{Fence: command.Fence, Protocol: sp.Protocol, OperationID: operation, Kind: command.Kind, State: "accepted"}
	ctx := t.Context()
	calls := 0
	refused := false
	check := func(actual context.Context, p model.Principal, pr, ta, session string) {
		t.Helper()
		calls++
		if actual != ctx || p != actor || pr != project || ta != task || session != id {
			t.Fatal("HTTP changed the verified API Actor, context or resource IDs")
		}
	}
	routes := newRoutes(serviceCalls{
		Submit: func(actual context.Context, p model.Principal, pr, ta, session string, input sp.Command) (sp.Operation, error) {
			check(actual, p, pr, ta, session)
			if !reflect.DeepEqual(input, command) {
				t.Fatal("HTTP changed the command intent or original fence")
			}
			if refused {
				return sp.Operation{}, model.Unauthenticated(nil)
			}
			return receipt, nil
		},
		TaskOperation: func(actual context.Context, p model.Principal, pr, ta, session, op string) (core.TaskOperationResult, error) {
			check(actual, p, pr, ta, session)
			if op != operation {
				t.Fatal("HTTP changed the historical operation ID")
			}
			return core.TaskOperationResult{Operation: receipt, CurrentBinding: false}, nil
		},
	}, nil, testLogger())
	// This adapter starts after credential verification; public Bearer profile
	// selection is owned by the authentication adapter.
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+sessionBase+"/{sessionId}/commands", func(w http.ResponseWriter, r *http.Request) {
		routes.Parameters(routes.submit)(w, r, actor)
	})
	mux.HandleFunc("GET "+sessionBase+"/{sessionId}/operations/{operationId}", func(w http.ResponseWriter, r *http.Request) {
		routes.Parameters(routes.operation)(w, r, actor)
	})
	body, err := json.Marshal(command)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, base+"/commands", strings.NewReader(string(body))).WithContext(ctx)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	var accepted struct {
		Operation    sp.Operation `json:"operation"`
		OperationURL string       `json:"operationUrl"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &accepted); err != nil || response.Code != http.StatusAccepted || response.Header().Get("Location") != location || accepted.OperationURL != location || !reflect.DeepEqual(accepted.Operation, receipt) || calls != 1 {
		t.Fatalf("API command HTTP response: %d %s %v", response.Code, response.Body, err)
	}
	receipt.State = "unknown"
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, location, nil).WithContext(ctx))
	var historical core.TaskOperationResult
	if err := json.Unmarshal(response.Body.Bytes(), &historical); err != nil || response.Code != http.StatusOK || historical.CurrentBinding || !reflect.DeepEqual(historical.Operation, receipt) || calls != 2 {
		t.Fatalf("API historical receipt HTTP response: %d %s %v", response.Code, response.Body, err)
	}
	refused = true
	request = httptest.NewRequest(http.MethodPost, base+"/commands", strings.NewReader(string(body))).WithContext(ctx)
	request.Header.Set("Content-Type", "application/json")
	response = httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized || response.Header().Get("Location") != "" || calls != 3 {
		t.Fatalf("API refusal lost its HTTP result: %d %s", response.Code, response.Body)
	}
}
