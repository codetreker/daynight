package session_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/google/uuid"
)

func TestSessionRoutesContentRequiresItsOnlineController(t *testing.T) {
	f := sessionHTTPSetup(t)
	registered := routeCopy(f.snapshot)
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Register = func(ctx context.Context, p model.Principal, project, task string, input sp.Registration) (sp.Snapshot, error) {
			if err := f.require(ctx != nil && p == f.handler.principal && project == f.task.ProjectID && task == f.task.ID && reflect.DeepEqual(input, f.registration), "Register changed decoded scoped registration"); err != nil {
				return sp.Snapshot{}, err
			}
			return registered, nil
		}
	})
	response := decodeResponse[struct {
		Session sp.Snapshot `json:"session"`
	}](t, projectRequest(f.handler, http.MethodPost, f.base, jsonBody(t, f.registration)), http.StatusOK)
	if !reflect.DeepEqual(response.Session, registered) {
		t.Fatal("registration envelope changed the supplied Snapshot")
	}
	f.grant = f.mint(t, "bootstrap")
	epoch := uuid.NewString()
	controller, snapshot := f.controller(t, epoch)
	ready := routeCopy(snapshot)
	ready.ConnectionState = "connected"
	ready.Synchronized = true
	ready.InitialInputState = "provider_accepted"
	ready.Activity = "idle"
	native := "native-session"
	ready.Identity.NativeSessionID = &native
	ready.Capabilities = sp.Capabilities{Send: true, Cancel: true, Respond: true}
	ready.Operations.CanSend = true
	path := f.base + "/" + snapshot.SessionID
	entryID, resourceID := uuid.NewString(), uuid.NewString()
	content := []byte("local resource")
	digest := sha256.Sum256(content)
	hash := hex.EncodeToString(digest[:])
	media, size := "text/plain", strconv.Itoa(len(content))
	descriptor := sp.Resource{ResourceID: resourceID, Status: "available", Name: "output.txt", MediaType: &media, ByteLength: &size, SHA256: &hash}
	entry, err := sp.DecodeTimeline([]byte(jsonBody(t, map[string]any{"entryId": entryID, "entrySeq": "1", "revision": "1", "kind": "assistant_message", "content": []any{map[string]any{"type": "text", "text": "Local output"}, map[string]any{"type": "resource", "resourceId": resourceID, "label": "Output"}}})))
	if err != nil {
		t.Fatal(err)
	}
	initialCursor, endCursor := "native-before-events", "native-after-events"
	event := nativeFrame(snapshot.ControllerFence, map[string]any{"protocol": sp.Protocol, "connectionEpoch": snapshot.ConnectionEpoch, "eventSeq": "1", "historyEpoch": snapshot.HistoryEpoch, "kind": "timeline_upsert", "payload": entry})
	eventsReady := make(chan struct{})
	f.backend.RequireCalls("BrowserPoll", 2)
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.BrowserPoll = func(ctx context.Context, p model.Principal, project, task, id, after string) (sp.Snapshot, []map[string]any, string, error) {
			if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
				return sp.Snapshot{}, nil, "", err
			}
			switch after {
			case "":
				return ready, nil, initialCursor, nil
			case initialCursor:
				select {
				case <-eventsReady:
					return ready, []map[string]any{event}, endCursor, nil
				default:
					return ready, nil, initialCursor, nil
				}
			case endCursor:
				return ready, nil, endCursor, nil
			default:
				return sp.Snapshot{}, nil, "", f.require(false, "BrowserPoll changed supplied opaque cursor")
			}
		}
	})
	browser := sessionDial(t, f.server.URL, path+"/channel", f.handler.token, nil)
	first := sessionWSKind(t, browser, "snapshot")
	if string(first["cursor"]) != `"`+initialCursor+`"` {
		t.Fatal("browser snapshot changed supplied cursor")
	}
	state := sp.State{NativeSessionID: &native, InitialInputState: "provider_accepted", Synchronized: true, Activity: "idle", Capabilities: ready.Capabilities}
	events := sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "state", Payload: json.RawMessage(jsonBody(t, state))}, {SourceSeq: "2", Kind: "timeline_upsert", Payload: json.RawMessage(jsonBody(t, entry))}, {SourceSeq: "3", Kind: "resource", Payload: json.RawMessage(jsonBody(t, descriptor))}}}
	expectedEventWire := []byte(jsonBody(t, events))
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Handle = func(ctx context.Context, message sp.ControllerMessage) (map[string]any, error) {
			if err := f.require(ctx != nil && message.Type == "events" && message.ControllerFence == snapshot.ControllerFence && message.SourceEpoch == epoch && bytes.Equal(message.Raw, expectedEventWire), "Handle changed complete decoded native source frame"); err != nil {
				return nil, err
			}
			return nativeFrame(snapshot.ControllerFence, map[string]any{"type": "events_ack", "protocol": sp.Protocol, "connectionEpoch": snapshot.ConnectionEpoch, "batchId": events.BatchID, "sourceEpoch": epoch, "lastAckedSourceSeq": "3", "lastEventSeq": "1"}), nil
		}
	})
	for range 2 {
		f.ControllerWrite(t, controller, events)
		ack := sessionWSKind(t, controller, "events_ack")
		if string(ack["batchId"]) != `"`+events.BatchID+`"` || string(ack["lastAckedSourceSeq"]) != `"3"` {
			t.Fatal("events acknowledgement changed supplied correlation")
		}
	}
	close(eventsReady)

	offers := make(chan map[string]any, 3)
	timelineReply, resourceReply := make(chan struct{}), make(chan struct{})
	timelineID, resourceRequestID := uuid.NewString(), uuid.NewString()
	timelineRequest := nativeFrame(snapshot.ControllerFence, map[string]any{"type": "content_request", "protocol": sp.Protocol, "connectionEpoch": snapshot.ConnectionEpoch, "requestId": timelineID, "kind": "timeline", "historyEpoch": snapshot.HistoryEpoch, "direction": "tail", "cursor": nil, "limit": 10})
	resourceRequest := nativeFrame(snapshot.ControllerFence, map[string]any{"type": "content_request", "protocol": sp.Protocol, "connectionEpoch": snapshot.ConnectionEpoch, "requestId": resourceRequestID, "kind": "resource", "resourceId": resourceID, "offset": "0", "limit": sp.MaxContentChunkBytes})
	f.backend.RequireCalls("Poll", 1)
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Poll = func(ctx context.Context, fence sp.ControllerFence) ([]map[string]any, error) {
			if err := f.require(ctx != nil && fence == snapshot.ControllerFence, "Poll changed content-request fence"); err != nil {
				return nil, err
			}
			select {
			case offer := <-offers:
				return []map[string]any{offer}, nil
			default:
				return []map[string]any{}, nil
			}
		}
		calls.Timeline = func(ctx context.Context, p model.Principal, project, task, id, direction, cursor string, limit int) (map[string]any, error) {
			if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
				return nil, err
			}
			if err := f.require(direction == "tail" && cursor == "" && limit == 10, "Timeline changed HTTP direction/cursor/limit"); err != nil {
				return nil, err
			}
			select {
			case offers <- timelineRequest:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			select {
			case <-timelineReply:
				return map[string]any{"sessionId": id, "historyEpoch": snapshot.HistoryEpoch, "items": []sp.TimelineEntry{entry}, "resources": []sp.Resource{descriptor}, "beforeCursor": nil, "afterCursor": nil, "hasMoreBefore": false, "hasMoreAfter": false, "lastEventSeq": "1"}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		calls.Resource = func(ctx context.Context, p model.Principal, project, task, id, requested string) ([]byte, sp.Resource, error) {
			if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
				return nil, sp.Resource{}, err
			}
			if err := f.require(requested == resourceID, "Resource changed requested canonical ID"); err != nil {
				return nil, sp.Resource{}, err
			}
			select {
			case offers <- resourceRequest:
			case <-ctx.Done():
				return nil, sp.Resource{}, ctx.Err()
			}
			select {
			case <-resourceReply:
				return content, descriptor, nil
			case <-ctx.Done():
				return nil, sp.Resource{}, ctx.Err()
			}
		}
		calls.Handle = func(ctx context.Context, message sp.ControllerMessage) (map[string]any, error) {
			if err := f.require(ctx != nil && message.Type == "content_response" && message.ControllerFence == snapshot.ControllerFence && message.SourceThrough == "3" && message.ContentResult != nil, "Handle changed decoded content response fence/barrier"); err != nil {
				return nil, err
			}
			switch message.RequestID {
			case timelineID:
				if err := f.require(message.ContentResult.Kind == "timeline" && message.ContentResult.HistoryEpoch == snapshot.HistoryEpoch && len(message.ContentResult.Items) == 1 && message.ContentResult.Items[0].EntryID == entryID, "timeline response lost given content/correlation"); err != nil {
					return nil, err
				}
				close(timelineReply)
			case resourceRequestID:
				if err := f.require(message.ContentResult.Kind == "resource" && message.ContentResult.Data == base64.StdEncoding.EncodeToString(content) && message.ContentResult.EOF, "resource response lost given bytes/correlation"); err != nil {
					return nil, err
				}
				close(resourceReply)
			default:
				return nil, f.require(false, "Handle changed content request ID")
			}
			return nil, nil
		}
	})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- projectRequest(f.handler, http.MethodGet, path+"/timeline?direction=tail&limit=10", "")
	}()
	request := sessionWSKind(t, controller, "content_request")
	if string(request["requestId"]) != `"`+timelineID+`"` || string(request["kind"]) != `"timeline"` {
		t.Fatal("timeline request frame lost correlation")
	}
	f.ControllerWrite(t, controller, sp.ControllerMessage{Type: "content_response", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, RequestID: timelineID, SourceThrough: "3", ContentResult: &sp.ContentResult{Kind: "timeline", HistoryEpoch: snapshot.HistoryEpoch, Items: []sp.TimelineEntry{entry}, Resources: []sp.Resource{descriptor}}})
	page := decodeResponse[struct {
		Items []json.RawMessage `json:"items"`
	}](t, <-done, http.StatusOK)
	if len(page.Items) != 1 {
		t.Fatal("local page missing")
	}
	go func() {
		done <- projectRequest(f.handler, http.MethodGet, path+"/resources/"+resourceID+"/content", "")
	}()
	request = sessionWSKind(t, controller, "content_request")
	if string(request["requestId"]) != `"`+resourceRequestID+`"` {
		t.Fatal("resource request frame lost correlation")
	}
	f.ControllerWrite(t, controller, sp.ControllerMessage{Type: "content_response", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, RequestID: resourceRequestID, SourceThrough: "3", ContentResult: &sp.ContentResult{Kind: "resource", Resource: &descriptor, Offset: "0", Data: base64.StdEncoding.EncodeToString(content), EOF: true}})
	download := <-done
	if download.Code != http.StatusOK || download.Body.String() != string(content) || download.Header().Get("X-Content-Type-Options") != "nosniff" || download.Header().Get("Content-Length") != strconv.Itoa(len(content)) {
		t.Fatalf("local resource %d %s", download.Code, download.Body)
	}

	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Timeline = func(ctx context.Context, p model.Principal, project, task, id, direction, cursor string, limit int) (map[string]any, error) {
			if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
				return nil, err
			}
			return nil, &model.Fault{Code: "controller_offline", Message: "Connect the original controller."}
		}
	})
	f.nextCall("Timeline")
	offline := projectRequest(f.handler, http.MethodGet, path+"/timeline?direction=tail&limit=10", "")
	assertProjectError(t, offline, http.StatusServiceUnavailable, "controller_offline")
	command := sp.Command{Fence: snapshot.Fence, Protocol: sp.Protocol, RequestID: "session-http", OperationID: uuid.NewString(), Kind: "send_message", Payload: json.RawMessage(`{"content":[{"type":"text","text":"Continue"}],"expectedTurnId":null}`)}
	accepted := sp.Operation{Fence: snapshot.Fence, Protocol: sp.Protocol, OperationID: command.OperationID, Kind: command.Kind, State: "accepted"}
	offered := nativeFrame(snapshot.ControllerFence, map[string]any{"type": "operation_offer", "protocol": sp.Protocol, "connectionEpoch": snapshot.ConnectionEpoch, "operationSeq": "1", "command": command})
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Submit = func(ctx context.Context, p model.Principal, project, task, id string, actual sp.Command) (sp.Operation, error) {
			if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
				return sp.Operation{}, err
			}
			if err := f.require(reflect.DeepEqual(actual, command), "Submit changed decoded command"); err != nil {
				return sp.Operation{}, err
			}
			select {
			case offers <- offered:
			case <-ctx.Done():
				return sp.Operation{}, ctx.Err()
			}
			return accepted, nil
		}
	})
	receipt := decodeResponse[struct {
		Operation sp.Operation `json:"operation"`
		URL       string       `json:"operationUrl"`
	}](t, projectRequest(f.handler, http.MethodPost, path+"/commands", jsonBody(t, command)), http.StatusAccepted)
	if !reflect.DeepEqual(receipt.Operation, accepted) || receipt.URL != path+"/operations/"+command.OperationID {
		t.Fatal("accepted operation envelope changed given result or URL")
	}
	offer := sessionWSKind(t, controller, "operation_offer")
	var nativeCommand sp.Command
	if json.Unmarshal(offer["command"], &nativeCommand) != nil || !reflect.DeepEqual(nativeCommand, command) {
		t.Fatal("operation offer changed supplied intent")
	}
	confirmed := accepted
	confirmed.State = "confirmed"
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Handle = func(ctx context.Context, message sp.ControllerMessage) (map[string]any, error) {
			if err := f.require(ctx != nil && message.ControllerFence == snapshot.ControllerFence, "Handle changed operation fence"); err != nil {
				return nil, err
			}
			switch message.Type {
			case "operation_begin":
				if err := f.require(message.OperationID == command.OperationID, "operation begin changed ID"); err != nil {
					return nil, err
				}
				return nativeFrame(snapshot.ControllerFence, map[string]any{"type": "operation_authorized", "protocol": sp.Protocol, "connectionEpoch": snapshot.ConnectionEpoch, "operationId": command.OperationID}), nil
			case "operation_receipt":
				if err := f.require(message.Operation != nil && reflect.DeepEqual(*message.Operation, confirmed), "receipt changed supplied native result"); err != nil {
					return nil, err
				}
				return nativeFrame(snapshot.ControllerFence, map[string]any{"type": "receipt_ack", "protocol": sp.Protocol, "connectionEpoch": snapshot.ConnectionEpoch, "operation": confirmed}), nil
			default:
				return nil, f.require(false, "Handle received another operation frame")
			}
		}
	})
	f.ControllerWrite(t, controller, sp.ControllerMessage{Type: "operation_begin", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, OperationID: command.OperationID})
	authorization := sessionWSKind(t, controller, "operation_authorized")
	if string(authorization["operationId"]) != `"`+command.OperationID+`"` {
		t.Fatal("operation authorization changed supplied ID")
	}
	f.ControllerWrite(t, controller, sp.ControllerMessage{Type: "operation_receipt", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, Operation: &confirmed})
	sessionWSKind(t, controller, "receipt_ack")
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Operation = func(ctx context.Context, p model.Principal, project, task, id, operation string) (sp.Operation, error) {
			if err := f.scopeArguments(ctx, p, project, task, id); err != nil {
				return sp.Operation{}, err
			}
			if err := f.require(operation == command.OperationID, "Operation changed canonical ID"); err != nil {
				return sp.Operation{}, err
			}
			return confirmed, nil
		}
	})
	got := decodeResponse[struct {
		Operation sp.Operation `json:"operation"`
	}](t, projectRequest(f.handler, http.MethodGet, receipt.URL, ""), http.StatusOK)
	if !reflect.DeepEqual(got.Operation, confirmed) {
		t.Fatal("operation GET changed supplied receipt")
	}
	reconnected := sessionDial(t, f.server.URL, path+"/channel?after="+initialCursor, f.handler.token, nil)
	sessionWSKind(t, reconnected, "snapshot")
	frame := sessionWSKind(t, reconnected, "event")
	if _, err := sp.DecodeEvent(frame["event"]); err != nil {
		t.Fatal(err)
	}
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Poll = func(ctx context.Context, fence sp.ControllerFence) ([]map[string]any, error) {
			if err := f.require(ctx != nil && fence == snapshot.ControllerFence, "Poll changed late refusal fence"); err != nil {
				return nil, err
			}
			return nil, &model.Fault{Code: "unauthenticated", Message: "Credential expired or was revoked."}
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		if _, _, err := controller.Read(ctx); err != nil {
			break
		}
	}
	if ctx.Err() != nil {
		t.Fatal("given authorization refusal did not close the controller promptly")
	}
}

func TestSessionShutdownRetainsDisconnectFailure(t *testing.T) {
	f := sessionHTTPSetup(t)
	_, snapshot := f.controller(t, uuid.NewString())
	failure := errors.New("injected disconnect failure")
	f.backend.Configure(func(calls *sessionhttp.ServiceCallsForTest) {
		calls.Disconnect = func(ctx context.Context, fence sp.ControllerFence) error {
			_, bounded := ctx.Deadline()
			if err := f.require(ctx.Err() == nil && bounded && fence == snapshot.ControllerFence, "Disconnect lost bounded cleanup context or fence"); err != nil {
				return err
			}
			return failure
		}
	})
	f.expectShutdownError = func(err error) bool { return shutdownDisconnectFailureMatches(err, failure) }
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for i := 0; i < 2; i++ {
		if err := f.application.Shutdown(ctx); !errors.Is(err, failure) {
			t.Fatalf("shutdown %d lost disconnect cause: %v", i, err)
		}
	}
	if f.backend.Called("Disconnect") != 1 {
		t.Fatal("repeated shutdown repeated the disconnected usecase")
	}
}
