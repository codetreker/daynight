package bot_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func botWireWrite(t *testing.T, conn *websocket.Conn, value any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(jsonBody(t, value))); err != nil {
		t.Fatal(err)
	}
}

func botWireKind(t *testing.T, conn *websocket.Conn, kind string) map[string]json.RawMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		_, body, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("waiting for %s: %v", kind, err)
		}
		var frame map[string]json.RawMessage
		if err := json.Unmarshal(body, &frame); err != nil {
			t.Fatal(err)
		}
		var actual string
		if err := json.Unmarshal(frame["type"], &actual); err != nil {
			t.Fatal(err)
		}
		if actual == "error" {
			t.Fatal("controller rejected frame")
		}
		if actual == kind {
			return frame
		}
	}
}

func TestBotControllerWireCarriesTimelineKindAndAuthorizedOperation(t *testing.T) {
	database := projectTestStore(t)
	handler := projectTestHandler(t, database, io.Discard)
	worker := uuid.NewString()
	reportSnapshotHTTP(t, handler, worker, workerSnapshotReportBody())
	bot := seedHTTPBot(t, database, handler, worker)
	base := "/api/v1/me/workers/" + worker + "/bots/" + bot.ID
	registration := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	instructions := "Use Daynight."
	registered := decodeResponse[struct {
		Bot     api.Bot     `json:"bot"`
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(handler, http.MethodPost, base+"/register", jsonBody(t, map[string]any{
		"botVersion": "1", "registration": registration, "configuration": bot.ResolvedConfiguration,
		"roleConfiguration": map[string]any{"instructions": instructions, "revision": "v1", "digest": fmt.Sprintf("%x", sha256.Sum256([]byte(instructions)))},
	})), http.StatusOK)
	grant := sp.Grant{Protocol: sp.Protocol, TestExecutionID: registration.TestExecutionID, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, ExecutionGeneration: registered.Session.ExecutionGeneration, Kind: "bootstrap"}
	credential := decodeResponse[sessioncore.GrantResult](t, projectRequest(handler, http.MethodPost, base+"/grant", jsonBody(t, map[string]any{"botVersion": strconv.FormatInt(registered.Bot.Version, 10), "grant": grant, "nativeSessionId": nil})), http.StatusOK)
	controllerStarted, controllerFinished := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/controller-channel" {
			close(controllerStarted)
			defer close(controllerFinished)
		}
		handler.ServeHTTP(w, r)
	}))
	var controller *websocket.Conn
	defer func() {
		if controller != nil {
			if err := controller.CloseNow(); err != nil {
				t.Errorf("close controller socket: %v", err)
			}
		}
		shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if err := server.Config.Shutdown(shutdown); err != nil {
			t.Errorf("stop HTTP server: %v", err)
			_ = server.Config.Close()
		}
		select {
		case <-controllerStarted:
			select {
			case <-controllerFinished:
			case <-shutdown.Done():
				t.Error("controller handler did not finish its disconnect")
			}
		default:
		}
		server.Close()
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	controller, response, err := websocket.Dial(ctx, strings.Replace(server.URL, "http://", "ws://", 1)+"/api/v1/controller-channel", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + credential.Token}}})
	cancel()
	if err != nil {
		if response != nil && response.Body != nil {
			_ = response.Body.Close()
		}
		t.Fatal(err)
	}
	epoch := uuid.NewString()
	botWireWrite(t, controller, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: registered.Session.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "0"})
	welcome := botWireKind(t, controller, "welcome")
	snapshot, err := sp.DecodeSnapshot(welcome["session"])
	if err != nil || snapshot.SessionID != registered.Session.SessionID || snapshot.TestExecutionID != registration.TestExecutionID {
		t.Fatalf("Bot controller binding: %+v %v", snapshot, err)
	}
	native := "controlled-bot"
	state := sp.State{NativeSessionID: &native, InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	botWireWrite(t, controller, sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}})
	botWireKind(t, controller, "sync_ack")
	entry, err := sp.DecodeTimeline([]byte(jsonBody(t, map[string]any{"entryId": uuid.NewString(), "entrySeq": "1", "revision": "1", "kind": "assistant_message", "content": []any{map[string]any{"type": "text", "text": "Bot history"}}})))
	if err != nil {
		t.Fatal(err)
	}
	botWireWrite(t, controller, sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "timeline_upsert", Payload: json.RawMessage(jsonBody(t, entry))}}})
	botWireKind(t, controller, "events_ack")
	report := map[string]any{"botVersion": strconv.FormatInt(registered.Bot.Version, 10), "fence": snapshot.ControllerFence, "controllerId": registration.ControllerID, "controllerInstanceId": registration.ControllerInstanceID, "nativeSessionId": native, "result": map[string]any{"state": "ready", "code": nil}}
	decodeResponse[api.Bot](t, projectRequest(handler, http.MethodPost, base+"/report", jsonBody(t, report)), http.StatusOK)
	path := "/api/v1/test-sessions/" + snapshot.SessionID
	timelineCtx, stopTimeline := context.WithTimeout(context.Background(), 10*time.Second)
	timeline := make(chan *httptest.ResponseRecorder, 1)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		request := httptest.NewRequest(http.MethodGet, path+"/timeline?direction=tail&limit=10", nil).WithContext(timelineCtx)
		authorizeResourceRequest(handler, request)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		timeline <- response
	}()
	defer func() {
		stopTimeline()
		select {
		case <-finished:
		case <-time.After(5 * time.Second):
			t.Error("timeline handler did not exit after cancellation")
		}
	}()
	request := botWireKind(t, controller, "content_request")
	var kind, requestID, historyEpoch string
	if json.Unmarshal(request["kind"], &kind) != nil || kind != "timeline" || json.Unmarshal(request["requestId"], &requestID) != nil || requestID == "" || json.Unmarshal(request["historyEpoch"], &historyEpoch) != nil || historyEpoch == "" {
		t.Fatalf("Bot timeline request lost kind or correlation: %s", request["kind"])
	}
	botWireWrite(t, controller, sp.ControllerMessage{Type: "content_response", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, RequestID: requestID, SourceThrough: "1", ContentResult: &sp.ContentResult{Kind: "timeline", HistoryEpoch: historyEpoch, Items: []sp.TimelineEntry{entry}, Resources: []sp.Resource{}}})
	select {
	case response := <-timeline:
		page := decodeResponse[struct {
			Items []json.RawMessage `json:"items"`
		}](t, response, http.StatusOK)
		if len(page.Items) != 1 {
			t.Fatalf("Bot timeline item count: %d", len(page.Items))
		}
		returned, err := sp.DecodeTimeline(page.Items[0])
		if err != nil || returned.EntryID != entry.EntryID {
			t.Fatalf("Bot timeline content missing: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Bot timeline request did not complete")
	}
	command := sp.Command{Fence: snapshot.Fence, Protocol: sp.Protocol, RequestID: "bot-wire", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"Continue"}],"expectedTurnId":null}`)}
	accepted := decodeResponse[struct {
		Operation sp.Operation `json:"operation"`
		URL       string       `json:"operationUrl"`
	}](t, projectRequest(handler, http.MethodPost, path+"/commands", jsonBody(t, command)), http.StatusAccepted)
	offer := botWireKind(t, controller, "operation_offer")
	var offered sp.Command
	if err := json.Unmarshal(offer["command"], &offered); err != nil || offered.OperationID != command.OperationID {
		t.Fatalf("Bot operation offer lost submitted identity: %+v %v", offered, err)
	}
	botWireWrite(t, controller, sp.ControllerMessage{Type: "operation_begin", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, OperationID: command.OperationID})
	authorized := botWireKind(t, controller, "operation_authorized")
	var authorizedID string
	if err := json.Unmarshal(authorized["operationId"], &authorizedID); err != nil || authorizedID != command.OperationID {
		t.Fatalf("Bot authorization lost offered operationId: %q %v", authorizedID, err)
	}
	accepted.Operation.State = "confirmed"
	botWireWrite(t, controller, sp.ControllerMessage{Type: "operation_receipt", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, Operation: &accepted.Operation})
	botWireKind(t, controller, "receipt_ack")
	result := decodeResponse[struct {
		Operation sp.Operation `json:"operation"`
	}](t, projectRequest(handler, http.MethodGet, accepted.URL, ""), http.StatusOK)
	if result.Operation.OperationID != command.OperationID || result.Operation.State != "confirmed" {
		t.Fatalf("Bot receipt not persisted: %+v", result.Operation)
	}
}
