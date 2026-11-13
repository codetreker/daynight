//go:build integration

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
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

func sessionImageHTTP(t *testing.T, f *fixture, method, path, contentType string, data []byte, headers map[string]string, status int) []byte {
	t.Helper()
	req, err := http.NewRequestWithContext(f.context, method, f.origin+path, bytes.NewReader(data))
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
	resp, err := f.client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	closeErr := resp.Body.Close()
	if readErr != nil || closeErr != nil {
		t.Fatalf("read image response: %v %v", readErr, closeErr)
	}
	if resp.StatusCode != status {
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

func sessionImageController(ctx context.Context, connection *websocket.Conn, fence sp.ControllerFence, spec sp.ImageUploadSpec, original []byte) error {
	validated := &sp.ValidatedImage{MediaType: spec.MediaType, ByteLength: spec.ByteLength, SHA256: spec.SHA256, Width: 3, Height: 2, FrameCount: 1}
	for _, expected := range []string{"prepare", "write", "complete"} {
		kind, data, err := connection.Read(ctx)
		if err != nil {
			return err
		}
		var request struct {
			Type, Action, RequestID string
			Body                    json.RawMessage
		}
		if kind != websocket.MessageText || json.Unmarshal(data, &request) != nil || request.Type != "image_request" || request.Action != expected {
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
		} else {
			var completion struct {
				UploadID   string `json:"uploadId"`
				SHA256     string `json:"sha256"`
				ByteLength string `json:"byteLength"`
			}
			if json.Unmarshal(request.Body, &completion) != nil || completion.UploadID != spec.UploadID || completion.SHA256 != spec.SHA256 || completion.ByteLength != spec.ByteLength {
				return fmt.Errorf("Controller completion differs: %s", request.Body)
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
		result, err := sp.MarshalWire(sp.LocalImagePreparation{UploadID: spec.UploadID, ImageID: spec.ImageID, Target: spec.Target, State: state, AcceptedOffset: offset, Validated: image})
		if err != nil {
			return err
		}
		response, err := json.Marshal(sp.ControllerMessage{Type: "image_response", Protocol: sp.Protocol, ControllerFence: fence, RequestID: request.RequestID, Action: expected, MediaResult: result})
		if err != nil {
			return err
		}
		if err := connection.Write(ctx, websocket.MessageText, response); err != nil {
			return err
		}
	}
	return nil
}

// sessionDirectImageFlow uses the public upload and archive routes against the
// assembled Server, its real decoder, and an isolated PostgreSQL instance.
func sessionDirectImageFlow(t *testing.T, f *fixture) {
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
	controller, _, err := websocket.Dial(dialContext, strings.Replace(f.origin, "http://", "ws://", 1)+"/api/v1/controller-channel", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + grant.Token}}})
	finishDial()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = controller.CloseNow() })
	epoch := uuid.NewString()
	sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ContentRevision: 2, ControllerFence: snapshot.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Provider: registration.Provider, SourceEpoch: epoch, LastAckedSourceSeq: "0"})
	welcome := sessionFlowRead(t, f, controller)
	sessionFlowKind(t, welcome, "welcome")
	connected, err := sp.DecodeSnapshot(welcome["session"])
	if err != nil {
		t.Fatal(err)
	}
	native := "integration-" + uuid.NewString()
	state := sp.State{NativeSessionID: &native, InitialInputState: connected.InitialInputState, Synchronized: true, Activity: "initializing"}
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
	var completed sp.ImageUploadReceipt
	controllerContext, cancelController := context.WithTimeout(f.context, 30*time.Second)
	defer cancelController()
	controllerResult := make(chan error, 1)
	go func() {
		controllerResult <- sessionImageController(controllerContext, controller, connected.ControllerFence, spec, original)
	}()
	f.client.Timeout = 30 * time.Second
	if err := json.Unmarshal(sessionImageHTTP(t, f, http.MethodPost, upload+"/complete", "application/json", imageWire(t, sp.ImageUploadComplete{SHA256: hash, ByteLength: size}), nil, http.StatusOK), &completed); err != nil {
		t.Fatal(err)
	}
	if err := <-controllerResult; err != nil {
		t.Fatalf("Controller image exchange: %v", err)
	}
	if completed.State != "complete" || completed.Resource == nil {
		t.Fatalf("upload not complete: %+v", completed)
	}
	resource := *completed.Resource
	resourcePath := base + "/resources/" + resource.ResourceID + "/content"
	if actual := sessionImageHTTP(t, f, http.MethodGet, resourcePath, "", nil, nil, http.StatusOK); !bytes.Equal(actual, original) {
		t.Fatal("uploaded resource bytes differ")
	}

	content := imageWire(t, []map[string]string{{"type": "resource", "resourceId": resource.ResourceID, "label": "original.png"}})
	entry := sp.TimelineEntry{EntryID: uuid.NewString(), Revision: "1", Kind: "assistant_message", Data: map[string]json.RawMessage{"content": content}}
	sessionFlowWrite(t, f, controller, sp.ControllerMessage{Type: "events", Protocol: sp.Protocol, ControllerFence: connected.ControllerFence, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "timeline_upsert", Payload: imageWire(t, entry)}}})
	sessionFlowKind(t, sessionFlowRead(t, f, controller), "events_ack")
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
