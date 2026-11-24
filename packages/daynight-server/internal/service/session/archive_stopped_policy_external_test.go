package session_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
)

func TestStoppedTaskBodyArchiveHTTP(t *testing.T) {
	db := newArchiveStore(t)
	for _, scenario := range []string{"wrong-policy", "missing-body-capture", "shared-tool-image", "capacity", "matching-read-lease", "other-read-lease"} {
		if !t.Run(scenario, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			db, owner, project, task, reg := archiveFixtureWithStore(t, db)
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if e := files.Close(); e != nil {
					t.Error(e)
				}
			})
			engine := core.NewEngine(files)
			t.Cleanup(func() {
				if e := engine.Stop(context.Background()); e != nil {
					t.Error(e)
				}
			})
			service := sessionservice.New(db, engine)
			snapshot, err := service.Register(ctx, owner, project, task, reg)
			if err != nil {
				t.Fatal(err)
			}
			grant, err := service.Grant(ctx, owner, project, task, snapshot.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: reg.ClaimID, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, ExecutionGeneration: snapshot.ExecutionGeneration, Kind: "bootstrap"})
			if err != nil {
				t.Fatal(err)
			}
			epoch := uuid.NewString()
			connection, err := service.ConnectWithOnlineMode(ctx, grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, Provider: reg.Provider, SourceEpoch: epoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString(), 0, false, true)
			if err != nil {
				t.Fatal(err)
			}
			if connection.OnlineMode != "legacy" || connection.HistoryContentPolicy == nil || *connection.HistoryContentPolicy != "task_body" {
				t.Fatalf("connection policy: %+v", connection)
			}
			if err = service.Disconnect(ctx, connection.Snapshot.ControllerFence); err != nil {
				t.Fatal(err)
			}
			var version int64
			if err = db.Pool.QueryRow(ctx, `SELECT version FROM tasks WHERE id=$1`, task).Scan(&version); err != nil {
				t.Fatal(err)
			}
			stopped, err := taskservice.NewTasks(db).ReleaseWorker(ctx, owner, project, task, taskcore.ReleaseWorker{Version: version, ClaimID: reg.ClaimID, StoppedConfirmed: true})
			if err != nil || stopped.Status != model.TaskTodo {
				t.Fatalf("stop release: %+v %v", stopped, err)
			}
			var bundles int
			if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM session_archive_bundles WHERE session_id=$1`, snapshot.SessionID).Scan(&bundles); err != nil || bundles != 0 {
				t.Fatalf("unexpected active bundle: %d %v", bundles, err)
			}
			var logs bytes.Buffer
			logger := slog.New(slog.NewTextHandler(&logs, nil))
			auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
				if kind != model.PATCredential || token != "test-token" {
					return model.Principal{}, authhttp.Failure()
				}
				return owner, nil
			}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example.com"}, logger)
			if err != nil {
				t.Fatal(err)
			}
			mux := http.NewServeMux()
			sessionhttp.NewRoutes(service, &authhttp.Authentication{RequestAuthentication: auth}, logger).RegisterRoutes(mux)
			server := httptest.NewServer(mux)
			t.Cleanup(server.Close)
			base := "/api/v1/projects/" + project + "/tasks/" + task + "/sessions/" + snapshot.SessionID
			wire := func(v any) []byte {
				t.Helper()
				b, e := json.Marshal(v)
				if e != nil {
					t.Fatal(e)
				}
				return b
			}
			digest := func(b []byte) string { d := sha256.Sum256(b); return hex.EncodeToString(d[:]) }
			request := func(method, path, contentType string, body []byte, headers map[string]string, status int) []byte {
				t.Helper()
				req, e := http.NewRequestWithContext(ctx, method, server.URL+path, bytes.NewReader(body))
				if e != nil {
					t.Fatal(e)
				}
				req.Header.Set("Authorization", "Bearer test-token")
				if contentType != "" {
					req.Header.Set("Content-Type", contentType)
				}
				for k, v := range headers {
					req.Header.Set(k, v)
				}
				response, e := server.Client().Do(req)
				if e != nil {
					t.Fatal(e)
				}
				data, e := io.ReadAll(response.Body)
				closeErr := response.Body.Close()
				if e != nil || closeErr != nil || response.StatusCode != status {
					t.Fatalf("%s %s: got=%d want=%d body=%s read=%v close=%v logs=%s", method, path, response.StatusCode, status, data, e, closeErr, logs.String())
				}
				return data
			}
			put := func(path string, body []byte, status int) []byte {
				t.Helper()
				hash := digest(body)
				return request(http.MethodPut, path+"?offset=0", "application/octet-stream", body, map[string]string{"Daynight-File-Byte-Length": strconv.Itoa(len(body)), "Daynight-File-SHA256": hash, "Daynight-Chunk-SHA256": hash}, status)
			}
			entryID, imageID, resourceID := uuid.NewString(), uuid.NewString(), uuid.NewString()
			entry := sp.TimelineEntry{EntryID: entryID, EntrySeq: "1", Revision: "1", Kind: "assistant_message", Data: map[string]json.RawMessage{"content": json.RawMessage(`[{"type":"text","text":"body"}]`)}}
			tail := sp.ArchiveSourceTailRequest{Fence: snapshot.Fence, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "timeline_upsert", Payload: wire(entry)}}}
			var tailReceipt sp.ArchiveSourceTailReceipt
			if err = json.Unmarshal(request(http.MethodPost, base+"/archive/source-tail", "application/json", wire(tail), nil, http.StatusOK), &tailReceipt); err != nil || tailReceipt.BatchID != tail.BatchID || tailReceipt.LastAckedSourceSeq != "1" {
				t.Fatalf("source tail: %+v %v", tailReceipt, err)
			}
			prepare := sp.ArchivePrepareRequest{Fence: snapshot.Fence, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID}
			var prepared sp.ArchivePrepareReceipt
			if err = json.Unmarshal(request(http.MethodPost, base+"/archive/prepare", "application/json", wire(prepare), nil, http.StatusOK), &prepared); err != nil || prepared.Phase != "settling" {
				t.Fatalf("prepare: %+v %v", prepared, err)
			}
			history := sp.ArchiveHistoryContent{ContentPolicy: "task_body", HistoryEpoch: prepared.HistoryEpoch, SourceThrough: prepared.SourceThrough, Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{}}
			var original []byte
			var resource sp.Resource
			var captureID string
			var captureBefore sp.ImageCaptureReceipt
			var readGate io.Closer
			var otherLeaseID string
			t.Cleanup(func() {
				if readGate != nil {
					if e := readGate.Close(); e != nil {
						t.Error(e)
					}
				}
			})
			if scenario == "wrong-policy" {
				history.ContentPolicy = ""
			}
			if scenario == "missing-body-capture" || scenario == "shared-tool-image" || scenario == "matching-read-lease" || scenario == "other-read-lease" {
				original = []byte("captured original")
				length, hash, mime := strconv.Itoa(len(original)), digest(original), "image/png"
				dimension := 1
				resource = sp.Resource{ResourceID: resourceID, Revision: "1", Status: "available", Name: "original.png", MediaType: &mime, ByteLength: &length, SHA256: &hash, Width: &dimension, Height: &dimension, FrameCount: &dimension}
				position := sp.ImageOccurrence{ImageID: imageID, EntryID: entryID, Container: "content", SourceKey: "original"}
				if scenario != "missing-body-capture" {
					position.EntryID, position.Container = uuid.NewString(), "tool_output"
					call := "tool-call"
					position.CallID = &call
					if scenario == "shared-tool-image" {
						bodyImage := uuid.NewString()
						entry.Data["imageProjectionError"] = json.RawMessage(`null`)
						entry.Data["content"] = wire([]map[string]string{{"type": "image", "imageId": bodyImage, "resourceId": resourceID, "label": "original.png"}})
						history.Entries, history.Resources = []sp.TimelineEntry{entry}, []sp.Resource{resource}
					}
					path, e := core.BlobAddress(project, owner.UserID, snapshot.SessionID, resourceID)
					if e != nil {
						t.Fatal(e)
					}
					if _, e = files.Put(ctx, "session-resources", path, bytes.NewReader(original)); e != nil {
						t.Fatal(e)
					}
					if _, e = db.Pool.Exec(ctx, `INSERT INTO session_resources(session_id,resource_id,descriptor,blob_id,blob_path) VALUES($1,$2,$3,$2,$4)`, snapshot.SessionID, resourceID, wire(resource), path); e != nil {
						t.Fatal(e)
					}
					if _, e = db.Pool.Exec(ctx, `INSERT INTO session_resource_references(session_id,resource_id,kind,reference_id) VALUES($1,$2,'message',$3)`, snapshot.SessionID, resourceID, imageID); e != nil {
						t.Fatal(e)
					}
					if scenario == "matching-read-lease" || scenario == "other-read-lease" {
						if _, e = db.Pool.Exec(ctx, `INSERT INTO session_resource_references(session_id,resource_id,kind,reference_id) VALUES($1,$2,'operation',$3)`, snapshot.SessionID, resourceID, uuid.NewString()); e != nil {
							t.Fatal(e)
						}
						leaseResource := resourceID
						if scenario == "other-read-lease" {
							leaseResource = uuid.NewString()
							other := resource
							other.ResourceID = leaseResource
							otherPath, e := core.BlobAddress(project, owner.UserID, snapshot.SessionID, leaseResource)
							if e != nil {
								t.Fatal(e)
							}
							if _, e = files.Put(ctx, "session-resources", otherPath, bytes.NewReader(original)); e != nil {
								t.Fatal(e)
							}
							if _, e = db.Pool.Exec(ctx, `INSERT INTO session_resources(session_id,resource_id,descriptor,blob_id,blob_path) VALUES($1,$2,$3,$2,$4)`, snapshot.SessionID, leaseResource, wire(other), otherPath); e != nil {
								t.Fatal(e)
							}
						}
						leaseID := uuid.NewString()
						if scenario == "other-read-lease" {
							otherLeaseID = leaseID
						}
						readGate, e = files.AcquireGate(ctx, filestorage.MediaLeaseGate, "session-resource-lease/"+leaseID)
						if e != nil {
							t.Fatal(e)
						}
						if _, e = db.Pool.Exec(ctx, `INSERT INTO session_resource_leases(session_id,lease_id,owner_id,kind,resource_id,delete_epoch) VALUES($1,$2,$3,'read',$4,0)`, snapshot.SessionID, leaseID, owner.UserID, leaseResource); e != nil {
							t.Fatal(e)
						}
					}
				}
				captureID = uuid.NewString()
				attempt := uuid.NewString()
				capture := sp.ImageCaptureRequest{CaptureID: captureID, AttemptID: attempt, Occurrence: position, Locator: sp.ImageLocator{Kind: "external", URL: "https://example.test/image"}}
				_, err = db.WriteSession(ctx, func(scope store.SessionScope) error {
					return scope.SessionDAO().(store.SessionResourceDAO).SaveSessionCapture(ctx, store.SessionCaptureRecord{SessionID: snapshot.SessionID, Request: capture, Receipt: sp.ImageCaptureReceipt{CaptureID: captureID, AttemptID: attempt, Revision: "1", Occurrence: position, State: "committed", ResourceID: &resourceID, Resource: &resource}})
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "capacity" {
				// Store facts provide the measured retained resource sizes. No large
				// payload is written merely to exercise the combined limit.
				for i := 0; i < 13; i++ {
					id, image := uuid.NewString(), uuid.NewString()
					length, hash, mime := "10485760", strings.Repeat("a", 64), "image/png"
					dimension := 1
					desc := sp.Resource{ResourceID: id, Revision: "1", Status: "available", Name: "image.png", MediaType: &mime, ByteLength: &length, SHA256: &hash, Width: &dimension, Height: &dimension, FrameCount: &dimension}
					if _, err = db.Pool.Exec(ctx, `INSERT INTO session_resources(session_id,resource_id,descriptor,blob_id,blob_path) VALUES($1,$2,$3,$2,'fixture')`, snapshot.SessionID, id, wire(desc)); err != nil {
						t.Fatal(err)
					}
					history.Resources = append(history.Resources, desc)
					history.Entries = append(history.Entries, sp.TimelineEntry{EntryID: uuid.NewString(), EntrySeq: strconv.Itoa(i + 2), Revision: "1", Kind: "assistant_message", Data: map[string]json.RawMessage{"imageProjectionError": json.RawMessage(`null`), "content": wire([]map[string]string{{"type": "image", "imageId": image, "resourceId": id, "label": "image.png"}})}})
				}
			}
			source := wire(history)
			if _, e := sp.DecodeArchiveHistory(source); e != nil {
				t.Fatalf("invalid history fixture: %v", e)
			}
			sourcePath := filepath.Join(t.TempDir(), "history.json")
			if err = os.WriteFile(sourcePath, source, 0600); err != nil {
				t.Fatal(err)
			}
			fileID := uuid.NewString()
			status := http.StatusConflict
			if scenario == "shared-tool-image" || scenario == "other-read-lease" {
				status = http.StatusOK
			}
			if scenario == "matching-read-lease" {
				status = http.StatusTooManyRequests
			}
			frozen, err := os.ReadFile(sourcePath)
			if err != nil {
				t.Fatal(err)
			}
			result := put(base+"/archive/prepare/history/"+fileID, frozen, status)
			if scenario == "matching-read-lease" {
				if !bytes.Contains(result, []byte(`"resource_busy"`)) {
					t.Fatalf("matching reader: %s", result)
				}
				var pin bool
				if err = db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_resource_references WHERE session_id=$1 AND resource_id=$2 AND kind='message' AND reference_id=$3)`, snapshot.SessionID, resourceID, imageID).Scan(&pin); err != nil || !pin {
					t.Fatalf("pin lost on busy: %v %v", pin, err)
				}
				if err = readGate.Close(); err != nil {
					t.Fatal(err)
				}
				readGate = nil
				if _, err = db.Pool.Exec(ctx, `DELETE FROM session_resource_leases WHERE session_id=$1 AND kind='read'`, snapshot.SessionID); err != nil {
					t.Fatal(err)
				}
				put(base+"/archive/prepare/history/"+fileID, frozen, http.StatusOK)
				status = http.StatusOK
			}
			if scenario == "matching-read-lease" || scenario == "other-read-lease" {
				var messagePin, operationPin bool
				if err = db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_resource_references WHERE session_id=$1 AND resource_id=$2 AND kind='message' AND reference_id=$3), EXISTS(SELECT 1 FROM session_resource_references WHERE session_id=$1 AND resource_id=$2 AND kind='operation')`, snapshot.SessionID, resourceID, imageID).Scan(&messagePin, &operationPin); err != nil || !messagePin || !operationPin {
					t.Fatalf("history must retain references: message=%v operation=%v error=%v", messagePin, operationPin, err)
				}
				if got := request(http.MethodGet, base+"/resources/"+resourceID+"/content", "", nil, nil, http.StatusOK); !bytes.Equal(got, original) {
					t.Fatalf("history changed online original: %q", got)
				}
				var receiptData []byte
				if err = db.Pool.QueryRow(ctx, `SELECT receipt FROM session_image_captures WHERE session_id=$1 AND capture_id=$2`, snapshot.SessionID, captureID).Scan(&receiptData); err != nil {
					t.Fatal(err)
				}
				if err = json.Unmarshal(receiptData, &captureBefore); err != nil || captureBefore.State != "committed" || captureBefore.ResourceID == nil || *captureBefore.ResourceID != resourceID || !reflect.DeepEqual(captureBefore.Resource, &resource) {
					t.Fatalf("history changed capture receipt: %+v %v", captureBefore, err)
				}
			}
			if status != http.StatusOK {
				code := "archive_conflict"
				if scenario == "missing-body-capture" {
					code = "archive_incomplete"
				}
				if scenario == "capacity" {
					code = "quota_exceeded"
				}
				if !bytes.Contains(result, []byte(`"`+code+`"`)) {
					t.Fatalf("expected %s: %s", code, result)
				}
				retained, e := os.ReadFile(sourcePath)
				if e != nil || !bytes.Equal(retained, source) {
					t.Fatalf("source lost: %v", e)
				}
				return
			}
			var sealed sp.ArchivePrepareReceipt
			if err = json.Unmarshal(request(http.MethodPost, base+"/archive/seal", "", nil, nil, http.StatusOK), &sealed); err != nil || sealed.Phase != "sealed" {
				t.Fatalf("seal: %+v %v", sealed, err)
			}
			if scenario == "shared-tool-image" && (len(sealed.Resources) != 1 || sealed.Resources[0].Resource.ResourceID != resourceID) || scenario != "shared-tool-image" && len(sealed.Resources) != 0 {
				t.Fatalf("sealed resource closure: %+v", sealed.Resources)
			}
			var pin bool
			if err = db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_resource_references WHERE session_id=$1 AND resource_id=$2 AND kind='message' AND reference_id=$3)`, snapshot.SessionID, resourceID, imageID).Scan(&pin); err != nil || !pin {
				t.Fatalf("shared original pin: %v %v", pin, err)
			}
			timeline := wire(sp.ArchiveTimeline{Entries: history.Entries})
			timelineID := uuid.NewString()
			put(base+"/archive/files/"+timelineID, timeline, http.StatusOK)
			manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentPolicy: "task_body", ContentKind: "native_timeline", RecordID: snapshot.SessionID, Fence: snapshot.Fence, Provider: reg.Provider, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, Timeline: sp.ArchiveFileReference{FileID: timelineID, SHA256: digest(timeline), ByteLength: strconv.Itoa(len(timeline))}, Resources: sealed.Resources, Completeness: "complete"}
			if scenario == "matching-read-lease" {
				// Acquire a reader after history completion: ready must recheck it.
				leaseID := uuid.NewString()
				readGate, err = files.AcquireGate(ctx, filestorage.MediaLeaseGate, "session-resource-lease/"+leaseID)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = db.Pool.Exec(ctx, `INSERT INTO session_resource_leases(session_id,lease_id,owner_id,kind,resource_id,delete_epoch) VALUES($1,$2,$3,'read',$4,0)`, snapshot.SessionID, leaseID, owner.UserID, resourceID); err != nil {
					t.Fatal(err)
				}
				result = request(http.MethodPut, base+"/archive/content", "application/json", wire(manifest), nil, http.StatusTooManyRequests)
				if !bytes.Contains(result, []byte(`"resource_busy"`)) {
					t.Fatalf("late matching reader: %s", result)
				}
				if err = db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_resource_references WHERE session_id=$1 AND resource_id=$2 AND kind='message' AND reference_id=$3)`, snapshot.SessionID, resourceID, imageID).Scan(&pin); err != nil || !pin {
					t.Fatalf("busy publication lost message reference: %v %v", pin, err)
				}
				var ready bool
				if err = db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_archives WHERE session_id=$1 AND state='ready')`, snapshot.SessionID).Scan(&ready); err != nil || ready {
					t.Fatalf("busy publication became ready: %v %v", ready, err)
				}
				if got := request(http.MethodGet, base+"/resources/"+resourceID+"/content", "", nil, nil, http.StatusOK); !bytes.Equal(got, original) {
					t.Fatalf("busy publication changed original: %q", got)
				}
				if err = readGate.Close(); err != nil {
					t.Fatal(err)
				}
				readGate = nil
				if _, err = db.Pool.Exec(ctx, `DELETE FROM session_resource_leases WHERE session_id=$1 AND lease_id=$2`, snapshot.SessionID, leaseID); err != nil {
					t.Fatal(err)
				}
			}
			request(http.MethodPut, base+"/archive/content", "application/json", wire(manifest), nil, http.StatusOK)
			if scenario == "matching-read-lease" || scenario == "other-read-lease" {
				var messagePin, operationPin bool
				if err = db.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_resource_references WHERE session_id=$1 AND resource_id=$2 AND kind='message' AND reference_id=$3), EXISTS(SELECT 1 FROM session_resource_references WHERE session_id=$1 AND resource_id=$2 AND kind='operation')`, snapshot.SessionID, resourceID, imageID).Scan(&messagePin, &operationPin); err != nil || messagePin || !operationPin {
					t.Fatalf("ready reference retirement: message=%v operation=%v error=%v", messagePin, operationPin, err)
				}
				var receiptData []byte
				if err = db.Pool.QueryRow(ctx, `SELECT receipt FROM session_image_captures WHERE session_id=$1 AND capture_id=$2`, snapshot.SessionID, captureID).Scan(&receiptData); err != nil {
					t.Fatal(err)
				}
				var receipt sp.ImageCaptureReceipt
				if err = json.Unmarshal(receiptData, &receipt); err != nil || !reflect.DeepEqual(receipt, captureBefore) {
					t.Fatalf("capture receipt changed: %+v %v", receipt, err)
				}
				request(http.MethodPut, base+"/archive/content", "application/json", wire(manifest), nil, http.StatusOK)
			}
			if scenario == "shared-tool-image" {
				if got := request(http.MethodGet, base+"/resources/"+resourceID+"/content", "", nil, nil, http.StatusOK); !bytes.Equal(got, original) {
					t.Fatalf("shared original changed: %q", got)
				}
			}
			if otherLeaseID != "" {
				if err = readGate.Close(); err != nil {
					t.Fatal(err)
				}
				readGate = nil
				if _, err = db.Pool.Exec(ctx, `DELETE FROM session_resource_leases WHERE session_id=$1 AND lease_id=$2`, snapshot.SessionID, otherLeaseID); err != nil {
					t.Fatal(err)
				}
			}
		}) {
			t.FailNow()
		}
		var remaining int
		if err := db.Pool.QueryRow(context.Background(), `SELECT count(*) FROM session_resource_leases`).Scan(&remaining); err != nil || remaining != 0 {
			t.Fatalf("leases remain before fixture reuse: %d %v", remaining, err)
		}
	}
}
