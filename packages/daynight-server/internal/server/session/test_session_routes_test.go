package session_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

func independentRegistration(provider string) sp.TestRegistration {
	return sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: provider, InitialInput: "none"}
}
func testSessionEnvelope(kind string, snapshot sp.Snapshot) map[string]any {
	return map[string]any{"type": kind, "protocol": sp.Protocol, "sessionId": snapshot.SessionID, "testExecutionId": snapshot.TestExecutionID, "executionGeneration": snapshot.ExecutionGeneration, "connectionEpoch": snapshot.ConnectionEpoch}
}

func TestTestSessionHTTPForwardsIndependentScopeAndClosesRevokedChannels(t *testing.T) {
	f := newTestSessionRouteFixture(t)
	registration := independentRegistration("claude")
	supplied := suppliedTestSnapshot(f.handler.principal, registration)
	v := f.registration(t, registration, supplied)
	path := "/api/v1/test-sessions/" + v.SessionID
	f.auth.ExpectCalls(0)
	before := f.calls.TotalCalls()
	for _, route := range []string{"/api/v1/test-session-capabilities", path, path + "/timeline", path + "/operations/" + uuid.NewString(), path + "/resources/" + uuid.NewString() + "/content", path + "/channel"} {
		response := httptest.NewRecorder()
		f.handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, route, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatal("anonymous route", route, response.Code)
		}
	}
	if f.calls.TotalCalls() != before {
		t.Fatal("anonymous requests reached a usecase")
	}
	decodeResponse[map[string]any](t, f.request(http.MethodGet, "/api/v1/test-session-capabilities", ""), http.StatusOK)
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.TestSnapshot = func(ctx context.Context, p model.Principal, id string) (sp.Snapshot, error) {
			f.requestContext(ctx, p, f.handler.principal)
			f.argument(id == v.SessionID, "snapshot ID")
			return routeCopy(v), nil
		}
		c.Timeline = func(ctx context.Context, p model.Principal, project, task, id, direction, cursor string, limit int) (map[string]any, error) {
			f.requestContext(ctx, p, f.handler.principal)
			f.argument(project == "" && task == "" && id == v.SessionID && direction == "tail" && cursor == "" && limit == 100, "independent timeline defaults/scope")
			return nil, &model.Fault{Code: "controller_offline", Message: "Controller is offline."}
		}
	})
	decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, f.request(http.MethodGet, path, ""), http.StatusOK)
	assertProjectError(t, f.request(http.MethodGet, path+"/timeline", ""), http.StatusServiceUnavailable, "controller_offline")
	project, task := uuid.NewString(), uuid.NewString()
	f.expectNext("Timeline")
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.Timeline = func(ctx context.Context, p model.Principal, actualProject, actualTask, id, direction, cursor string, limit int) (map[string]any, error) {
			f.requestContext(ctx, p, f.handler.principal)
			f.argument(actualProject == project && actualTask == task && id == v.SessionID && direction == "tail" && cursor == "" && limit == 100, "Task route IDs")
			return nil, &model.Fault{Code: "session_conflict", Message: "Wrong Session scope."}
		}
	})
	assertProjectError(t, f.request(http.MethodGet, "/api/v1/projects/"+project+"/tasks/"+task+"/sessions/"+v.SessionID+"/timeline", ""), http.StatusConflict, "session_conflict")
	nativeID := uuid.NewString()
	f.expectNext("TestSnapshot")
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.TestSnapshot = func(ctx context.Context, p model.Principal, id string) (sp.Snapshot, error) {
			f.requestContext(ctx, p, f.handler.principal)
			f.argument(id == nativeID, "foreign snapshot ID")
			return sp.Snapshot{}, &model.Fault{Code: "session_conflict", Message: "Wrong Session scope."}
		}
	})
	assertProjectError(t, f.request(http.MethodGet, "/api/v1/test-sessions/"+nativeID, ""), http.StatusConflict, "session_conflict")
	connected := routeCopy(v)
	connected.ConnectionEpoch, connected.ConnectionState = "1", "synchronizing"
	controller, connected := f.controller(t, v, connected, registration)
	browserReply := routeCopy(connected)
	cursor := "test-browser-cursor"
	f.calls.AllowRepeated("BrowserPoll")
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.BrowserPoll = func(ctx context.Context, p model.Principal, project, task, id, actualCursor string) (sp.Snapshot, []map[string]any, string, error) {
			f.argument(ctx != nil && p == f.handler.principal && project == "" && task == "" && id == connected.SessionID && (actualCursor == "" || actualCursor == cursor), "Test browser principal/scope/cursor")
			return routeCopy(browserReply), []map[string]any{}, cursor, nil
		}
	})
	f.auth.ExpectCalls(1)
	browser := sessionDial(t, f.server.URL, path+"/channel", f.handler.token, nil)
	sessionWSKind(t, browser, "snapshot")
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	syncMessage := sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: connected.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}
	expectedSync := syncMessage
	expectedSync.Raw = []byte(jsonBody(t, syncMessage))
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.Handle = func(ctx context.Context, actual sp.ControllerMessage) (map[string]any, error) {
			f.controllerScope(ctx, actual.ControllerFence, connected.ControllerFence)
			f.argument(reflect.DeepEqual(actual, expectedSync), "sync-state frame")
			return testSessionEnvelope("sync_ack", connected), nil
		}
	})
	sessionWSWrite(t, controller, syncMessage)
	sessionWSKind(t, controller, "sync_ack")
	payload, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	eventMessage := sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: connected.ControllerFence, SourceEpoch: uuid.NewString(), BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: payload}}}
	expectedEvents := eventMessage
	expectedEvents.Raw = []byte(jsonBody(t, eventMessage))
	f.expectNext("Handle")
	eventReply := testSessionEnvelope("events_ack", connected)
	eventReply["sourceEpoch"], eventReply["lastAckedSourceSeq"], eventReply["batchId"] = eventMessage.SourceEpoch, "1", eventMessage.BatchID
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.Handle = func(ctx context.Context, actual sp.ControllerMessage) (map[string]any, error) {
			f.controllerScope(ctx, actual.ControllerFence, connected.ControllerFence)
			f.argument(reflect.DeepEqual(actual, expectedEvents), "events frame")
			return routeCopy(eventReply), nil
		}
	})
	sessionWSWrite(t, controller, eventMessage)
	sessionWSKind(t, controller, "events_ack")
	command := sp.Command{Fence: connected.Fence, Protocol: sp.Protocol, RequestID: "first", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hello"}],"expectedTurnId":null}`)}
	accepted := sp.Operation{Fence: command.Fence, Protocol: sp.Protocol, OperationID: command.OperationID, Kind: command.Kind, State: "accepted"}
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.Submit = func(ctx context.Context, p model.Principal, project, task, id string, actual sp.Command) (sp.Operation, error) {
			f.requestContext(ctx, p, f.handler.principal)
			f.argument(project == "" && task == "" && id == connected.SessionID && reflect.DeepEqual(actual, command), "command body/scope")
			return accepted, nil
		}
	})
	response := f.request(http.MethodPost, path+"/commands", jsonBody(t, command))
	got := decodeResponse[struct {
		Operation sp.Operation `json:"operation"`
		URL       string       `json:"operationUrl"`
	}](t, response, http.StatusAccepted)
	location := path + "/operations/" + command.OperationID
	if response.Header().Get("Location") != location || got.URL != location || !reflect.DeepEqual(got.Operation, accepted) {
		t.Fatal("command response changed supplied operation or Location")
	}
	offer := testSessionEnvelope("operation_offer", connected)
	offer["operationSeq"], offer["command"] = "1", command
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.Poll = func(ctx context.Context, fence sp.ControllerFence) ([]map[string]any, error) {
			f.controllerScope(ctx, fence, connected.ControllerFence)
			return []map[string]any{routeCopy(offer)}, nil
		}
	})
	frame := sessionWSKind(t, controller, "operation_offer")
	if string(frame["testExecutionId"]) != "\""+connected.TestExecutionID+"\"" || frame["claimId"] != nil {
		t.Fatal("independent offer scope changed", frame)
	}
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.Poll = func(ctx context.Context, fence sp.ControllerFence) ([]map[string]any, error) {
			f.controllerScope(ctx, fence, connected.ControllerFence)
			return []map[string]any{}, nil
		}
	})
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	controllerClosed, browserClosed := watchDeletedChannel(ctx, controller), watchDeletedChannel(ctx, browser)
	if err := controller.Ping(ctx); err != nil {
		t.Fatal("controller unavailable before refusal", err)
	}
	if err := browser.Ping(ctx); err != nil {
		t.Fatal("browser unavailable before refusal", err)
	}
	failure := authhttp.Failure()
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.Poll = func(ctx context.Context, fence sp.ControllerFence) ([]map[string]any, error) {
			f.controllerScope(ctx, fence, connected.ControllerFence)
			return nil, failure
		}
		c.BrowserPoll = func(ctx context.Context, p model.Principal, project, task, id, actualCursor string) (sp.Snapshot, []map[string]any, string, error) {
			f.argument(ctx != nil && p == f.handler.principal && project == "" && task == "" && id == connected.SessionID && actualCursor == cursor, "revoked browser scope/cursor")
			return sp.Snapshot{}, nil, "", failure
		}
		c.Disconnect = func(ctx context.Context, fence sp.ControllerFence) error {
			f.disconnectScope(ctx, fence, connected.ControllerFence, failure)
			return failure
		}
	})
	f.revokeAuthentication()
	requireDeletedChannelClosed(t, ctx, controllerClosed)
	requireDeletedChannelClosed(t, ctx, browserClosed)
	f.requireCleanup(t, failure)
	before = f.calls.TotalCalls()
	assertProjectError(t, f.request(http.MethodGet, path, ""), http.StatusUnauthorized, "unauthenticated")
	if f.calls.TotalCalls() != before {
		t.Fatal("authentication refusal reached a usecase")
	}
}

func TestTestSessionStopHTTPForwardsProofOwnerAndScope(t *testing.T) {
	f := newTestSessionRouteFixture(t)
	registration := independentRegistration("codex")
	snapshot := suppliedTestSnapshot(f.handler.principal, registration)
	v := f.registration(t, registration, snapshot)
	path := "/api/v1/test-sessions/" + v.SessionID
	proof := sp.TestStop{Protocol: sp.Protocol, Fence: v.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	before := f.calls.TotalCalls()
	for _, input := range []struct{ path, body string }{
		{path + "/stop?unknown=1", jsonBody(t, proof)}, {path + "/stop", "{}"}, {path + "/stop", `{"protocol":"daynight.session.v1"`}, {"/api/v1/test-sessions?unknown=1", jsonBody(t, registration)}, {"/api/v1/test-sessions", "{}"},
	} {
		assertProjectError(t, f.request(http.MethodPost, input.path, input.body), http.StatusBadRequest, "invalid_input")
	}
	for _, route := range []string{path + "?unknown=1", "/api/v1/test-session-capabilities?unknown=1"} {
		assertProjectError(t, f.request(http.MethodGet, route, ""), http.StatusBadRequest, "invalid_input")
	}
	capability := decodeResponse[map[string]any](t, f.request(http.MethodGet, "/api/v1/test-session-capabilities", ""), http.StatusOK)
	if len(capability) != 4 || capability["protocol"] != sp.Protocol {
		t.Fatal("Test capability response changed", capability)
	}
	for _, route := range []string{path, path + "/stop", "/api/v1/test-session-capabilities"} {
		if response := f.request(http.MethodDelete, route, ""); response.Code != http.StatusMethodNotAllowed {
			t.Fatal("method admission", route, response.Code)
		}
	}
	if f.calls.TotalCalls() != before {
		t.Fatal("protocol rejection or capabilities reached a usecase")
	}
	f.auth.ExpectCalls(0)
	anonymous := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, path+"/stop", nil)
	request.Header.Set("X-Request-ID", "project-test")
	f.handler.ServeHTTP(anonymous, request)
	assertProjectError(t, anonymous, http.StatusUnauthorized, "unauthenticated")
	nativeID := uuid.NewString()
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.StopTest = func(ctx context.Context, p model.Principal, id string, actual sp.TestStop) (sp.Snapshot, error) {
			f.requestContext(ctx, p, f.handler.principal)
			f.argument(id == nativeID && reflect.DeepEqual(actual, proof), "separate route ID and proof fence")
			return sp.Snapshot{}, &model.Fault{Code: "session_conflict", Message: "Wrong scope."}
		}
	})
	assertProjectError(t, f.request(http.MethodPost, "/api/v1/test-sessions/"+nativeID+"/stop", jsonBody(t, proof)), http.StatusConflict, "session_conflict")
	outsiderPrincipal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	outsider := &resourceTestHandler{Handler: f.handler.Handler, token: f.auth.Credential(outsiderPrincipal), principal: outsiderPrincipal, backend: f.calls, authentication: f.auth, application: f.handler.application}
	f.expectNext("StopTest")
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.StopTest = func(ctx context.Context, p model.Principal, id string, actual sp.TestStop) (sp.Snapshot, error) {
			f.requestContext(ctx, p, outsiderPrincipal)
			f.argument(id == v.SessionID && reflect.DeepEqual(actual, proof), "outsider proof input")
			return sp.Snapshot{}, &model.Fault{Code: "forbidden", Message: "Not the owner."}
		}
		c.TestSnapshot = func(ctx context.Context, p model.Principal, id string) (sp.Snapshot, error) {
			f.requestContext(ctx, p, outsiderPrincipal)
			f.argument(id == v.SessionID, "outsider read ID")
			return sp.Snapshot{}, &model.Fault{Code: "forbidden", Message: "Not the owner."}
		}
	})
	assertProjectError(t, f.requestAs(outsider, http.MethodPost, path+"/stop", jsonBody(t, proof)), http.StatusForbidden, "forbidden")
	assertProjectError(t, f.requestAs(outsider, http.MethodGet, path, ""), http.StatusForbidden, "forbidden")
	archived := routeCopy(v)
	archived.Lifecycle, archived.Operations = "archived", sp.Operations{}
	stopReply := func(c *sessionhttp.ServiceCallsForTest) {
		c.StopTest = func(ctx context.Context, p model.Principal, id string, actual sp.TestStop) (sp.Snapshot, error) {
			f.requestContext(ctx, p, f.handler.principal)
			f.argument(id == v.SessionID && reflect.DeepEqual(actual, proof), "owner proof input")
			return routeCopy(archived), nil
		}
	}
	for range 2 {
		f.expectNext("StopTest")
		f.calls.Configure(stopReply)
		got := decodeResponse[struct {
			Session sp.Snapshot `json:"session"`
		}](t, f.request(http.MethodPost, path+"/stop", jsonBody(t, proof)), http.StatusOK)
		if !reflect.DeepEqual(got.Session, archived) {
			t.Fatal("stop response changed supplied archived snapshot")
		}
	}
	if f.calls.Called("Disconnect") != 0 {
		t.Fatal("never-connected route performed controller cleanup")
	}
	registration = independentRegistration("codex")
	next := suppliedTestSnapshot(f.handler.principal, registration)
	v = f.registration(t, registration, next)
	path = "/api/v1/test-sessions/" + v.SessionID
	connected := routeCopy(v)
	connected.ConnectionEpoch, connected.ConnectionState = "1", "synchronizing"
	controller, connected := f.controller(t, v, connected, registration)
	proof.Fence = connected.Fence
	f.expectNext("StopTest")
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.StopTest = func(ctx context.Context, p model.Principal, id string, actual sp.TestStop) (sp.Snapshot, error) {
			f.requestContext(ctx, p, f.handler.principal)
			f.argument(id == connected.SessionID && reflect.DeepEqual(actual, proof), "connected proof input")
			return sp.Snapshot{}, &model.Fault{Code: "session_conflict", Message: "Execution was already started."}
		}
	})
	assertProjectError(t, f.request(http.MethodPost, path+"/stop", jsonBody(t, proof)), http.StatusConflict, "session_conflict")
	_ = controller.CloseNow()
	f.requireCleanup(t, nil)
	proof.StopProof.Kind = ""
	archived = routeCopy(connected)
	archived.Lifecycle, archived.ConnectionState, archived.Operations = "archived", "disconnected", sp.Operations{}
	f.expectNext("StopTest")
	f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
		c.StopTest = func(ctx context.Context, p model.Principal, id string, actual sp.TestStop) (sp.Snapshot, error) {
			f.requestContext(ctx, p, f.handler.principal)
			f.argument(id == connected.SessionID && reflect.DeepEqual(actual, proof), "normal stop proof input")
			return routeCopy(archived), nil
		}
	})
	got := decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, f.request(http.MethodPost, path+"/stop", jsonBody(t, proof)), http.StatusOK)
	if !reflect.DeepEqual(got.Session, archived) {
		t.Fatal("normal stop response changed supplied snapshot")
	}
}

func TestTestSessionCommandOriginIsValidatedAndForwarded(t *testing.T) {
	for _, tc := range []struct {
		name   string
		origin any
		valid  bool
	}{
		{"legacy", nil, true}, {"user", "user", true}, {"daynight", "daynight", true},
		{"null", nil, false}, {"unknown", "system", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newTestSessionRouteFixture(t)
			snapshot := suppliedTestSnapshot(f.handler.principal, independentRegistration("codex"))
			payload := map[string]any{"content": []sp.TextPart{{Type: "text", Text: "notification"}}, "expectedTurnId": nil}
			if tc.name != "legacy" {
				payload["origin"] = tc.origin
			}
			command := sp.Command{Fence: snapshot.Fence, Protocol: sp.Protocol, RequestID: "origin", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(jsonBody(t, payload))}
			if tc.valid {
				f.calls.Configure(func(c *sessionhttp.ServiceCallsForTest) {
					c.Submit = func(ctx context.Context, principal model.Principal, project, task, id string, actual sp.Command) (sp.Operation, error) {
						f.requestContext(ctx, principal, f.handler.principal)
						f.argument(project == "" && task == "" && id == snapshot.SessionID && reflect.DeepEqual(actual, command), "notification command")
						return sp.Operation{Fence: command.Fence, Protocol: sp.Protocol, OperationID: command.OperationID, Kind: command.Kind, State: "accepted"}, nil
					}
				})
			}
			response := f.request(http.MethodPost, "/api/v1/test-sessions/"+snapshot.SessionID+"/commands", jsonBody(t, command))
			if tc.valid {
				decodeResponse[map[string]any](t, response, http.StatusAccepted)
			} else {
				assertProjectError(t, response, http.StatusBadRequest, "invalid_input")
				if f.calls.TotalCalls() != 0 {
					t.Fatal("invalid origin reached business work")
				}
			}
		})
	}
}
