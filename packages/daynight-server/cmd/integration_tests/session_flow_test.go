//go:build integration

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

type sessionWorkerTransport struct{ next http.RoundTripper }

func (r sessionWorkerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	copy := request.Clone(request.Context())
	copy.Header.Set("Daynight-Worker-Protocol", "2")
	return r.next.RoundTrip(copy)
}

func TestServerAPISessionNormalFlow(t *testing.T) {
	f := newFixtureWithDecoder(t, true)
	client := *f.client
	client.Transport = sessionWorkerTransport{next: client.Transport}
	f.client = &client
	project := createProject(t, f, "API native Session")
	task := createTask(t, f, project, "Native Session task", map[string]any{"assignedTo": f.userID, "status": "todo"})
	task = requestJSON[api.Task](t, f, http.MethodPatch, taskPath(task), map[string]any{"version": task.Version, "allowAgents": true}, http.StatusOK)
	claimID, workerID, worktreeID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	claimed := requestJSON[api.Task](t, f, http.MethodPost, taskPath(task)+"/worker-claim", map[string]any{
		"version": task.Version, "claimId": claimID, "workerId": workerID, "worktreeId": worktreeID,
		"machine":  map[string]any{"id": uuid.NewString(), "name": "Session integration machine"},
		"platform": "linux", "agent": "codex", "agentControlMode": "web",
	}, http.StatusOK)
	claim := workerClaim(t, claimed)
	if claimed.ID != task.ID || claimed.Status != "in_progress" || claim.ClaimID != claimID || claim.WorkerID != workerID || claim.WorktreeID != worktreeID || claim.UserID != f.userID || claim.AgentControlMode != "web" {
		t.Fatalf("Session Worker claim differs: task=%+v claim=%+v", claimed, claim)
	}

	base := taskPath(claimed) + "/sessions"
	registration := sp.Registration{
		Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: claimID,
		WorkerID: workerID, WorktreeID: worktreeID, Provider: "codex",
		ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(),
	}
	registered := requestJSON[struct {
		Session sp.Snapshot `json:"session"`
	}](t, f, http.MethodPost, base, registration, http.StatusOK).Session
	if registered.SessionID == "" || registered.ClaimID != claimID || registered.ExecutionGeneration != "1" || registered.Identity.ProjectID != project.ID || registered.Identity.TaskID != task.ID || registered.Identity.WorkerID != workerID || registered.Identity.WorktreeID != worktreeID || registered.Identity.ControllerID != registration.ControllerID || registered.Identity.ControllerInstanceID != registration.ControllerInstanceID {
		t.Fatalf("registered Session identity differs: %+v", registered)
	}
	grant := requestJSON[struct {
		Token               string `json:"token"`
		SessionID           string `json:"sessionId"`
		ClaimID             string `json:"claimId"`
		ExecutionGeneration string `json:"executionGeneration"`
	}](t, f, http.MethodPost, base+"/"+registered.SessionID+"/controller-grant", sp.Grant{
		Protocol: sp.Protocol, ClaimID: claimID, ControllerID: registration.ControllerID,
		ControllerInstanceID: registration.ControllerInstanceID, ExecutionGeneration: registered.ExecutionGeneration, Kind: "bootstrap",
	}, http.StatusOK)
	if grant.Token == "" || grant.SessionID != registered.SessionID || grant.ClaimID != claimID || grant.ExecutionGeneration != registered.ExecutionGeneration {
		t.Fatalf("controller grant identity differs: session=%s claim=%s generation=%s", grant.SessionID, grant.ClaimID, grant.ExecutionGeneration)
	}

	controller := sessionFlowDial(t, f, "/api/v1/controller-channel", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + grant.Token}}})
	sourceEpoch := uuid.NewString()
	sessionFlowWrite(t, f, controller, sp.ControllerMessage{
		Type: "hello", Protocol: sp.Protocol, ControllerFence: registered.ControllerFence,
		SchemaVersion: 1, ProjectionVersion: 1, ControllerID: registration.ControllerID,
		ControllerInstanceID: registration.ControllerInstanceID, Provider: registration.Provider,
		SourceEpoch: sourceEpoch, LastAckedSourceSeq: "0",
	})
	welcome := sessionFlowRead(t, f, controller)
	sessionFlowKind(t, welcome, "welcome")
	connected, err := sp.DecodeSnapshot(welcome["session"])
	if err != nil {
		t.Fatal(err)
	}
	if connected.Fence != registered.Fence || connected.ConnectionEpoch == "0" || connected.ConnectionState != "synchronizing" {
		t.Fatalf("controller welcome differs: %+v", connected)
	}
	nativeID := "api-native-" + uuid.NewString()
	state := sp.State{NativeSessionID: &nativeID, InitialInputState: connected.InitialInputState, Synchronized: true, Activity: "initializing"}
	sessionFlowWrite(t, f, controller, sp.ControllerMessage{
		Type: "sync_state", Protocol: sp.Protocol, ControllerFence: connected.ControllerFence,
		State: &state, PendingInteractions: []sp.TimelineEntry{},
	})
	sync := sessionFlowRead(t, f, controller)
	sessionFlowKind(t, sync, "sync_ack")

	current := requestJSON[struct {
		Status  string      `json:"status"`
		Session sp.Snapshot `json:"session"`
	}](t, f, http.MethodGet, base+"/current", nil, http.StatusOK)
	if current.Status != "registered" || current.Session.ControllerFence != connected.ControllerFence || !current.Session.Synchronized || current.Session.ConnectionState != "connected" || current.Session.Identity.NativeSessionID == nil || *current.Session.Identity.NativeSessionID != nativeID {
		t.Fatalf("current Session readback differs: %+v", current)
	}
	browser := sessionFlowDial(t, f, base+"/"+registered.SessionID+"/channel", &websocket.DialOptions{HTTPClient: f.client})
	initial := sessionFlowRead(t, f, browser)
	sessionFlowKind(t, initial, "snapshot")
	projection, err := sp.DecodeSnapshot(initial["snapshot"])
	if err != nil || projection.ControllerFence != current.Session.ControllerFence || !projection.Synchronized || projection.Identity.NativeSessionID == nil || *projection.Identity.NativeSessionID != nativeID {
		t.Fatalf("browser Session snapshot differs: snapshot=%+v error=%v", projection, err)
	}
	var browserUserID, cursor string
	if err := json.Unmarshal(initial["userId"], &browserUserID); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(initial["cursor"], &cursor); err != nil || cursor == "" || browserUserID != f.userID {
		t.Fatalf("browser owner/cursor differs: user=%s cursor=%s error=%v", browserUserID, cursor, err)
	}
	application := sessionFlowDial(t, f, base+"/"+registered.SessionID+"/channel", &websocket.DialOptions{
		HTTPHeader:   http.Header{"Origin": {"https://client.example"}},
		Subprotocols: []string{sp.Protocol, "daynight.authorization." + sessionFlowAPIAccess(t, f)},
	})
	applicationInitial := sessionFlowRead(t, f, application)
	sessionFlowKind(t, applicationInitial, "snapshot")
	applicationProjection, err := sp.DecodeSnapshot(applicationInitial["snapshot"])
	var applicationUser string
	if err := json.Unmarshal(applicationInitial["userId"], &applicationUser); err != nil {
		t.Fatal(err)
	}
	if err != nil || applicationProjection.ControllerFence != connected.ControllerFence || applicationUser != f.userID || application.Subprotocol() != sp.Protocol {
		t.Fatalf("application Session identity differs: snapshot=%+v error=%v", applicationProjection, err)
	}

	entryID := uuid.NewString()
	content, err := json.Marshal([]map[string]string{{"type": "text", "text": "Native Session API content"}})
	if err != nil {
		t.Fatal(err)
	}
	entry := sp.TimelineEntry{EntryID: entryID, Revision: "1", Kind: "assistant_message", Data: map[string]json.RawMessage{"content": content}}
	payload, err := json.Marshal(entry)
	if err != nil {
		t.Fatal(err)
	}
	batchID := uuid.NewString()
	sessionFlowWrite(t, f, controller, sp.ControllerMessage{
		Type: "events", Protocol: sp.Protocol, ControllerFence: connected.ControllerFence,
		SourceEpoch: sourceEpoch, BatchID: batchID,
		Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "timeline_upsert", Payload: payload}},
	})
	ack := sessionFlowRead(t, f, controller)
	sessionFlowKind(t, ack, "events_ack")
	var acknowledgedBatch, acknowledgedSequence string
	if err := json.Unmarshal(ack["batchId"], &acknowledgedBatch); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(ack["lastAckedSourceSeq"], &acknowledgedSequence); err != nil || acknowledgedBatch != batchID || acknowledgedSequence != "1" {
		t.Fatalf("source acknowledgement differs: batch=%s sequence=%s error=%v", acknowledgedBatch, acknowledgedSequence, err)
	}
	for _, viewer := range []*websocket.Conn{browser, application} {
		found := false
		for range 8 {
			frame := sessionFlowRead(t, f, viewer)
			var kind string
			if err := json.Unmarshal(frame["type"], &kind); err != nil {
				t.Fatal(err)
			}
			if kind == "snapshot" {
				continue
			}
			sessionFlowKind(t, frame, "event")
			event, err := sp.DecodeEvent(frame["event"])
			if err != nil || event.Fence != registered.Fence || event.ConnectionEpoch != connected.ConnectionEpoch {
				t.Fatalf("browser event identity differs: event=%+v error=%v", event, err)
			}
			if event.Kind == "snapshot" {
				continue
			}
			actual, err := sp.DecodeTimeline(event.Payload)
			if err != nil || event.Kind != "timeline_upsert" || actual.EntryID != entryID || actual.EntrySeq != "1" || actual.Revision != entry.Revision || actual.Kind != entry.Kind || !bytes.Equal(actual.Data["content"], content) {
				t.Fatalf("browser timeline content differs: event=%+v entry=%+v error=%v", event, actual, err)
			}
			found = true
			break
		}
		if !found {
			t.Fatal("browser did not receive the controller's timeline entry")
		}
	}
	sessionDirectImageFlow(t, f)
}

func sessionFlowDial(t *testing.T, f *fixture, path string, options *websocket.DialOptions) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(f.context, 5*time.Second)
	defer cancel()
	connection, _, err := websocket.Dial(ctx, strings.Replace(f.origin, "http://", "ws://", 1)+path, options)
	if err != nil {
		t.Fatalf("Session WebSocket %s: %v", path, err)
	}
	t.Cleanup(func() {
		if err := connection.Close(websocket.StatusNormalClosure, "API flow complete"); err != nil {
			t.Error(err)
		}
	})
	return connection
}

func sessionFlowWrite(t *testing.T, f *fixture, connection *websocket.Conn, message sp.ControllerMessage) {
	t.Helper()
	data, err := json.Marshal(message)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(f.context, 5*time.Second)
	defer cancel()
	if err := connection.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatal(err)
	}
}

func sessionFlowRead(t *testing.T, f *fixture, connection *websocket.Conn) map[string]json.RawMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(f.context, 5*time.Second)
	defer cancel()
	kind, data, err := connection.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if kind != websocket.MessageText {
		t.Fatal("Session sent a non-text frame")
	}
	var frame map[string]json.RawMessage
	if err := json.Unmarshal(data, &frame); err != nil {
		t.Fatal(err)
	}
	return frame
}

func sessionFlowKind(t *testing.T, frame map[string]json.RawMessage, expected string) {
	t.Helper()
	var kind, protocol string
	if err := json.Unmarshal(frame["type"], &kind); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(frame["protocol"], &protocol); err != nil {
		t.Fatal(err)
	}
	if kind != expected || protocol != sp.Protocol {
		t.Fatalf("Session frame kind/protocol differs: kind=%s protocol=%s expected=%s", kind, protocol, expected)
	}
}
