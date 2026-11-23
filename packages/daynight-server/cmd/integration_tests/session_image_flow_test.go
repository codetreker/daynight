//go:build integration

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

type imageControllerRun struct {
	ctx    context.Context
	cancel context.CancelFunc
	result chan error
	done   chan struct{}
}

func (run *imageControllerRun) check(t *testing.T) {
	t.Helper()
	if run == nil || run.result == nil {
		return
	}
	select {
	case err := <-run.result:
		run.result = nil
		if err != nil {
			t.Fatalf("Controller image exchange: %v", err)
		}
	default:
	}
}

func sessionImageHTTP(t *testing.T, f *fixture, method, path, contentType string, data []byte, headers map[string]string, status int, runs ...*imageControllerRun) []byte {
	t.Helper()
	ctx := f.context
	var run *imageControllerRun
	if len(runs) != 0 {
		run = runs[0]
		ctx = run.ctx
	}
	req, err := http.NewRequestWithContext(ctx, method, f.origin+path, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	req.Header.Set("Daynight-Session-Content-Revision", "2")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	client := f.client
	if headers["Authorization"] != "" {
		// Active history uses the original Controller grant, not the browser PAT.
		selected := *client
		workerTransport := client.Transport.(sessionWorkerTransport)
		workerTransport.next = workerTransport.next.(tokenTransport).next
		selected.Transport = workerTransport
		client = &selected
	}
	resp, err := client.Do(req)
	if err != nil {
		run.check(t)
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	closeErr := resp.Body.Close()
	if readErr != nil || closeErr != nil {
		run.check(t)
		t.Fatalf("read image response: %v %v", readErr, closeErr)
	}
	if resp.StatusCode != status {
		run.check(t)
		t.Fatalf("%s %s: got %d want %d: %s\n%s", method, path, resp.StatusCode, status, body, f.process.logs.String())
	}
	return body
}

func imageWire(t *testing.T, v any) []byte {
	t.Helper()
	b, err := sp.MarshalWire(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func imageDigest(b []byte) string { digest := sha256.Sum256(b); return hex.EncodeToString(digest[:]) }

type handledImageRequest struct {
	request  sp.ImageMediaMessage
	response []byte
}

type imageControllerHistory map[string]handledImageRequest

func (seen imageControllerHistory) replay(ctx context.Context, connection *websocket.Conn, data []byte, fence sp.ControllerFence) error {
	request, err := sp.DecodeImageMedia(data)
	if err != nil || request.Type != "image_request" || request.Protocol != sp.Protocol || request.ControllerFence != fence {
		return fmt.Errorf("invalid Controller retransmission: %s", data)
	}
	previous, ok := seen[request.RequestID]
	if !ok || request.Action != previous.request.Action || request.ControllerFence != previous.request.ControllerFence || !bytes.Equal(request.Body, previous.request.Body) {
		return fmt.Errorf("Controller request identity changed or unexpected: %s", data)
	}
	return connection.Write(ctx, websocket.MessageText, previous.response)
}

func sessionImageController(ctx context.Context, connection *websocket.Conn, fence sp.ControllerFence, spec sp.ImageUploadSpec, original []byte, seen imageControllerHistory, release bool) error {
	validated := &sp.ValidatedImage{MediaType: spec.MediaType, ByteLength: spec.ByteLength, SHA256: spec.SHA256, Width: 3, Height: 2, FrameCount: 1}
	expectedActions := []string{"prepare", "write", "complete", "release"}
	if !release {
		expectedActions = expectedActions[:3]
	}
	for stage := 0; stage < len(expectedActions); {
		expected := expectedActions[stage]
		kind, data, err := connection.Read(ctx)
		if err != nil {
			return err
		}
		request, decodeErr := sp.DecodeImageMedia(data)
		if kind != websocket.MessageText || decodeErr != nil || request.Type != "image_request" || request.Protocol != sp.Protocol || request.ControllerFence != fence {
			return fmt.Errorf("unexpected Controller request for %s: %s", expected, data)
		}
		if _, ok := seen[request.RequestID]; ok {
			if err := seen.replay(ctx, connection, data, fence); err != nil {
				return err
			}
			continue
		}
		identityAction := expected
		if expected == "write" {
			identityAction = "write/0"
		}
		if request.Action != expected || request.RequestID != uuid.NewSHA1(uuid.MustParse(spec.UploadID), []byte(identityAction)).String() {
			return fmt.Errorf("unexpected Controller request for %s: %s", expected, data)
		}
		if expected == "prepare" {
			var received sp.ImageUploadSpec
			if json.Unmarshal(request.Body, &received) != nil || !reflect.DeepEqual(received, spec) {
				return fmt.Errorf("Controller preparation identity differs: %s", request.Body)
			}
		} else if expected == "write" {
			var chunk sp.ImageChunkWrite
			if json.Unmarshal(request.Body, &chunk) != nil || chunk.UploadID != spec.UploadID || chunk.Offset != "0" || chunk.SHA256 != spec.SHA256 || chunk.Data != base64.StdEncoding.EncodeToString(original) {
				return fmt.Errorf("Controller chunk differs: %s", request.Body)
			}
		} else if expected == "complete" {
			var completion struct {
				UploadID   string `json:"uploadId"`
				SHA256     string `json:"sha256"`
				ByteLength string `json:"byteLength"`
			}
			if json.Unmarshal(request.Body, &completion) != nil || completion.UploadID != spec.UploadID || completion.SHA256 != spec.SHA256 || completion.ByteLength != spec.ByteLength {
				return fmt.Errorf("Controller completion differs: %s", request.Body)
			}
		} else {
			var release struct {
				UploadID string              `json:"uploadId"`
				Spec     *sp.ImageUploadSpec `json:"spec"`
			}
			if json.Unmarshal(request.Body, &release) != nil || release.UploadID != spec.UploadID || (release.Spec != nil && !reflect.DeepEqual(*release.Spec, spec)) {
				return fmt.Errorf("Controller release identity differs: %s", request.Body)
			}
		}
		state, offset := "receiving", "0"
		var image *sp.ValidatedImage
		if expected == "write" {
			offset = spec.ByteLength
		}
		if expected == "complete" {
			state, offset, image = "validated", spec.ByteLength, validated
		}
		if expected == "release" {
			state = "released"
		}
		result, err := sp.MarshalWire(sp.LocalImagePreparation{UploadID: spec.UploadID, ImageID: spec.ImageID, Target: spec.Target, State: state, AcceptedOffset: offset, Validated: image})
		if err != nil {
			return err
		}
		response, err := json.Marshal(sp.ControllerMessage{Type: "image_response", Protocol: sp.Protocol, ControllerFence: fence, RequestID: request.RequestID, Action: expected, MediaResult: result})
		if err != nil {
			return err
		}
		seen[request.RequestID] = handledImageRequest{request: request, response: response}
		if err := connection.Write(ctx, websocket.MessageText, response); err != nil {
			return err
		}
		stage++
	}
	return nil
}

func sessionImageRead(t *testing.T, ctx context.Context, controller *websocket.Conn, fence sp.ControllerFence, seen imageControllerHistory, allowCapture bool) map[string]json.RawMessage {
	t.Helper()
	for {
		kind, data, err := controller.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var frame map[string]json.RawMessage
		if kind != websocket.MessageText || json.Unmarshal(data, &frame) != nil {
			t.Fatalf("invalid Controller frame: %s", data)
		}
		var typ, action string
		_ = json.Unmarshal(frame["type"], &typ)
		_ = json.Unmarshal(frame["action"], &action)
		var requestID string
		_ = json.Unmarshal(frame["requestId"], &requestID)
		_, alreadySeen := seen[requestID]
		if typ != "image_request" || (allowCapture && action == "read_capture" && !alreadySeen) {
			return frame
		}
		if err := seen.replay(ctx, controller, data, fence); err != nil {
			t.Fatal(err)
		}
	}
}

func sessionCapturedOriginal(t *testing.T, f *fixture, controller *websocket.Conn, fence sp.ControllerFence, capture sp.ImageCaptureRequest, validated sp.ValidatedImage, original []byte, seen imageControllerHistory) sp.Resource {
	t.Helper()
	ctx, cancel := context.WithTimeout(f.context, 15*time.Second)
	defer cancel()
	for {
		fields := sessionImageRead(t, ctx, controller, fence, seen, true)
		raw, err := json.Marshal(fields)
		if err != nil {
			t.Fatal(err)
		}
		var frame struct {
			Type, Action, RequestID string
			Body                    json.RawMessage
			Result                  sp.ImageCaptureReceipt
			Error                   *sp.ImageError
		}
		if json.Unmarshal(raw, &frame) != nil {
			t.Fatalf("invalid capture frame: %s", raw)
		}
		if frame.Type == "image_request" && frame.Action == "read_capture" {
			var request struct {
				CaptureID, AttemptID, SHA256, ByteLength, Offset string
				Limit                                            int
			}
			if json.Unmarshal(frame.Body, &request) != nil || request.CaptureID != capture.CaptureID || request.AttemptID != capture.AttemptID || request.SHA256 != validated.SHA256 || request.ByteLength != validated.ByteLength || request.Offset != "0" || request.Limit < len(original) {
				t.Fatalf("capture source identity differs: %s", frame.Body)
			}
			chunk := sp.PreparedImageChunk{PreparationID: capture.AttemptID, Offset: "0", ByteLength: validated.ByteLength, SHA256: validated.SHA256, Data: base64.StdEncoding.EncodeToString(original), EOF: true}
			sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "image_response", Protocol: sp.Protocol, ControllerFence: fence, RequestID: frame.RequestID, Action: frame.Action, MediaResult: imageWire(t, chunk)})
			continue
		}
		if frame.Type != "image_capture_result" || frame.Error != nil || frame.Result.CaptureID != capture.CaptureID || frame.Result.AttemptID != capture.AttemptID {
			t.Fatalf("capture failed: %s", raw)
		}
		if frame.Result.State == "committed" && frame.Result.Resource != nil {
			return *frame.Result.Resource
		}
		if frame.Result.State != "copying" {
			t.Fatalf("unexpected capture state: %s", raw)
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(100 * time.Millisecond):
		}
		sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "image_capture", Protocol: sp.Protocol, ControllerFence: fence, RequestID: uuid.NewString(), Action: "query", MediaBody: imageWire(t, map[string]string{"captureId": capture.CaptureID})})
	}
}

// sessionDirectImageFlow uses the public upload, capture and archive routes against the
// assembled Server, its real decoder, and an isolated PostgreSQL instance.
func sessionDirectImageFlow(t *testing.T, f *fixture, relay bool) {
	t.Helper()
	registration := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	snapshot := requestJSON[struct {
		Session sp.Snapshot `json:"session"`
	}](t, f, http.MethodPost, "/api/v1/test-sessions", registration, http.StatusOK).Session
	base := "/api/v1/test-sessions/" + snapshot.SessionID
	grant := requestJSON[struct {
		Token string `json:"token"`
	}](t, f, http.MethodPost, base+"/controller-grant", sp.Grant{Protocol: sp.Protocol, TestExecutionID: registration.TestExecutionID, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, ExecutionGeneration: snapshot.ExecutionGeneration, Kind: "bootstrap"}, http.StatusOK)
	dialContext, finishDial := context.WithTimeout(f.context, 5*time.Second)
	headers := http.Header{"Authorization": {"Bearer " + grant.Token}}
	if relay {
		headers.Set("Daynight-Online-Relay-Version", "1")
	}
	controller, response, err := websocket.Dial(dialContext, strings.Replace(f.origin, "http://", "ws://", 1)+"/api/v1/controller-channel", &websocket.DialOptions{HTTPHeader: headers})
	finishDial()
	if err != nil {
		t.Fatal(err)
	}
	if relay && response.Header.Get("Daynight-Online-Relay-Version") != "1" {
		t.Fatalf("relay capability was not advertised: %v", response.Header)
	}
	t.Cleanup(func() { _ = controller.CloseNow() })
	epoch := uuid.NewString()
	sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ContentRevision: 2, ControllerFence: snapshot.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Provider: registration.Provider, SourceEpoch: epoch, LastAckedSourceSeq: "0"})
	welcome := sessionFlowRead(t, f, controller)
	sessionFlowKind(t, welcome, "welcome")
	if relay {
		var mode, policy string
		if json.Unmarshal(welcome["onlineMode"], &mode) != nil || json.Unmarshal(welcome["historyContentPolicy"], &policy) != nil || mode != "relay" || policy != "legacy" {
			t.Fatalf("relay negotiation differs: %s %s", welcome["onlineMode"], welcome["historyContentPolicy"])
		}
	} else if _, ok := welcome["onlineMode"]; ok {
		t.Fatalf("legacy welcome disclosed relay mode: %s", welcome["onlineMode"])
	}
	connected, err := sp.DecodeSnapshot(welcome["session"])
	if err != nil {
		t.Fatal(err)
	}
	native := "integration-" + uuid.NewString()
	state := sp.State{NativeSessionID: &native, InitialInputState: connected.InitialInputState, Synchronized: true, Activity: "initializing"}
	if relay {
		modelID := "fixture-model"
		state.Activity = "idle"
		state.Capabilities.Send = true
		state.ProviderImages = &sp.ProviderImageCapabilities{Revision: "1", ExpectedNativeSessionID: &native, ModelID: &modelID, Send: "supported", Steer: "unsupported", InputMediaTypes: []string{"image/png"}, MaxImageBytes: "1048576", MaxMessageImageBytes: "1048576", MaxImagesPerMessage: 1, Geometry: sp.ImageGeometry{Version: 1, Known: true, MaxWidth: 100, MaxHeight: 100, MaxPixels: 10000, MaxFrames: 1}}
	}
	sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: connected.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}})
	sessionFlowKind(t, sessionFlowRead(t, f, controller), "sync_ack")

	original, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWMwnpn2H4YZkDkApHUNJ5ov+z4AAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	hash, size := imageDigest(original), strconv.Itoa(len(original))
	spec := sp.ImageUploadSpec{UploadID: uuid.NewString(), ImageID: uuid.NewString(), Target: sp.ImageTarget{ServerOrigin: f.origin, ActorUserID: f.userID, Fence: snapshot.Fence, ExpectedNativeSessionID: &native}, Name: "original.png", MediaType: "image/png", ByteLength: size, SHA256: hash}
	upload := base + "/image-uploads/" + spec.UploadID
	first := imageWire(t, map[string]any{"spec": spec, "offset": "0", "sha256": hash, "data": base64.StdEncoding.EncodeToString(original)})
	var accepted sp.ImageUploadReceipt
	if err := json.Unmarshal(sessionImageHTTP(t, f, http.MethodPut, upload+"/content", "application/json", first, nil, http.StatusCreated), &accepted); err != nil {
		t.Fatal(err)
	}
	if accepted.State != "receiving" || accepted.AcceptedOffset != size || accepted.UploadID != spec.UploadID {
		t.Fatalf("first chunk receipt: %+v", accepted)
	}
	var replay sp.ImageUploadReceipt
	if err := json.Unmarshal(sessionImageHTTP(t, f, http.MethodPut, upload+"/content", "application/json", first, nil, http.StatusOK), &replay); err != nil {
		t.Fatal(err)
	}
	if replay.AcceptedOffset != size || replay.UploadID != spec.UploadID {
		t.Fatalf("first chunk replay: %+v", replay)
	}
	controllerContext, cancelController := context.WithTimeout(f.context, 30*time.Second)
	run := &imageControllerRun{ctx: controllerContext, cancel: cancelController, result: make(chan error, 1), done: make(chan struct{})}
	seen := make(imageControllerHistory)
	go func() {
		defer close(run.done)
		err := sessionImageController(controllerContext, controller, connected.ControllerFence, spec, original, seen, !relay)
		run.result <- err
		if err != nil {
			cancelController()
		}
	}()
	defer func() {
		if run.result != nil {
			select {
			case err := <-run.result:
				if err != nil {
					t.Errorf("Controller image exchange: %v", err)
				}
			default:
				run.cancel()
				if err := <-run.result; err != nil && !errors.Is(err, context.Canceled) {
					t.Errorf("Controller image exchange: %v", err)
				}
			}
		}
		run.cancel()
		<-run.done
	}()
	f.client.Timeout = 30 * time.Second
	var refusal struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	var completed sp.ImageUploadReceipt
	if relay {
		if err := json.Unmarshal(sessionImageHTTP(t, f, http.MethodPost, upload+"/complete", "application/json", imageWire(t, sp.ImageUploadComplete{SHA256: hash, ByteLength: size}), nil, http.StatusOK, run), &completed); err != nil {
			t.Fatal(err)
		}
		if completed.State != "complete" || completed.Resource == nil || completed.UploadID != spec.UploadID {
			t.Fatalf("completed upload differs: %+v", completed)
		}
	} else {
		if err := json.Unmarshal(sessionImageHTTP(t, f, http.MethodPost, upload+"/complete", "application/json", imageWire(t, sp.ImageUploadComplete{SHA256: hash, ByteLength: size}), nil, http.StatusConflict, run), &refusal); err != nil {
			t.Fatal(err)
		}
		if refusal.Error.Code != "component_unsupported" {
			t.Fatalf("unqualified input was not refused: %+v", refusal)
		}
		if err := json.Unmarshal(sessionImageHTTP(t, f, http.MethodDelete, upload, "", nil, nil, http.StatusOK, run), &completed); err != nil {
			t.Fatal(err)
		}
	}
	controllerErr := <-run.result
	run.result = nil
	if err := controllerErr; err != nil {
		t.Fatalf("Controller image exchange: %v", err)
	}
	var observed sp.ImageUploadReceipt
	if err := json.Unmarshal(sessionImageHTTP(t, f, http.MethodGet, upload, "", nil, nil, http.StatusOK), &observed); err != nil {
		t.Fatal(err)
	}
	if observed.State != completed.State || observed.UploadID != spec.UploadID {
		t.Fatalf("upload readback differs: %+v", observed)
	}
	if relay {
		var discovery struct {
			Capabilities sp.ImageCapabilities `json:"capabilities"`
		}
		if err := json.Unmarshal(sessionImageHTTP(t, f, http.MethodGet, base+"/image-capabilities", "", nil, nil, http.StatusOK), &discovery); err != nil {
			t.Fatal(err)
		}
		if discovery.Capabilities.Send != "supported" {
			t.Fatalf("image input was not qualified: %+v", discovery.Capabilities)
		}
		input := sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: "Inspect this image."}, {Type: "image", ImageID: spec.ImageID, UploadID: spec.UploadID, ResourceID: completed.Resource.ResourceID, SHA256: hash, ByteLength: size}}, Target: &spec.Target, DraftID: uuid.NewString(), DraftRevision: "1", ExpectedImageCapabilityRevision: discovery.Capabilities.Revision}
		command := sp.Command{Fence: snapshot.Fence, ContentRevision: 2, Protocol: sp.Protocol, RequestID: "image-send", OperationID: uuid.NewString(), Kind: "send_message", Payload: imageWire(t, input)}
		var acceptedOperation struct {
			Operation sp.Operation `json:"operation"`
		}
		if err := json.Unmarshal(sessionImageHTTP(t, f, http.MethodPost, base+"/commands", "application/json", imageWire(t, command), nil, http.StatusAccepted), &acceptedOperation); err != nil {
			t.Fatal(err)
		}
		if acceptedOperation.Operation.OperationID != command.OperationID || acceptedOperation.Operation.State != "accepted" {
			t.Fatalf("image command acceptance differs: %+v", acceptedOperation.Operation)
		}
		offer := sessionFlowRead(t, f, controller)
		sessionFlowKind(t, offer, "operation_offer")
		var offered sp.Command
		if err := json.Unmarshal(offer["command"], &offered); err != nil || offered.OperationID != command.OperationID || !bytes.Equal(offered.Payload, command.Payload) {
			t.Fatalf("image command offer differs: %s (%v)", offer["command"], err)
		}
		sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "operation_begin", Protocol: sp.Protocol, ControllerFence: connected.ControllerFence, OperationID: command.OperationID})
		authorized := sessionFlowRead(t, f, controller)
		sessionFlowKind(t, authorized, "operation_authorized")
		var authorization sp.ImageCapabilities
		if err := json.Unmarshal(authorized["imageAuthorization"], &authorization); err != nil || authorization.Revision != discovery.Capabilities.Revision {
			t.Fatalf("image dispatch authorization differs: %s (%v)", authorized["imageAuthorization"], err)
		}
		receipt := acceptedOperation.Operation
		receipt.State = "confirmed"
		sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "operation_receipt", Protocol: sp.Protocol, ControllerFence: connected.ControllerFence, Operation: &receipt})
		sessionFlowKind(t, sessionFlowRead(t, f, controller), "receipt_ack")
		var readback struct {
			Operation sp.Operation `json:"operation"`
		}
		if err := json.Unmarshal(sessionImageHTTP(t, f, http.MethodGet, base+"/operations/"+command.OperationID, "", nil, nil, http.StatusOK), &readback); err != nil || readback.Operation.OperationID != command.OperationID || readback.Operation.State != "confirmed" {
			t.Fatalf("image command receipt differs: %+v (%v)", readback.Operation, err)
		}
	}
	// Display capture remains available while native input profiles are closed.
	imageID := uuid.NewString()
	entry := sp.TimelineEntry{EntryID: uuid.NewString(), EntrySeq: "1", Revision: "1", Kind: "assistant_message", Data: map[string]json.RawMessage{"content": imageWire(t, []map[string]any{{"type": "image_unavailable", "imageId": imageID, "label": "original.png", "error": sp.ImageError{Code: "source_unavailable", Message: "Original is being saved."}}})}}
	entry.Data["imageProjectionError"] = json.RawMessage(`null`)
	if _, err := sp.DecodeSourceTimeline(imageWire(t, entry)); err != nil {
		t.Fatalf("capture source projection is invalid: %v", err)
	}
	sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: connected.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "timeline_upsert", Payload: imageWire(t, entry)}}})
	imageReadContext, finishImageRead := context.WithTimeout(f.context, 5*time.Second)
	sessionFlowKind(t, sessionImageRead(t, imageReadContext, controller, connected.ControllerFence, seen, false), "events_ack")
	finishImageRead()
	if !relay {
		checkpoint := imageWire(t, sp.ArchiveHistoryContent{HistoryEpoch: connected.HistoryEpoch, SourceThrough: "1", Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{}})
		checkpointDigest := imageDigest(checkpoint)
		sessionImageHTTP(t, f, http.MethodPut, base+"/image-history-ledger/"+uuid.NewString()+"?offset=0", "application/octet-stream", checkpoint, map[string]string{"Authorization": "Bearer " + grant.Token, "Daynight-Controller-Fence": string(imageWire(t, connected.ControllerFence)), "Daynight-File-Byte-Length": strconv.Itoa(len(checkpoint)), "Daynight-File-SHA256": checkpointDigest, "Daynight-Chunk-SHA256": checkpointDigest}, http.StatusOK)
	}
	capture := sp.ImageCaptureRequest{CaptureID: uuid.NewString(), AttemptID: uuid.NewString(), Occurrence: sp.ImageOccurrence{ImageID: imageID, EntryID: entry.EntryID, Container: "content", SourceKey: "original"}, Locator: sp.ImageLocator{Kind: "external", URL: "https://images.example/original.png"}}
	validated := sp.ValidatedImage{MediaType: spec.MediaType, ByteLength: size, SHA256: hash, Width: 3, Height: 2, FrameCount: 1}
	submission := sp.DirectCaptureSubmission{Request: capture, AttemptID: capture.AttemptID, Outcome: sp.DirectCaptureOutcome{Kind: "validated", Validated: &validated}}
	if relay {
		submission.SourceEpoch, submission.SourceSeq = epoch, "1"
	}
	sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "image_capture", Protocol: sp.Protocol, ControllerFence: connected.ControllerFence, RequestID: uuid.NewString(), Action: "submit", MediaBody: imageWire(t, submission)})
	resource := sessionCapturedOriginal(t, f, controller, connected.ControllerFence, capture, validated, original, seen)
	resourcePath := base + "/resources/" + resource.ResourceID + "/content"
	if actual := sessionImageHTTP(t, f, http.MethodGet, resourcePath, "", nil, nil, http.StatusOK); !bytes.Equal(actual, original) {
		t.Fatal("captured resource bytes differ")
	}
	if relay {
		if err := controller.Close(websocket.StatusNormalClosure, "reconnect"); err != nil {
			t.Fatal(err)
		}
		reconnect := requestJSON[struct {
			Token string `json:"token"`
		}](t, f, http.MethodPost, base+"/controller-grant", sp.Grant{Protocol: sp.Protocol, TestExecutionID: registration.TestExecutionID, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, ExecutionGeneration: snapshot.ExecutionGeneration, Kind: "reconnect"}, http.StatusOK)
		headers.Set("Authorization", "Bearer "+reconnect.Token)
		dialContext, finishDial := context.WithTimeout(f.context, 5*time.Second)
		controller, response, err = websocket.Dial(dialContext, strings.Replace(f.origin, "http://", "ws://", 1)+"/api/v1/controller-channel", &websocket.DialOptions{HTTPHeader: headers})
		finishDial()
		if err != nil || response.Header.Get("Daynight-Online-Relay-Version") != "1" {
			t.Fatalf("relay reconnect failed: %v", err)
		}
		sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ContentRevision: 2, ControllerFence: connected.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Provider: registration.Provider, SourceEpoch: epoch, LastAckedSourceSeq: "1"})
		welcome = sessionFlowRead(t, f, controller)
		sessionFlowKind(t, welcome, "welcome")
		var mode, policy string
		if json.Unmarshal(welcome["onlineMode"], &mode) != nil || json.Unmarshal(welcome["historyContentPolicy"], &policy) != nil || mode != "relay" || policy != "legacy" {
			t.Fatalf("relay reconnect changed the bound decision: %s %s", welcome["onlineMode"], welcome["historyContentPolicy"])
		}
		connected, err = sp.DecodeSnapshot(welcome["session"])
		if err != nil {
			t.Fatal(err)
		}
		sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: connected.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}})
		sessionFlowKind(t, sessionFlowRead(t, f, controller), "sync_ack")
		// Reconciliation returns the committed capture under its original identity.
		submission.SourceEpoch, submission.SourceSeq = "", ""
		sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "image_capture", Protocol: sp.Protocol, ControllerFence: connected.ControllerFence, RequestID: uuid.NewString(), Action: "submit", MediaBody: imageWire(t, submission)})
		seen = make(imageControllerHistory)
		replayed := sessionCapturedOriginal(t, f, controller, connected.ControllerFence, capture, validated, original, seen)
		if replayed.ResourceID != resource.ResourceID {
			t.Fatalf("capture replay changed the original resource: %+v", replayed)
		}
	}

	content := imageWire(t, []map[string]string{{"type": "resource", "resourceId": resource.ResourceID, "label": "original.png"}})
	entry.Revision, entry.Data["content"] = "2", content
	sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: connected.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "2", Kind: "timeline_upsert", Payload: imageWire(t, entry)}}})
	imageReadContext, finishImageRead = context.WithTimeout(f.context, 5*time.Second)
	sessionFlowKind(t, sessionImageRead(t, imageReadContext, controller, connected.ControllerFence, seen, false), "events_ack")
	finishImageRead()
	if err := controller.Close(websocket.StatusNormalClosure, "integration controller stopped"); err != nil {
		t.Fatal(err)
	}
	stop := sp.TestStop{Fence: snapshot.Fence, Protocol: sp.Protocol, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, StopProof: sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	requestJSON[map[string]any](t, f, http.MethodPost, base+"/stop", stop, http.StatusOK)
	archive := base + "/archive"
	prepared := requestJSON[sp.ArchivePrepareReceipt](t, f, http.MethodPost, archive+"/prepare", sp.ArchivePrepareRequest{Fence: snapshot.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID}, http.StatusOK)
	entry.EntrySeq = "1"
	history := imageWire(t, sp.ArchiveHistoryContent{HistoryEpoch: prepared.HistoryEpoch, SourceThrough: prepared.SourceThrough, Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{resource}})
	putFile := func(path string, body []byte) {
		digest := imageDigest(body)
		sessionImageHTTP(t, f, http.MethodPut, path+"?offset=0", "application/octet-stream", body, map[string]string{"Daynight-File-Byte-Length": strconv.Itoa(len(body)), "Daynight-File-SHA256": digest, "Daynight-Chunk-SHA256": digest}, http.StatusOK)
	}
	putFile(archive+"/prepare/history/"+uuid.NewString(), history)
	sealed := requestJSON[sp.ArchivePrepareReceipt](t, f, http.MethodPost, archive+"/seal", nil, http.StatusOK)
	if sealed.Phase != "sealed" || len(sealed.Resources) != 1 || sealed.Resources[0].Resource.ResourceID != resource.ResourceID {
		t.Fatalf("archive resource closure: %+v", sealed)
	}
	timeline := imageWire(t, sp.ArchiveTimeline{Entries: []sp.TimelineEntry{entry}})
	fileID := uuid.NewString()
	putFile(archive+"/files/"+fileID, timeline)
	manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: snapshot.SessionID, Fence: snapshot.Fence, Provider: registration.Provider, NativeSessionID: &native, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Timeline: sp.ArchiveFileReference{FileID: fileID, SHA256: imageDigest(timeline), ByteLength: strconv.Itoa(len(timeline))}, Resources: sealed.Resources, Completeness: "complete"}
	sessionImageHTTP(t, f, http.MethodPut, archive+"/content", "application/json", imageWire(t, manifest), nil, http.StatusOK)
	var stored sp.ArchiveManifest
	if err := json.Unmarshal(sessionImageHTTP(t, f, http.MethodGet, archive+"/content", "", nil, nil, http.StatusOK), &stored); err != nil {
		t.Fatal(err)
	}
	if len(stored.Resources) != 1 || stored.Resources[0].Resource.ResourceID != resource.ResourceID || stored.Timeline.FileID != fileID {
		t.Fatalf("archive manifest differs: %+v", stored)
	}
	if actual := sessionImageHTTP(t, f, http.MethodGet, resourcePath, "", nil, nil, http.StatusOK); !bytes.Equal(actual, original) {
		t.Fatal("archived resource bytes differ")
	}
}
