package service_test

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
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/azure"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	storageconfig "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local/config"
	transfercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	transferservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func migrationDigest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func migrationWire(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// Separate databases preserve the complete stopped source pair, including the
// original unfinished upload. TEMPLATE is used only after all source clients drain.
// The package's unit TestMain clears database environment variables. This
// explicitly configured integration fixture captures its URL before that guard.
var migrationAPIDatabaseURL = os.Getenv("DAYNIGHT_TEST_DATABASE_URL")

func migrationDatabasePair(t *testing.T) (string, string, func()) {
	t.Helper()
	raw := migrationAPIDatabaseURL
	if raw == "" || os.Getenv("DAYNIGHT_TEST_AZURITE_CONNECTION_STRING") == "" {
		t.Skip("requires isolated PostgreSQL and Azurite")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(t.Context(), raw)
	if err != nil {
		t.Fatal(err)
	}
	source, target := "blob5_source_"+strings.ReplaceAll(uuid.NewString(), "-", ""), "blob5_target_"+strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = pool.Exec(t.Context(), "CREATE DATABASE "+pgx.Identifier{source}.Sanitize()); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		for _, name := range []string{target, source} {
			if _, err := pool.Exec(ctx, "DROP DATABASE IF EXISTS "+pgx.Identifier{name}.Sanitize()+" WITH (FORCE)"); err != nil {
				t.Error(err)
			}
		}
		pool.Close()
	})
	withDatabase := func(name string) string {
		copied := *parsed
		copied.Path = "/" + name
		q := copied.Query()
		q.Del("search_path")
		q.Del("application_name")
		copied.RawQuery = q.Encode()
		return copied.String()
	}
	return withDatabase(source), withDatabase(target), func() {
		t.Helper()
		if _, err := pool.Exec(t.Context(), "CREATE DATABASE "+pgx.Identifier{target}.Sanitize()+" TEMPLATE "+pgx.Identifier{source}.Sanitize()); err != nil {
			t.Fatal(err)
		}
	}
}

type migrationHTTP struct {
	t      *testing.T
	server *httptest.Server
}

type migrationFiniteStream struct {
	reader *bytes.Reader
	ctx    context.Context
}

func (s *migrationFiniteStream) BindReadContext(ctx context.Context) func() error {
	previous := s.ctx
	s.ctx = ctx
	return func() error { s.ctx = previous; return nil }
}
func (s *migrationFiniteStream) Read(data []byte) (int, error) {
	if s.ctx != nil && s.ctx.Err() != nil {
		return 0, s.ctx.Err()
	}
	return s.reader.Read(data)
}

func migrationRoutes(t *testing.T, db *postgres.Store, files filestorage.Storage, owner model.Principal) (*sessionservice.Service, *sessioncore.Engine, migrationHTTP) {
	t.Helper()
	engine := sessioncore.NewEngine(files)
	engine.SetArchiveV2RegistrationEnabled(true)
	// The image codec is a controlled collaborator; this fixture verifies upload
	// persistence and migration, while image decoding has its own artifact tests.
	engine.SetImageDecoder(func(ctx context.Context, r io.Reader, length int64, digest string) (sp.ValidatedImage, error) {
		data, err := io.ReadAll(r)
		if err != nil {
			return sp.ValidatedImage{}, err
		}
		if int64(len(data)) != length || migrationDigest(data) != digest {
			return sp.ValidatedImage{}, errors.New("image fixture integrity mismatch")
		}
		return sp.ValidatedImage{MediaType: "image/png", ByteLength: strconv.FormatInt(length, 10), SHA256: digest, Width: 1, Height: 1, FrameCount: 1}, nil
	})
	s := sessionservice.New(db, engine)
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	authentication, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		if kind != model.PATCredential || token != "migration-test-token" {
			return model.Principal{}, authhttp.Failure()
		}
		return owner, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example.com"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	routes := sessionhttp.NewRoutes(s, &authhttp.Authentication{RequestAuthentication: authentication}, logger)
	routes.SetArchiveUploadV2Enabled(true)
	mux := http.NewServeMux()
	routes.RegisterRoutes(mux)
	server := httptest.NewServer(mux)
	return s, engine, migrationHTTP{t, server}
}

func (h migrationHTTP) request(method, path string, data []byte, headers map[string]string, status int) []byte {
	h.t.Helper()
	req, err := http.NewRequestWithContext(h.t.Context(), method, h.server.URL+path, bytes.NewReader(data))
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer migration-test-token")
	req.Header.Set("Daynight-Session-Content-Revision", "2")
	if strings.Contains(path, "/archive/") {
		req.Header.Set("Daynight-Archive-Upload-Version", "2")
	}
	if data != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	response, err := h.server.Client().Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	body, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil || response.StatusCode != status {
		h.t.Fatalf("%s %s: status=%d want=%d body=%s read=%v close=%v", method, path, response.StatusCode, status, body, readErr, closeErr)
	}
	return body
}

func (h migrationHTTP) put(path string, data []byte) []byte {
	return h.request(http.MethodPut, path+"?offset=0", data, map[string]string{"Content-Type": "application/octet-stream", "Daynight-Archive-Upload-Version": "2", "Daynight-File-Byte-Length": strconv.Itoa(len(data)), "Daynight-File-SHA256": migrationDigest(data)}, http.StatusOK)
}

func migrationRegisterTest(t *testing.T, s *sessionservice.Service, owner model.Principal) (sp.Snapshot, sp.TestRegistration, string) {
	t.Helper()
	registration := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	snapshot, err := s.RegisterTest(t.Context(), owner, registration)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := s.Grant(t.Context(), owner, "", "", snapshot.SessionID, sp.Grant{Protocol: sp.Protocol, TestExecutionID: registration.TestExecutionID, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, ExecutionGeneration: snapshot.ExecutionGeneration, Kind: "bootstrap"})
	if err != nil {
		t.Fatal(err)
	}
	epoch := uuid.NewString()
	connected, err := s.Connect(t.Context(), grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Provider: "codex", SourceEpoch: epoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1, ContentRevision: 2}, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if err = s.Disconnect(t.Context(), connected.ControllerFence); err != nil {
		t.Fatal(err)
	}
	return connected, registration, epoch
}

type migrationHistoryReceipt struct {
	sp.ArchiveFileReceipt
	SyncID   string  `json:"syncId"`
	Revision *string `json:"timelineRevision"`
}

func migrationPrepareStopped(t *testing.T, s *sessionservice.Service, h migrationHTTP, owner model.Principal, entry sp.TimelineEntry) (sp.Snapshot, sp.TestRegistration, sp.ArchiveHistoryContent) {
	t.Helper()
	snapshot, registration, epoch := migrationRegisterTest(t, s, owner)
	base := "/api/v1/test-sessions/" + snapshot.SessionID
	h.request(http.MethodPost, base+"/stop", migrationWire(t, sp.TestStop{Protocol: sp.Protocol, Fence: snapshot.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, StopProof: sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}), nil, http.StatusOK)
	h.request(http.MethodPost, base+"/archive/source-tail", migrationWire(t, sp.ArchiveSourceTailRequest{Fence: snapshot.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "timeline_upsert", Payload: migrationWire(t, entry)}}}), nil, http.StatusOK)
	var prepared sp.ArchivePrepareReceipt
	if err := json.Unmarshal(h.request(http.MethodPost, base+"/archive/prepare", migrationWire(t, sp.ArchivePrepareRequest{Fence: snapshot.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID}), nil, http.StatusOK), &prepared); err != nil {
		t.Fatal(err)
	}
	return snapshot, registration, sp.ArchiveHistoryContent{HistoryEpoch: prepared.HistoryEpoch, SourceThrough: "1", Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{}}
}

func migrationRegisterPartial(t *testing.T, s *sessionservice.Service, owner model.Principal, sessionID, fileID string, body, prefix []byte) {
	t.Helper()
	op, err := s.BeginArchive(t.Context(), owner, "", "", sessionID, sessioncore.ArchiveV1Upload)
	if err != nil {
		t.Fatal(err)
	}
	_, err = op.PutArchiveFileV2(t.Context(), "history", fileID, 0, int64(len(body)), migrationDigest(body), &migrationFiniteStream{reader: bytes.NewReader(prefix)})
	closeErr := op.Close()
	if (!errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF)) || closeErr != nil {
		t.Fatalf("partial source stream: %v close=%v", err, closeErr)
	}
}

func migrationImageController(t *testing.T, s *sessionservice.Service, snapshot sp.Snapshot, spec sp.ImageUploadSpec, original []byte) {
	t.Helper()
	fence := snapshot.ControllerFence
	provider := sp.ProviderImageCapabilities{Revision: "1", Send: "supported", Steer: "unsupported", InputMediaTypes: []string{"image/png"}, MaxImageBytes: "1000000", MaxMessageImageBytes: "1000000", MaxImagesPerMessage: 1, Geometry: sp.ImageGeometry{Version: 1, Known: true, MaxWidth: 10, MaxHeight: 10, MaxPixels: 100, MaxFrames: 1}}
	state := sp.State{NativeSessionID: snapshot.Identity.NativeSessionID, InitialInputState: snapshot.InitialInputState, Synchronized: true, Activity: "initializing", ProviderImages: &provider}
	if _, err := s.Handle(t.Context(), sp.ControllerMessage{Type: "sync_state", ControllerFence: fence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				done <- nil
				return
			case <-ticker.C:
			}
			offers, err := s.Poll(ctx, fence)
			if err != nil {
				if ctx.Err() != nil {
					done <- nil
				} else {
					done <- err
				}
				return
			}
			for _, offer := range offers {
				if offer["type"] != "image_request" {
					continue
				}
				action, ok := offer["action"].(string)
				if !ok {
					done <- errors.New("controller offer missing action")
					return
				}
				var body struct {
					UploadID string `json:"uploadId"`
					Data     string `json:"data"`
				}
				if err = json.Unmarshal(offer["body"].(json.RawMessage), &body); err != nil || body.UploadID != spec.UploadID {
					done <- fmt.Errorf("controller upload identity: %v", err)
					return
				}
				response := sp.LocalImagePreparation{UploadID: spec.UploadID, ImageID: spec.ImageID, Target: spec.Target, State: "receiving", AcceptedOffset: "0"}
				switch action {
				case "prepare":
				case "write":
					data, decodeErr := base64.StdEncoding.Strict().DecodeString(body.Data)
					if decodeErr != nil || !bytes.Equal(data, original) {
						done <- fmt.Errorf("controller original bytes differ: %v", decodeErr)
						return
					}
					response.AcceptedOffset = spec.ByteLength
				case "complete":
					response.State, response.AcceptedOffset = "validated", spec.ByteLength
					response.Validated = &sp.ValidatedImage{MediaType: spec.MediaType, ByteLength: spec.ByteLength, SHA256: spec.SHA256, Width: 1, Height: 1, FrameCount: 1}
				default:
					done <- fmt.Errorf("unexpected controller media action %s", action)
					return
				}
				wire, err := json.Marshal(response)
				if err != nil {
					done <- err
					return
				}
				if _, err = s.Handle(ctx, sp.ControllerMessage{Type: "image_response", ControllerFence: fence, RequestID: offer["requestId"].(string), Action: action, MediaResult: wire}); err != nil {
					done <- err
					return
				}
			}
		}
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Error("controller fixture did not drain")
		}
	})
}

func TestStorageMigrationPairedHTTPRecovery(t *testing.T) {
	sourceURL, targetURL, clone := migrationDatabasePair(t)
	ctx := t.Context()
	db, err := postgres.Open(ctx, sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	_, browser, _ := testutil.AuthRecords(t, db)
	pat := uuid.NewString()
	hash := sha256.Sum256([]byte(pat))
	if _, err = db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(business_scopes,scope_version,id,user_id,token_hash,name,created_at,expires_at) VALUES(ARRAY['session:control','session:produce','session:read','session:send','attachment:read','attachment:upload'],1,$1,$2,$3,'migration test',now(),now()+interval '1 day')`, pat, browser.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	owner := model.Principal{Kind: model.PATCredential, UserID: browser.UserID, CredentialID: pat}
	sourceRoot := t.TempDir()
	sourceFiles, err := local.New(sourceRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err = sourceFiles.EnableArchiveStaging(ctx, true); err != nil {
		t.Fatal(err)
	}
	s, engine, sourceHTTP := migrationRoutes(t, db, sourceFiles, owner)
	t.Cleanup(func() {
		sourceHTTP.server.Close()
		_ = engine.Stop(context.Background())
		db.Close()
		_ = sourceFiles.Close()
	})

	entry := sp.TimelineEntry{EntryID: uuid.NewString(), EntrySeq: "1", Revision: "1", Kind: "assistant_message", Data: map[string]json.RawMessage{"content": migrationWire(t, []map[string]string{{"type": "text", "text": strings.Repeat("paired migration ", 40000)}})}}
	snapshot, _, history := migrationPrepareStopped(t, s, sourceHTTP, owner, entry)
	base := "/api/v1/test-sessions/" + snapshot.SessionID
	completedID := uuid.NewString()
	completedBody := migrationWire(t, history)
	sourceHTTP.put(base+"/archive/prepare/history/"+completedID, completedBody)
	sourceHTTP.request(http.MethodPost, base+"/archive/prepare/history/"+completedID+"/complete", nil, nil, http.StatusOK)
	replacementID := uuid.NewString()
	history.Entries[0].Revision = "2"
	replacementBody := migrationWire(t, history)
	migrationRegisterPartial(t, s, owner, snapshot.SessionID, replacementID, replacementBody, replacementBody[:512*1024])
	var receiving sp.ArchiveFileReceipt
	if err = json.Unmarshal(sourceHTTP.request(http.MethodGet, base+"/archive/prepare/history/"+replacementID+"/status", nil, nil, http.StatusOK), &receiving); err != nil || receiving.State != "receiving" || receiving.AcceptedOffset != "524288" {
		t.Fatalf("source receiving=%+v err=%v", receiving, err)
	}
	var oldLedger []byte
	var sourceRevision int64
	if err = db.Pool.QueryRow(ctx, `SELECT ledger,revision FROM session_archive_bundles WHERE session_id=$1`, snapshot.SessionID).Scan(&oldLedger, &sourceRevision); err != nil || sourceRevision != 2 {
		t.Fatalf("source revision=%d err=%v", sourceRevision, err)
	}

	formalEntry := sp.TimelineEntry{EntryID: uuid.NewString(), EntrySeq: "1", Revision: "1", Kind: "assistant_message", Data: map[string]json.RawMessage{"content": migrationWire(t, []map[string]string{{"type": "text", "text": "Published archive retained across migration"}})}}
	formalSnapshot, formalRegistration, formalHistory := migrationPrepareStopped(t, s, sourceHTTP, owner, formalEntry)
	formalBase := "/api/v1/test-sessions/" + formalSnapshot.SessionID
	formalHistoryID := uuid.NewString()
	sourceHTTP.put(formalBase+"/archive/prepare/history/"+formalHistoryID, migrationWire(t, formalHistory))
	sourceHTTP.request(http.MethodPost, formalBase+"/archive/prepare/history/"+formalHistoryID+"/complete", nil, nil, http.StatusOK)
	var sealed sp.ArchivePrepareReceipt
	if err = json.Unmarshal(sourceHTTP.request(http.MethodPost, formalBase+"/archive/seal", nil, nil, http.StatusOK), &sealed); err != nil || sealed.Phase != "sealed" {
		t.Fatalf("formal seal=%+v err=%v", sealed, err)
	}
	formalTimelineID := uuid.NewString()
	formalTimeline := migrationWire(t, sp.ArchiveTimeline{Entries: []sp.TimelineEntry{formalEntry}})
	sourceHTTP.put(formalBase+"/archive/files/"+formalTimelineID, formalTimeline)
	sourceHTTP.request(http.MethodPost, formalBase+"/archive/files/"+formalTimelineID+"/complete", nil, nil, http.StatusOK)
	formalManifest := migrationWire(t, sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: formalSnapshot.SessionID, Fence: formalSnapshot.Fence, Provider: "codex", ControllerID: formalRegistration.ControllerID, ControllerInstanceID: formalRegistration.ControllerInstanceID, Timeline: sp.ArchiveFileReference{FileID: formalTimelineID, SHA256: migrationDigest(formalTimeline), ByteLength: strconv.Itoa(len(formalTimeline))}, Resources: sealed.Resources, Completeness: "complete"})
	sourceHTTP.request(http.MethodPut, formalBase+"/archive/content", formalManifest, nil, http.StatusOK)
	formalPublished := sourceHTTP.request(http.MethodGet, formalBase+"/archive/content", nil, nil, http.StatusOK)

	failedSnapshot, _, failedHistory := migrationPrepareStopped(t, s, sourceHTTP, owner, formalEntry)
	failedBase := "/api/v1/test-sessions/" + failedSnapshot.SessionID
	failedID, successorID := uuid.NewString(), uuid.NewString()
	failedBody := migrationWire(t, failedHistory)
	migrationRegisterPartial(t, s, owner, failedSnapshot.SessionID, failedID, failedBody, nil)
	namespace, err := sessionarchive.NewNamespace(sessionarchive.Users, owner.UserID, failedSnapshot.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	guard, err := sourceFiles.AcquireArchiveStaging(ctx, namespace, false)
	if err != nil {
		t.Fatal(err)
	}
	deleteErr := guard.Delete(ctx, failedID)
	if closeErr := guard.Close(); deleteErr != nil || closeErr != nil {
		t.Fatalf("remove failed staging=%v close=%v", deleteErr, closeErr)
	}
	sourceHTTP.request(http.MethodPost, failedBase+"/archive/prepare/history/"+failedID+"/complete", nil, nil, http.StatusOK)
	var failedReceipt migrationHistoryReceipt
	if err = json.Unmarshal(sourceHTTP.request(http.MethodPost, failedBase+"/archive/prepare/history/"+failedID+"/restart", migrationWire(t, map[string]string{"replacementFileId": successorID}), nil, http.StatusOK), &failedReceipt); err != nil || failedReceipt.State != "failed" || failedReceipt.Error == nil || failedReceipt.Error.Code != "staging_corrupt" || failedReceipt.SuccessorFileID == nil || *failedReceipt.SuccessorFileID != successorID {
		t.Fatalf("failed predecessor=%+v err=%v", failedReceipt, err)
	}

	imageSnapshot, imageRegistration, imageEpoch := migrationRegisterTest(t, s, owner)
	imageBase := "/api/v1/test-sessions/" + imageSnapshot.SessionID
	imageBytes := []byte("image fixture original")
	oldImage := sp.ImageUploadSpec{UploadID: uuid.NewString(), ImageID: uuid.NewString(), Target: sp.ImageTarget{ServerOrigin: "https://daynight.example.com", ActorUserID: owner.UserID, Fence: imageSnapshot.Fence}, Name: "original.png", MediaType: "image/png", ByteLength: strconv.Itoa(len(imageBytes)), SHA256: migrationDigest(imageBytes)}
	sourceHTTP.request(http.MethodPut, imageBase+"/image-uploads/"+oldImage.UploadID, migrationWire(t, oldImage), nil, http.StatusCreated)
	sourceHTTP.request(http.MethodPut, imageBase+"/image-uploads/"+oldImage.UploadID+"/chunks?offset=0", imageBytes, map[string]string{"Content-Type": "application/octet-stream", "Daynight-Chunk-SHA256": migrationDigest(imageBytes)}, http.StatusOK)

	project, err := projectservice.NewProjects(db).Create(ctx, browser, projectcore.CreateProject{ExpectedUserID: browser.UserID, Name: "Migration fixture", RepoURL: "https://github.com/example/blob5"})
	if err != nil {
		t.Fatal(err)
	}
	todo := model.TaskTodo
	task, err := taskservice.NewTasks(db).Create(ctx, browser, project.ID, taskcore.CreateTask{Title: "Migration attachment", Status: &todo})
	if err != nil {
		t.Fatal(err)
	}
	lifecycle, err := transferservice.New(db, sourceFiles, sourceFiles, 64<<20, 0)
	if err != nil {
		t.Fatal(err)
	}
	uploads := transferservice.NewUploads(lifecycle, sourceFiles, attachmentservice.NewAttachments(db, db, sourceFiles))
	actor := transfercore.Actor{Principal: owner, AuthorityKind: "pat", AuthorityID: pat}
	pendingTransfer, committedTransfer, unknownTransfer := uuid.NewString(), uuid.NewString(), uuid.NewString()
	execute := func(id string, in transferservice.UploadInput) map[string]any {
		t.Helper()
		in.TransferID = id
		out, e := uploads.Execute(ctx, actor, project.ID, task.ID, in)
		if e != nil {
			t.Fatalf("MCP %s: %v", in.Action, e)
		}
		return out
	}
	for _, id := range []string{pendingTransfer, committedTransfer, unknownTransfer} {
		execute(id, transferservice.UploadInput{Action: "begin", Path: id + ".txt", ContentType: "text/plain"})
		execute(id, transferservice.UploadInput{Action: "chunk", ChunkID: uuid.NewString(), Offset: "0", ContentBase64: base64.StdEncoding.EncodeToString([]byte("retained MCP bytes")), SHA256: migrationDigest([]byte("retained MCP bytes"))})
	}
	committed := execute(committedTransfer, transferservice.UploadInput{Action: "commit", TotalBytes: "18", SHA256: migrationDigest([]byte("retained MCP bytes"))})
	if committed["writeOutcome"] != "confirmed" {
		t.Fatalf("MCP completed=%v", committed)
	}
	unknownRecord, err := lifecycle.LookupBound(ctx, actor, unknownTransfer)
	if err != nil {
		t.Fatal(err)
	}
	unknownData, err := transfercore.DecodeUploadData(unknownRecord)
	if err != nil {
		t.Fatal(err)
	}
	unknownData.OperationID = uuid.NewString()
	unknownTotal := int64(18)
	unknownData.TotalBytes = &unknownTotal
	unknownData.SHA256 = migrationDigest([]byte("retained MCP bytes"))
	lease := time.Now().Add(30 * time.Second)
	unknownRecord, err = lifecycle.Transition(ctx, actor, unknownTransfer, unknownRecord.Version, "committing", transfercore.EncodeUploadData(unknownData), &lease)
	if err != nil {
		t.Fatal(err)
	}
	unknownData.WriteOutcome = "unknown"
	if _, err = lifecycle.Transition(ctx, actor, unknownTransfer, unknownRecord.Version, "unknown", transfercore.EncodeUploadData(unknownData), nil); err != nil {
		t.Fatal(err)
	}
	var retainedAddresses []attachmentcore.Address
	retainedBytes := []byte("retained soft-deleted attachment")
	for _, kind := range []model.TaskType{model.TaskTypeTask, model.TaskTypeGoal} {
		deleted, e := taskservice.NewTasks(db).Create(ctx, browser, project.ID, taskcore.CreateTask{Type: kind, Title: "Retained deleted " + string(kind), Status: &todo})
		if e != nil {
			t.Fatal(e)
		}
		path := "目录/" + string(kind) + ".txt"
		if _, _, e = attachmentservice.NewAttachments(db, db, sourceFiles).Put(ctx, browser, project.ID, deleted.ID, path, "text/plain", bytes.NewReader(retainedBytes)); e != nil {
			t.Fatal(e)
		}
		var version int64
		if e = db.Pool.QueryRow(ctx, `SELECT version FROM tasks WHERE id=$1`, deleted.ID).Scan(&version); e != nil {
			t.Fatal(e)
		}
		if e = taskservice.NewTasks(db).Delete(ctx, browser, project.ID, deleted.ID, taskcore.DeleteTask{Version: version}); e != nil {
			t.Fatal(e)
		}
		address, e := attachmentcore.NewAddress(project.ID, deleted.ID, path)
		if e != nil {
			t.Fatal(e)
		}
		retainedAddresses = append(retainedAddresses, address)
	}
	if err = lifecycle.Close(ctx); err != nil {
		t.Fatal(err)
	}
	sourceHTTP.server.Close()
	if err = engine.Stop(ctx); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if err = sourceFiles.Close(); err != nil {
		t.Fatal(err)
	}
	clone()

	connection := os.Getenv("DAYNIGHT_TEST_AZURITE_CONNECTION_STRING")
	containerName := "migration-" + strings.ReplaceAll(uuid.NewString(), "-", "")
	client, err := container.NewClientFromConnectionString(connection, containerName, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Create(ctx, nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := client.Delete(ctx, nil); err != nil {
			t.Error(err)
		}
	})
	targetConfig := storageconfig.Config{Backend: "azure-blob", Root: t.TempDir(), Azure: storageconfig.AzureConfig{Container: containerName, ConnectionString: connection}}
	var events []service.StorageMigrationEvent
	report := func(event service.StorageMigrationEvent) error { events = append(events, event); return nil }
	if err = service.MigrateStorage(ctx, targetURL, sourceRoot, targetConfig, report); err != nil {
		t.Fatal(err)
	}
	if err = service.MigrateStorage(ctx, targetURL, sourceRoot, targetConfig, report); err != nil {
		t.Fatalf("rerun: %v", err)
	}
	verified, reused := 0, 0
	for _, event := range events {
		if event.Kind == "migration" && event.Status == "verified" {
			verified++
		}
		if event.Status == "reused" {
			reused++
		}
	}
	if verified != 2 || reused == 0 {
		t.Fatalf("reports verified=%d reused=%d", verified, reused)
	}
	gates, err := local.NewStandaloneGates("migration-api")
	if err != nil {
		t.Fatal(err)
	}
	azureFiles, err := azure.New(client, gates, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, address := range retainedAddresses {
		object, e := azureFiles.Open(ctx, attachmentcore.Bucket, address.StoragePath)
		if e != nil {
			t.Fatal(e)
		}
		body, e := io.ReadAll(object.Body)
		closeErr := object.Body.Close()
		if e != nil || closeErr != nil || !bytes.Equal(body, retainedBytes) {
			t.Fatalf("retained deleted attachment differs: %v %v", e, closeErr)
		}
	}
	targetDB, err := postgres.OpenOfflineStorageMigration(ctx, targetURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(targetDB.Close)
	targetService, targetEngine, targetHTTP := migrationRoutes(t, targetDB, azureFiles, owner)
	t.Cleanup(func() {
		targetHTTP.server.Close()
		if err := targetEngine.Stop(context.Background()); err != nil {
			t.Error(err)
		}
	})
	if published := targetHTTP.request(http.MethodGet, formalBase+"/archive/content", nil, nil, http.StatusOK); !bytes.Equal(published, formalPublished) {
		t.Fatal("published archive manifest changed")
	}
	if timeline := targetHTTP.request(http.MethodGet, formalBase+"/archive/files/"+formalTimelineID, nil, nil, http.StatusOK); !bytes.Equal(timeline, formalTimeline) {
		t.Fatal("published archive timeline changed")
	}
	var retainedFailure migrationHistoryReceipt
	if err = json.Unmarshal(targetHTTP.request(http.MethodGet, failedBase+"/archive/prepare/history/"+failedID+"/status", nil, nil, http.StatusOK), &retainedFailure); err != nil || retainedFailure.State != "failed" || retainedFailure.Error == nil || retainedFailure.Error.Code != "staging_corrupt" || retainedFailure.SuccessorFileID == nil || *retainedFailure.SuccessorFileID != successorID {
		t.Fatalf("retained predecessor=%+v err=%v", retainedFailure, err)
	}
	if missing := targetHTTP.request(http.MethodGet, failedBase+"/archive/prepare/history/"+successorID+"/status", nil, nil, http.StatusNotFound); bytes.Contains(missing, []byte("staging_corrupt")) {
		t.Fatalf("successor is not ordinarily unregistered: %s", missing)
	}
	targetHTTP.put(failedBase+"/archive/prepare/history/"+successorID, failedBody)
	var completedSuccessor migrationHistoryReceipt
	if err = json.Unmarshal(targetHTTP.request(http.MethodPost, failedBase+"/archive/prepare/history/"+successorID+"/complete", nil, nil, http.StatusOK), &completedSuccessor); err != nil || completedSuccessor.State != "complete" || completedSuccessor.SyncID != successorID {
		t.Fatalf("successor completion=%+v err=%v", completedSuccessor, err)
	}
	var targetLedger []byte
	var targetRevision int64
	var currentHistory *string
	if err = targetDB.Pool.QueryRow(ctx, `SELECT ledger,revision,history_id::text FROM session_archive_bundles WHERE session_id=$1`, snapshot.SessionID).Scan(&targetLedger, &targetRevision, &currentHistory); err != nil || targetRevision != sourceRevision || currentHistory != nil || !bytes.Equal(oldLedger, targetLedger) {
		t.Fatalf("target preserved ledger/revision: revision=%d history=%v err=%v", targetRevision, currentHistory, err)
	}
	absent := targetHTTP.request(http.MethodGet, base+"/archive/prepare/history/"+replacementID+"/status", nil, nil, http.StatusNotFound)
	if bytes.Contains(absent, []byte("staging_corrupt")) {
		t.Fatalf("not an ordinary unregistered response: %s", absent)
	}
	targetHTTP.request(http.MethodGet, base+"/archive/prepare/history/"+completedID+"/status", nil, nil, http.StatusOK)
	targetHTTP.put(base+"/archive/prepare/history/"+replacementID, replacementBody)
	targetHTTP.request(http.MethodPost, base+"/archive/prepare/history/"+replacementID+"/complete", nil, nil, http.StatusOK)
	var restored migrationHistoryReceipt
	if err = json.Unmarshal(targetHTTP.request(http.MethodGet, base+"/archive/prepare/history/"+replacementID+"/status", nil, nil, http.StatusOK), &restored); err != nil || restored.State != "complete" || restored.Revision == nil || *restored.Revision != "2" || restored.SyncID != replacementID {
		t.Fatalf("restored history=%+v err=%v", restored, err)
	}
	var released sp.ImageUploadReceipt
	if err = json.Unmarshal(targetHTTP.request(http.MethodGet, imageBase+"/image-uploads/"+oldImage.UploadID, nil, nil, http.StatusOK), &released); err != nil || released.State != "released" || released.AcceptedOffset != strconv.Itoa(len(imageBytes)) {
		t.Fatalf("released image=%+v err=%v", released, err)
	}
	newImage := oldImage
	newImage.UploadID = uuid.NewString()
	newImage.ImageID = uuid.NewString()
	// Controller capabilities are negotiated on each connection, including after
	// a service restart. Reconnect the same authorized standalone execution.
	imageGrant, err := targetService.Grant(ctx, owner, "", "", imageSnapshot.SessionID, sp.Grant{Protocol: sp.Protocol, TestExecutionID: imageRegistration.TestExecutionID, ControllerID: imageRegistration.ControllerID, ControllerInstanceID: imageRegistration.ControllerInstanceID, ExecutionGeneration: imageSnapshot.ExecutionGeneration, Kind: "reconnect"})
	if err != nil {
		t.Fatal(err)
	}
	reconnected, err := targetService.Connect(ctx, imageGrant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: imageSnapshot.ControllerFence, ControllerID: imageRegistration.ControllerID, ControllerInstanceID: imageRegistration.ControllerInstanceID, Provider: "codex", SourceEpoch: imageEpoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1, ContentRevision: 2}, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	migrationImageController(t, targetService, reconnected, newImage, imageBytes)
	targetHTTP.request(http.MethodPut, imageBase+"/image-uploads/"+newImage.UploadID, migrationWire(t, newImage), nil, http.StatusCreated)
	targetHTTP.request(http.MethodPut, imageBase+"/image-uploads/"+newImage.UploadID+"/chunks?offset=0", imageBytes, map[string]string{"Content-Type": "application/octet-stream", "Daynight-Chunk-SHA256": migrationDigest(imageBytes)}, http.StatusOK)
	var completedImage sp.ImageUploadReceipt
	if err = json.Unmarshal(targetHTTP.request(http.MethodPost, imageBase+"/image-uploads/"+newImage.UploadID+"/complete", migrationWire(t, sp.ImageUploadComplete{SHA256: newImage.SHA256, ByteLength: newImage.ByteLength}), nil, http.StatusOK), &completedImage); err != nil || completedImage.State != "complete" || completedImage.Resource == nil || completedImage.Resource.SHA256 == nil || *completedImage.Resource.SHA256 != newImage.SHA256 {
		t.Fatalf("new image completion=%+v err=%v", completedImage, err)
	}

	targetLifecycle, err := transferservice.New(targetDB, azureFiles, azureFiles, 64<<20, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := targetLifecycle.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	targetUploads := transferservice.NewUploads(targetLifecycle, azureFiles, attachmentservice.NewAttachments(targetDB, targetDB, azureFiles))
	for _, id := range []string{pendingTransfer, committedTransfer, unknownTransfer} {
		status, err := targetUploads.Execute(ctx, actor, project.ID, task.ID, transferservice.UploadInput{Action: "status", TransferID: id})
		if err != nil {
			t.Fatal(err)
		}
		if status["state"] != "closed" || status["cleanupState"] != "complete" {
			t.Fatalf("old MCP status=%v", status)
		}
		if id == committedTransfer && (status["writeOutcome"] != "confirmed" || status["operationId"] != committed["operationId"]) {
			t.Fatalf("MCP committed receipt changed: %v", status)
		}
		if id == unknownTransfer && (status["writeOutcome"] != "unknown" || status["operationId"] != unknownData.OperationID) {
			t.Fatalf("MCP unknown receipt changed: %v", status)
		}
	}
	inline, err := targetUploads.Execute(ctx, actor, project.ID, task.ID, transferservice.UploadInput{Action: "inline", Path: "new-upload.txt", ContentType: "text/plain", ContentBase64: base64.StdEncoding.EncodeToString([]byte("new Azure attachment"))})
	if err != nil || inline["writeOutcome"] != "confirmed" {
		t.Fatalf("new MCP upload=%v err=%v", inline, err)
	}
	if err = service.VerifyStorageBackup(ctx, sourceURL, sourceRoot); err != nil {
		t.Fatalf("untouched source pair cannot restore: %v", err)
	}
	sourceDB, err := postgres.OpenReadOnly(ctx, sourceURL)
	if err != nil {
		t.Fatal(err)
	}
	defer sourceDB.Close()
	var originalState string
	var originalRevision int64
	if err = sourceDB.Pool.QueryRow(ctx, `SELECT f.state,b.revision FROM session_archive_files f JOIN session_archive_bundles b USING(session_id) WHERE f.session_id=$1 AND f.file_id=$2`, snapshot.SessionID, replacementID).Scan(&originalState, &originalRevision); err != nil || originalState != "receiving" || originalRevision != 2 {
		t.Fatalf("source pair modified: state=%s revision=%d err=%v", originalState, originalRevision, err)
	}
	t.Logf("BLOB-5 paired restore verified; original history=%s replacement=%s revision=2; target ordinary404 -> PUT0 -> complete; released image offset=%s; MCP old tickets closed with completed operation=%v; reruns=%d reused=%d", completedID, replacementID, released.AcceptedOffset, committed["operationId"], verified, reused)
}
