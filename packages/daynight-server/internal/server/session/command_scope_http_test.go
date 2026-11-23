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

func TestCommandHTTPPreservesActorAndImageOrControlIntentOnScopeRefusal(t *testing.T) {
	actor := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	project, task, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
	fence := sp.Fence{SessionID: id, ClaimID: uuid.NewString(), ExecutionGeneration: "2"}
	image := sp.TextPart{Type: "image", ImageID: uuid.NewString(), UploadID: uuid.NewString(), ResourceID: uuid.NewString(), SHA256: strings.Repeat("a", 64), ByteLength: "1"}
	target := &sp.ImageTarget{ServerOrigin: "https://daynight.example", ActorUserID: actor.UserID, Fence: fence}
	payload := func(v any) json.RawMessage {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	imageMessage := func(content []sp.TextPart) sp.SendMessage {
		return sp.SendMessage{Content: content, Target: target, DraftID: uuid.NewString(), DraftRevision: "1", ExpectedImageCapabilityRevision: "1"}
	}
	cases := []struct {
		name, kind string
		revision   int
		payload    json.RawMessage
	}{
		{"image only", "send_message", sp.ContentRevision, payload(imageMessage([]sp.TextPart{image}))},
		{"text and image", "send_message", sp.ContentRevision, payload(imageMessage([]sp.TextPart{{Type: "text", Text: "hello"}, image}))},
		{"cancel", "cancel", 0, payload(sp.Cancel{ExpectedTurnID: "turn-1"})},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			command := sp.Command{Fence: fence, Protocol: sp.Protocol, RequestID: "command", OperationID: uuid.NewString(), Kind: tc.kind, Payload: tc.payload, ContentRevision: tc.revision}
			calls := 0
			routes := newRoutes(serviceCalls{Submit: func(ctx context.Context, principal model.Principal, pr, ta, session string, input sp.Command) (sp.Operation, error) {
				calls++
				if ctx != t.Context() || principal != actor || pr != project || ta != task || session != id || !reflect.DeepEqual(input, command) {
					t.Errorf("HTTP changed original actor, target or intent: %+v %+v", principal, input)
				}
				return sp.Operation{State: "provider_accepted"}, &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."}
			}}, nil, testLogger())
			mux := http.NewServeMux()
			mux.HandleFunc("POST "+sessionBase+"/{sessionId}/commands", func(w http.ResponseWriter, r *http.Request) { routes.Parameters(routes.submit)(w, r, actor) })
			body, err := json.Marshal(command)
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+project+"/tasks/"+task+"/sessions/"+id+"/commands", strings.NewReader(string(body))).WithContext(t.Context())
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden || response.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || response.Header().Get("Location") != "" || strings.Contains(response.Body.String(), "provider_accepted") || calls != 1 {
				t.Fatalf("scope refusal leaked receipt or changed status: status=%d headers=%v body=%s calls=%d", response.Code, response.Header(), response.Body, calls)
			}
		})
	}
}

func TestTaskOperationHTTPScopeRefusalDoesNotExposeReceipt(t *testing.T) {
	actor := model.Principal{Kind: model.OAuthCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	project, task, id, operation := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	calls := 0
	routes := newRoutes(serviceCalls{TaskOperation: func(ctx context.Context, p model.Principal, pr, ta, session, op string) (core.TaskOperationResult, error) {
		calls++
		if ctx != t.Context() || p != actor || pr != project || ta != task || session != id || op != operation {
			t.Error("HTTP changed original actor or target")
		}
		return core.TaskOperationResult{Operation: sp.Operation{State: "provider_accepted"}, CurrentBinding: true}, &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."}
	}}, nil, testLogger())
	mux := http.NewServeMux()
	mux.HandleFunc("GET "+sessionBase+"/{sessionId}/operations/{operationId}", func(w http.ResponseWriter, r *http.Request) { routes.Parameters(routes.operation)(w, r, actor) })
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/projects/"+project+"/tasks/"+task+"/sessions/"+id+"/operations/"+operation, nil).WithContext(t.Context()))
	if response.Code != http.StatusForbidden || response.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || strings.Contains(response.Body.String(), "provider_accepted") || strings.Contains(response.Body.String(), "currentBinding") || calls != 1 {
		t.Fatalf("scope refusal exposed receipt: status=%d body=%s calls=%d", response.Code, response.Body, calls)
	}
}

func TestTestSessionCommandAndReceiptPreserveActorOnScopeRefusal(t *testing.T) {
	actor := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	id, operation := uuid.NewString(), uuid.NewString()
	fence := sp.Fence{SessionID: id, TestExecutionID: uuid.NewString(), ExecutionGeneration: "1"}
	image := sp.TextPart{Type: "image", ImageID: uuid.NewString(), UploadID: uuid.NewString(), ResourceID: uuid.NewString(), SHA256: strings.Repeat("a", 64), ByteLength: "1"}
	payload, err := json.Marshal(sp.SendMessage{Content: []sp.TextPart{image}, Target: &sp.ImageTarget{ServerOrigin: "https://daynight.example", ActorUserID: actor.UserID, Fence: fence}, DraftID: uuid.NewString(), DraftRevision: "1", ExpectedImageCapabilityRevision: "1"})
	if err != nil {
		t.Fatal(err)
	}
	command := sp.Command{Fence: fence, Protocol: sp.Protocol, RequestID: "test-command", OperationID: operation, Kind: "send_message", ContentRevision: sp.ContentRevision, Payload: payload}
	refusal := &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."}
	sends, reads := 0, 0
	routes := newRoutes(serviceCalls{
		Submit: func(ctx context.Context, p model.Principal, project, task, session string, input sp.Command) (sp.Operation, error) {
			sends++
			if ctx != t.Context() || p != actor || project != "" || task != "" || session != id || !reflect.DeepEqual(input, command) {
				t.Error("test Session command changed actor or intent")
			}
			return sp.Operation{State: "provider_accepted"}, refusal
		},
		Operation: func(ctx context.Context, p model.Principal, project, task, session, op string) (sp.Operation, error) {
			reads++
			if ctx != t.Context() || p != actor || project != "" || task != "" || session != id || op != operation {
				t.Error("test Session receipt changed actor or target")
			}
			return sp.Operation{State: "provider_accepted"}, refusal
		},
	}, nil, testLogger())
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/test-sessions/{sessionId}/commands", func(w http.ResponseWriter, r *http.Request) { routes.Parameters(routes.submit)(w, r, actor) })
	mux.HandleFunc("GET /api/v1/test-sessions/{sessionId}/operations/{operationId}", func(w http.ResponseWriter, r *http.Request) { routes.Parameters(routes.operation)(w, r, actor) })
	body, err := json.Marshal(command)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ method, path, body string }{
		{http.MethodPost, "/api/v1/test-sessions/" + id + "/commands", string(body)},
		{http.MethodGet, "/api/v1/test-sessions/" + id + "/operations/" + operation, ""},
	} {
		request := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body)).WithContext(t.Context())
		if tc.method == http.MethodPost {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden || response.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || response.Header().Get("Location") != "" || strings.Contains(response.Body.String(), "provider_accepted") {
			t.Fatalf("test Session refusal exposed receipt: status=%d body=%s", response.Code, response.Body)
		}
	}
	if sends != 1 || reads != 1 {
		t.Fatalf("calls send=%d read=%d", sends, reads)
	}
}
