package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"github.com/coder/websocket"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionrelay"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestTestSessionHTTPAndChannelRequireOwnerCredential(t *testing.T) {
	f := sessionHTTPSetup(t)
	registration := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "claude", InitialInput: "none"}
	result := decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(f.handler, http.MethodPost, "/api/v1/test-sessions", jsonBody(t, registration)), http.StatusOK)
	v := result.Session
	path := "/api/v1/test-sessions/" + v.SessionID
	if v.Identity.OwnerUserID != f.handler.principal.UserID || v.Identity.ProjectID != "" || v.TestExecutionID != registration.TestExecutionID {
		t.Fatal("wrong test identity", v)
	}
	for _, route := range []string{"/api/v1/test-session-capabilities", path, path + "/timeline", path + "/operations/" + uuid.NewString(), path + "/resources/" + uuid.NewString() + "/content", path + "/channel"} {
		response := httptest.NewRecorder()
		f.handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, route, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatal("anonymous route", route, response.Code)
		}
	}
	for _, route := range []string{"/api/v1/test-session-capabilities", path, path + "/timeline"} {
		expected := http.StatusOK
		if route == path+"/timeline" {
			expected = http.StatusServiceUnavailable
		}
		if response := projectRequest(f.handler, http.MethodGet, route, ""); response.Code != expected {
			t.Fatal("owner route", route, response.Code, response.Body.String())
		}
	}
	if response := projectRequest(f.handler, http.MethodGet, f.base+"/"+v.SessionID+"/timeline", ""); response.Code == http.StatusOK {
		t.Fatal("test leaked into task route")
	}
	if response := projectRequest(f.handler, http.MethodGet, "/api/v1/test-sessions/"+f.snapshot.SessionID, ""); response.Code == http.StatusOK {
		t.Fatal("task leaked into test route")
	}
	grant := decodeResponse[sessionrelay.GrantResult](t, projectRequest(f.handler, http.MethodPost, path+"/controller-grant", jsonBody(t, sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})), http.StatusOK)
	controller := sessionDial(t, f.server.URL, "/api/v1/controller-channel", grant.Token, nil)
	epoch := uuid.NewString()
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Provider: "claude", SourceEpoch: epoch, LastAckedSourceSeq: "0"})
	welcome := sessionWSKind(t, controller, "welcome")
	var err error
	v, err = sp.DecodeSnapshot(welcome["session"])
	if err != nil {
		t.Fatal(err)
	}
	browser := sessionDial(t, f.server.URL, path+"/channel", f.handler.token, nil)
	sessionWSKind(t, browser, "snapshot")
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}})
	sessionWSKind(t, controller, "sync_ack")
	raw, _ := json.Marshal(state)
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: raw}}})
	sessionWSKind(t, controller, "events_ack")
	command := sp.Command{Fence: v.Fence, Protocol: sp.Protocol, RequestID: "first", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"hello"}],"expectedTurnId":null}`)}
	response := projectRequest(f.handler, http.MethodPost, path+"/commands", jsonBody(t, command))
	if response.Code != http.StatusAccepted || response.Header().Get("Location") != path+"/operations/"+command.OperationID {
		t.Fatal("command location", response.Code, response.Body.String())
	}
	offer := sessionWSKind(t, controller, "operation_offer")
	if string(offer["testExecutionId"]) != "\""+v.TestExecutionID+"\"" || offer["claimId"] != nil {
		t.Fatal("offer scope", offer)
	}
	// Revocation closes both already-open channels and rejects every subsequent read.
	if _, err = f.db.Pool.Exec(context.Background(), `DELETE FROM personal_access_tokens WHERE id=$1`, f.handler.principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	for _, conn := range []*websocket.Conn{browser, controller} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		for {
			_, _, err = conn.Read(ctx)
			if err != nil {
				break
			}
		}
		timedOut := ctx.Err() != nil
		cancel()
		if timedOut {
			t.Fatal("revoked channel remained open")
		}
	}
	if response = projectRequest(f.handler, http.MethodGet, path, ""); response.Code != http.StatusUnauthorized {
		t.Fatal("revoked read", response.Code)
	}
}

func TestTestSessionHTTPStopRequiresValidProofOwnerAndScope(t *testing.T) {
	f := sessionHTTPSetup(t)
	registration := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	value := decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(f.handler, http.MethodPost, "/api/v1/test-sessions", jsonBody(t, registration)), http.StatusOK)
	v := value.Session
	path := "/api/v1/test-sessions/" + v.SessionID
	proof := sp.TestStop{Protocol: sp.Protocol, Fence: v.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	for _, input := range []struct {
		path, body string
		status     int
	}{
		{path + "/stop?unknown=1", jsonBody(t, proof), http.StatusBadRequest},
		{path + "/stop", "{}", http.StatusBadRequest},
		{path + "/stop", `{"protocol":"daynight.session.v1"`, http.StatusBadRequest},
		{"/api/v1/test-sessions?unknown=1", jsonBody(t, registration), http.StatusBadRequest},
		{"/api/v1/test-sessions", "{}", http.StatusBadRequest},
		{"/api/v1/test-sessions/" + f.snapshot.SessionID + "/stop", jsonBody(t, proof), http.StatusConflict},
	} {
		response := projectRequest(f.handler, http.MethodPost, input.path, input.body)
		if response.Code != input.status {
			t.Fatalf("invalid lifecycle request %s: %d %s", input.path, response.Code, response.Body.String())
		}
	}
	for _, route := range []string{path + "?unknown=1", "/api/v1/test-session-capabilities?unknown=1"} {
		assertProjectError(t, projectRequest(f.handler, http.MethodGet, route, ""), http.StatusBadRequest, "invalid_input")
	}
	capability := decodeResponse[map[string]any](t, projectRequest(f.handler, http.MethodGet, "/api/v1/test-session-capabilities", ""), http.StatusOK)
	if len(capability) != 4 || capability["protocol"] != sp.Protocol {
		t.Fatal("Test capability contract", capability)
	}
	for _, route := range []string{path, path + "/stop", "/api/v1/test-session-capabilities"} {
		response := projectRequest(f.handler, http.MethodDelete, route, "")
		if response.Code != http.StatusMethodNotAllowed {
			t.Fatal("method admission", route, response.Code)
		}
	}
	anonymous := httptest.NewRecorder()
	anonymousRequest := httptest.NewRequest(http.MethodPost, path+"/stop", strings.NewReader(jsonBody(t, proof)))
	anonymousRequest.Header.Set("X-Request-ID", "project-test")
	f.handler.ServeHTTP(anonymous, anonymousRequest)
	assertProjectError(t, anonymous, http.StatusUnauthorized, "unauthenticated")
	// A valid but different principal cannot archive even with the exact public URL and proof.
	outsiderID, tokenID := uuid.NewString(), uuid.NewString()
	token := "dnpat_" + base64.RawURLEncoding.EncodeToString(make([]byte, 32))
	digest := sha256.Sum256([]byte(token))
	if _, err := f.db.Pool.Exec(context.Background(), `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, outsiderID, "test-stop-other-"+outsiderID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(context.Background(), `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'other owner',now(),now()+interval '1 hour')`, tokenID, outsiderID, digest[:]); err != nil {
		t.Fatal(err)
	}
	outsider := &resourceTestHandler{Handler: f.handler.Handler, token: token}
	assertProjectError(t, projectRequest(outsider, http.MethodPost, path+"/stop", jsonBody(t, proof)), http.StatusForbidden, "forbidden")
	assertProjectError(t, projectRequest(outsider, http.MethodGet, path, ""), http.StatusForbidden, "forbidden")
	// A never-started proof is accepted and repeatable, without granting controller access.
	archived := decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(f.handler, http.MethodPost, path+"/stop", jsonBody(t, proof)), http.StatusOK)
	if archived.Session.Lifecycle != "archived" || archived.Session.Operations.CanSend {
		t.Fatal("stop did not archive", archived)
	}
	decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(f.handler, http.MethodPost, path+"/stop", jsonBody(t, proof)), http.StatusOK)
	// Once a controller connected, that proof becomes false even after disconnection.
	registration.RegistrationID = uuid.NewString()
	registration.TestExecutionID = uuid.NewString()
	value = decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(f.handler, http.MethodPost, "/api/v1/test-sessions", jsonBody(t, registration)), http.StatusOK)
	v = value.Session
	path = "/api/v1/test-sessions/" + v.SessionID
	proof.Fence = v.Fence
	grant := decodeResponse[sessionrelay.GrantResult](t, projectRequest(f.handler, http.MethodPost, path+"/controller-grant", jsonBody(t, sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})), http.StatusOK)
	controller := sessionDial(t, f.server.URL, "/api/v1/controller-channel", grant.Token, nil)
	sessionWSWrite(t, controller, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0"})
	sessionWSKind(t, controller, "welcome")
	assertProjectError(t, projectRequest(f.handler, http.MethodPost, path+"/stop", jsonBody(t, proof)), http.StatusConflict, "session_conflict")
	_ = controller.CloseNow()
	proof.StopProof.Kind = ""
	archived = decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(f.handler, http.MethodPost, path+"/stop", jsonBody(t, proof)), http.StatusOK)
	if archived.Session.Lifecycle != "archived" {
		t.Fatal("normal stop proof not recorded")
	}
}
