package session_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

func TestTerminalCapabilitiesAreExplicit(t *testing.T) {
	authentication := newRouteAuthentication(t, "https://daynight.example")
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	token := authentication.Credential(principal)
	authentication.ExpectCalls(1)
	routes := sessionhttp.NewRoutesForTest(sessionhttp.ServiceCallsForTest{}, authentication.Authentication, testLogger())
	mux := http.NewServeMux()
	routes.RegisterRoutes(mux)
	r := httptest.NewRequest(http.MethodGet, "/api/v1/session-capabilities", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set(v2.ProtocolHeader, v2.Protocol)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	terminalBoundaryJSON(t, w, map[string]any{
		"protocol": v2.Protocol, "schemaVersion": 2, "projectionVersion": 1,
		"providers": []string{"codex", "claude", "copilot"}, "backends": []string{"herdr"},
		"recordingResponsibilityVersion": 1, "controlDispatchVersion": 1, "workerCapabilitiesRequired": true,
	})
	if authentication.Count() != 1 {
		t.Fatal("capabilities did not authenticate the supplied credential exactly once")
	}
}

func TestTerminalHTTPRefusesMalformedAndCrossRouteMessages(t *testing.T) {
	f := terminalHTTPSetup(t)
	path := f.base + "/" + f.message.SessionID
	for _, protocol := range []string{"future", " "} {
		w := terminalBoundaryRequest(t, f, http.MethodGet, f.base+"/current", "", protocol, nil)
		if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "unsupported_protocol") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	validBody := jsonBody(t, f.message)
	duplicateProtocol := strings.TrimSuffix(validBody, "}") + `,"protocol":"daynight.session.v2"}`
	for _, body := range []string{"{}", duplicateProtocol} {
		w := terminalBoundaryRequest(t, f, http.MethodPost, f.base, body, v2.Protocol, nil)
		if w.Code != http.StatusBadRequest {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, tc := range []struct{ method, suffix, body string }{
		{http.MethodGet, "/timeline", ""},
		{http.MethodPost, "/worker-messages", jsonBody(t, f.message)},
		{http.MethodGet, "/channel", ""},
	} {
		w := terminalBoundaryRequest(t, f, tc.method, path+tc.suffix, tc.body, v2.Protocol, nil)
		if w.Code != http.StatusBadRequest {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if got := f.calls.TotalCalls(); got != 0 {
		t.Fatalf("protocol refusals called business operations %d times", got)
	}

	f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.TerminalReceipt = func(ctx context.Context, principal model.Principal, project, task, id string) (v2.Message, error) {
			terminalBoundaryScope(t, f, ctx, principal, project, task, id)
			return v2.Message{}, &model.Fault{Code: "session_conflict", Message: "A receipt is not available."}
		}
	})
	f.calls.ExpectCalls("TerminalReceipt", 1)
	w := terminalBoundaryRequest(t, f, http.MethodGet, path+"/archive/receipt", "", v2.Protocol, nil)
	terminalBoundaryFault(t, w, http.StatusConflict, "session_conflict")
	if got := f.calls.TotalCalls(); got != 1 {
		t.Fatalf("receipt error mapping called %d business operations, want one", got)
	}
}

func TestTerminalHTTPBoundaryAndReadbackErrors(t *testing.T) {
	evidenceID, recoveryID, operationID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, tc := range []struct {
		name, method, suffix, body, protocol string
		status                               int
		callback, fault                      string
	}{
		{"state", "GET", "/state", "", v2.Protocol, 200, "TerminalState", ""},
		{"canonical state identifiers", "GET", "/state", "", v2.Protocol, 200, "TerminalState", ""},
		{"archive state", "GET", "/archive/state", "", v2.Protocol, 200, "TerminalArchiveState", ""},
		{"archive state missing protocol", "GET", "/archive/state", "", "", 400, "", ""},
		{"archive state v1", "GET", "/archive/state", "", sp.Protocol, 400, "", ""},
		{"archive state future protocol", "GET", "/archive/state", "", "future", 400, "", ""},
		{"archive state extra query", "GET", "/archive/state?extra=1", "", v2.Protocol, 400, "", ""},
		{"archive state duplicate query", "GET", "/archive/state?generation=1&generation=2", "", v2.Protocol, 400, "", ""},
		{"archive state HEAD", "HEAD", "/archive/state", "", v2.Protocol, 405, "", ""},
		{"archive state POST", "POST", "/archive/state", "{}", v2.Protocol, 405, "", ""},
		{"archive state DELETE", "DELETE", "/archive/state", "", v2.Protocol, 405, "", ""},
		{"state missing protocol", "GET", "/state", "", "", 400, "", ""},
		{"state HEAD", "HEAD", "/state", "", v2.Protocol, 405, "", ""},
		{"state DELETE", "DELETE", "/state", "", v2.Protocol, 405, "", ""},
		{"worker messages HEAD", "HEAD", "/worker-messages", "", v2.Protocol, 405, "", ""},
		{"archive status", "GET", "/archive", "", v2.Protocol, 200, "TerminalArchiveStatus", ""},
		{"archive download preflight", "GET", "/archive/content", "", v2.Protocol, 409, "TryReserveArchivePreflight", "session_conflict"},
		{"archive upload preflight", "PUT", "/archive", "{}", v2.Protocol, 409, "TryReserveArchivePreflight", "session_conflict"},
		{"missing evidence", "GET", "/recording-evidence/" + evidenceID + "?generation=1", "", v2.Protocol, 404, "TerminalRecordingEvidence", "not_found"},
		{"evidence extra query", "GET", "/recording-evidence/" + evidenceID + "?extra=1", "", v2.Protocol, 400, "", ""},
		{"missing recovery", "GET", "/automation-recovery/" + recoveryID, "", v2.Protocol, 404, "TerminalAutomationRecovery", "not_found"},
		{"recovery extra query", "GET", "/automation-recovery/" + recoveryID + "?extra=1", "", v2.Protocol, 400, "", ""},
		{"recovery v1", "GET", "/automation-recovery/" + recoveryID, "", sp.Protocol, 400, "", ""},
		{"state extra query", "GET", "/state?extra=1", "", v2.Protocol, 400, "", ""},
		{"missing operation", "GET", "/operations/" + operationID, "", v2.Protocol, 404, "TerminalOperation", "not_found"},
		{"command missing browser", "POST", "/commands", "registration", v2.Protocol, 400, "", ""},
		{"worker messages extra query", "POST", "/worker-messages?extra=1", "registration", v2.Protocol, 400, "", ""},
		{"worker channel extra query", "GET", "/worker-channel?extra=1", "", v2.Protocol, 400, "", ""},
		{"worker channel missing subprotocol", "GET", "/worker-channel", "", v2.Protocol, 400, "", ""},
		{"browser channel extra query", "GET", "/channel?extra=1", "", v2.Protocol, 400, "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := terminalHTTPSetup(t)
			var expected any
			fault := &model.Fault{Code: tc.fault, Message: "Supplied use-case result."}
			scope := func(ctx context.Context, principal model.Principal, project, task, id string) {
				terminalBoundaryScope(t, f, ctx, principal, project, task, id)
			}
			switch tc.callback {
			case "TerminalState":
				expected = f.knownState("7")
				f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
					calls.TerminalState = func(ctx context.Context, p model.Principal, project, task, id string) (map[string]any, error) {
						scope(ctx, p, project, task, id)
						return expected.(map[string]any), nil
					}
				})
			case "TerminalArchiveState":
				expected = f.knownState("9")
				f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
					calls.TerminalArchiveState = func(ctx context.Context, p model.Principal, project, task, id string) (map[string]any, error) {
						scope(ctx, p, project, task, id)
						return expected.(map[string]any), nil
					}
				})
			case "TerminalArchiveStatus":
				message := f.message
				message.Type, message.Payload = "archive_status", v2.ArchiveStatus{State: "pending"}
				expected = message
				f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
					calls.TerminalArchiveStatus = func(ctx context.Context, p model.Principal, project, task, id string) (v2.Message, error) {
						scope(ctx, p, project, task, id)
						return message, nil
					}
				})
			case "TerminalRecordingEvidence":
				f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
					calls.TerminalRecordingEvidence = func(ctx context.Context, p model.Principal, project, task, id, generation, evidence string) (map[string]any, error) {
						scope(ctx, p, project, task, id)
						if generation != "1" || evidence != evidenceID {
							t.Fatal("evidence route changed generation or evidence identity", generation, evidence)
						}
						return nil, fault
					}
				})
			case "TerminalAutomationRecovery":
				f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
					calls.TerminalAutomationRecovery = func(ctx context.Context, p model.Principal, project, task, id, recovery string) (v2.Message, error) {
						scope(ctx, p, project, task, id)
						if recovery != recoveryID {
							t.Fatal("recovery route changed its identity", recovery)
						}
						return v2.Message{}, fault
					}
				})
			case "TerminalOperation":
				f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
					calls.TerminalOperation = func(ctx context.Context, p model.Principal, project, task, id, operation string) (v2.Message, error) {
						scope(ctx, p, project, task, id)
						if operation != operationID {
							t.Fatal("operation route changed its identity", operation)
						}
						return v2.Message{}, fault
					}
				})
			case "TryReserveArchivePreflight":
				f.calls.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
					calls.TryReserveArchivePreflight = func() (io.Closer, error) { return nil, fault }
				})
			}
			if tc.callback != "" {
				f.calls.ExpectCalls(tc.callback, 1)
			}
			body := tc.body
			if body == "registration" {
				body = jsonBody(t, f.message)
			}
			requestPath := f.base + "/" + f.message.SessionID + tc.suffix
			if tc.name == "canonical state identifiers" {
				owner := f.message.Payload.(v2.Registration).Owner
				for _, id := range []string{owner.ProjectID, owner.TaskID, f.message.SessionID} {
					requestPath = strings.ReplaceAll(requestPath, id, strings.ToUpper(id))
				}
			}
			w := terminalBoundaryRequest(t, f, tc.method, requestPath, body, tc.protocol, nil)
			if w.Code != tc.status {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.status, w.Body.String())
			}
			if tc.fault != "" {
				terminalBoundaryFault(t, w, tc.status, tc.fault)
			}
			if expected != nil {
				terminalBoundaryJSON(t, w, expected)
			}
			wantCalls := 0
			if tc.callback != "" {
				wantCalls = 1
			}
			if got := f.calls.TotalCalls(); got != wantCalls {
				t.Fatalf("business calls = %d, want %d", got, wantCalls)
			}
		})
	}

	f := terminalHTTPSetup(t)
	for _, query := range []string{"?limit=no", "?extra=1"} {
		w := terminalBoundaryRequest(t, f, http.MethodGet, f.base+query, "", v2.Protocol, nil)
		if w.Code != http.StatusBadRequest {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, contentType := range []string{"text/plain", "application/json; charset=latin1"} {
		w := terminalBoundaryRequest(t, f, http.MethodPost, f.base, jsonBody(t, f.message), v2.Protocol, func(r *http.Request) { r.Header.Set("Content-Type", contentType) })
		if w.Code != http.StatusBadRequest {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	path := f.base + "/" + f.message.SessionID
	other := f.message
	other.SessionID = uuid.NewString()
	w := terminalBoundaryRequest(t, f, http.MethodPost, path+"/worker-messages", jsonBody(t, other), v2.Protocol, nil)
	terminalBoundaryFault(t, w, http.StatusConflict, "stale_fence")
	for _, epoch := range []string{"0", "01", "no"} {
		w := terminalBoundaryRequest(t, f, http.MethodPost, path+"/worker-messages", jsonBody(t, f.message), v2.Protocol, func(r *http.Request) { r.Header.Set("Daynight-Connection-Epoch", epoch) })
		if w.Code != http.StatusBadRequest {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	for _, badPath := range []string{
		strings.Replace(f.base, f.message.Payload.(v2.Registration).Owner.ProjectID, "invalid", 1) + "/" + f.message.SessionID + "/state",
		strings.Replace(f.base, f.message.Payload.(v2.Registration).Owner.TaskID, "invalid", 1) + "/" + f.message.SessionID + "/state",
		f.base + "/invalid/state",
		path + "/operations/invalid",
	} {
		w := terminalBoundaryRequest(t, f, http.MethodGet, badPath, "", v2.Protocol, nil)
		if w.Code != http.StatusBadRequest {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if got := f.calls.TotalCalls(); got != 0 {
		t.Fatalf("malformed HTTP input called business operations %d times", got)
	}
}

func TestTerminalWorkerChannelRejectsBinaryRegistration(t *testing.T) {
	f := terminalHTTPSetup(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	header := f.workerHeaders()
	c, _, err := websocket.Dial(ctx, f.server.URL+f.base+"/"+f.message.SessionID+"/worker-channel", &websocket.DialOptions{HTTPHeader: header, Subprotocols: []string{v2.Protocol}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err = c.Write(ctx, websocket.MessageBinary, []byte(jsonBody(t, f.message))); err != nil {
		t.Fatal(err)
	}
	if _, _, err = c.Read(ctx); err == nil {
		t.Fatal("binary registration accepted")
	}
	if ctx.Err() != nil {
		t.Fatal("binary registration did not close the socket before the caller deadline", err)
	}
	if got := f.calls.TotalCalls(); got != 0 {
		t.Fatalf("binary first frame called business operations %d times", got)
	}
}

type terminalBoundaryContextKey struct{}

func terminalBoundaryRequest(t *testing.T, f *terminalHTTPFixture, method, path, body, protocol string, configure func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r = r.WithContext(context.WithValue(r.Context(), terminalBoundaryContextKey{}, t))
	r.Header.Set("Authorization", "Bearer "+f.h.token)
	r.Header.Set("Content-Type", "application/json")
	if protocol != "" {
		r.Header.Set(v2.ProtocolHeader, protocol)
	}
	if configure != nil {
		configure(r)
	}
	w := httptest.NewRecorder()
	f.h.ServeHTTP(w, r)
	return w
}

func terminalBoundaryScope(t *testing.T, f *terminalHTTPFixture, ctx context.Context, principal model.Principal, project, task, id string) {
	t.Helper()
	owner := f.message.Payload.(v2.Registration).Owner
	if ctx.Value(terminalBoundaryContextKey{}) != t || ctx.Err() != nil || principal != f.h.principal || project != owner.ProjectID || task != owner.TaskID || id != f.message.SessionID {
		t.Fatal("HTTP adapter changed principal, context or canonical resource identifiers", principal, project, task, id)
	}
}

func terminalBoundaryJSON(t *testing.T, w *httptest.ResponseRecorder, expected any) {
	t.Helper()
	if w.Header().Get("Content-Type") != "application/json" {
		t.Fatal("response did not select JSON", w.Header())
	}
	var got, want any
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(jsonBody(t, expected)), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("HTTP encoder changed supplied output: got %s, want %s", w.Body.String(), jsonBody(t, expected))
	}
}

func terminalBoundaryFault(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	var response api.ErrorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if w.Code != status || response.Error.Code != code {
		t.Fatalf("HTTP error mapping: status %d, body %s", w.Code, w.Body.String())
	}
}
