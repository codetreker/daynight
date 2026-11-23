package session_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	redisgates "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/redis"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

type archiveV2CleanupFault struct {
	*local.Storage
	failAt      atomic.Int32
	deleted     atomic.Int32
	blockedFile string
	entered     chan struct{}
	release     chan struct{}
}

func (s *archiveV2CleanupFault) DeleteArchiveBlock(ctx context.Context, namespace sessionarchive.Namespace, fileID string, offset int64) error {
	if fileID == s.blockedFile || (s.failAt.Load() != 0 && s.deleted.Add(1) == s.failAt.Load()) {
		return errors.New("injected staging cleanup failure")
	}
	return s.Storage.DeleteArchiveBlock(ctx, namespace, fileID, offset)
}

func (s *archiveV2CleanupFault) PutArchiveBlock(ctx context.Context, namespace sessionarchive.Namespace, fileID string, offset int64, data []byte) error {
	if s.entered != nil {
		close(s.entered)
		select {
		case <-s.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return s.Storage.PutArchiveBlock(ctx, namespace, fileID, offset, data)
}

// The full stopped upload uses actual HTTP, transactions and a shared local root.
// Renaming the legacy chunk table makes any accidental v2 read or write fail.
func TestArchiveV2StoppedHTTPAndStorage(t *testing.T) {
	cases := []struct {
		name     string
		original []byte
		redis    bool
	}{
		{"local-multiblock", bytes.Repeat([]byte("x"), int(sessionarchive.BlockSize)+3), false},
		{"local-empty", []byte{}, false},
		{"redis-multiblock", bytes.Repeat([]byte("x"), int(sessionarchive.BlockSize)+3), true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			original := tc.original
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			db, owner, _, _, _ := archiveFixture(t)
			root := t.TempDir()
			var gates filestorage.Gates
			if tc.redis {
				redisURL := os.Getenv("DAYNIGHT_TEST_REDIS_URL")
				if redisURL == "" {
					t.Fatal("DAYNIGHT_TEST_REDIS_URL is required")
				}
				options, err := redis.ParseURL(redisURL)
				if err != nil {
					t.Fatal(err)
				}
				client := redis.NewClient(options)
				t.Cleanup(func() {
					if e := client.Close(); e != nil {
						t.Error(e)
					}
				})
				if err = client.Ping(ctx).Err(); err != nil {
					t.Fatal(err)
				}
				gates = redisgates.New(client)
			}
			openFiles := func() (*local.Storage, error) {
				if gates == nil {
					return local.New(root)
				}
				return local.NewWithGates(root, gates)
			}
			files, err := openFiles()
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := files.Close(); err != nil {
					t.Error(err)
				}
			})
			faults := &archiveV2CleanupFault{Storage: files}
			engine := core.NewEngine(faults)
			t.Cleanup(func() {
				if err := engine.Stop(context.Background()); err != nil {
					t.Error(err)
				}
			})
			service := sessionservice.New(db, engine)
			registration := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
			snapshot, err := service.RegisterTest(ctx, owner, registration)
			if err != nil {
				t.Fatal(err)
			}
			grant, err := service.Grant(ctx, owner, "", "", snapshot.SessionID, sp.Grant{Protocol: sp.Protocol, TestExecutionID: registration.TestExecutionID, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, ExecutionGeneration: snapshot.ExecutionGeneration, Kind: "bootstrap"})
			if err != nil {
				t.Fatal(err)
			}
			epoch := uuid.NewString()
			connected, err := service.Connect(ctx, grant.Token, sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: snapshot.ControllerFence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Provider: registration.Provider, SourceEpoch: epoch, LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}, uuid.NewString())
			if err != nil {
				t.Fatal(err)
			}
			if err = service.Disconnect(ctx, connected.ControllerFence); err != nil {
				t.Fatal(err)
			}
			logger := slog.New(slog.NewTextHandler(io.Discard, nil))
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
			t.Cleanup(func() { server.Close() })
			base := "/api/v1/test-sessions/" + snapshot.SessionID
			request := func(method, path, contentType string, body []byte, headers map[string]string, want int) ([]byte, http.Header) {
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
				resp, e := server.Client().Do(req)
				if e != nil {
					t.Fatal(e)
				}
				result, e := io.ReadAll(resp.Body)
				closeErr := resp.Body.Close()
				if e != nil || closeErr != nil || (want == 0 && resp.StatusCode < 400) || (want != 0 && resp.StatusCode != want) {
					t.Fatalf("%s %s: %d %s read=%v close=%v", method, path, resp.StatusCode, result, e, closeErr)
				}
				return result, resp.Header
			}
			marshal := func(v any) []byte {
				t.Helper()
				b, e := json.Marshal(v)
				if e != nil {
					t.Fatal(e)
				}
				return b
			}
			digest := func(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
			version := map[string]string{"Daynight-Archive-Upload-Version": "2"}
			stop := sp.TestStop{Protocol: sp.Protocol, Fence: snapshot.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, StopProof: sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
			request(http.MethodPost, base+"/stop", "application/json", marshal(stop), nil, http.StatusOK)
			resourceID := uuid.NewString()
			length := strconv.Itoa(len(original))
			hash := digest(original)
			mime := "text/plain"
			resource := sp.Resource{ResourceID: resourceID, Status: "available", Name: "legacy", MediaType: &mime, ByteLength: &length, SHA256: &hash}
			secondData := []byte("second original")
			secondID := uuid.NewString()
			secondLength, secondHash := strconv.Itoa(len(secondData)), digest(secondData)
			secondResource := sp.Resource{ResourceID: secondID, Status: "available", Name: "second", MediaType: &mime, ByteLength: &secondLength, SHA256: &secondHash}
			entry, err := sp.DecodeTimeline([]byte(`{"entryId":"` + uuid.NewString() + `","entrySeq":"1","revision":"1","kind":"assistant_message","content":[{"type":"resource","resourceId":"` + resourceID + `","label":"legacy"},{"type":"resource","resourceId":"` + secondID + `","label":"second"}]}`))
			if err != nil {
				t.Fatal(err)
			}
			tail := sp.ArchiveSourceTailRequest{Fence: snapshot.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "timeline_upsert", Payload: marshal(entry)}}}
			request(http.MethodPost, base+"/archive/source-tail", "application/json", marshal(tail), nil, http.StatusOK)
			prepare := sp.ArchivePrepareRequest{Fence: snapshot.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID}
			raw, header := request(http.MethodPost, base+"/archive/prepare", "application/json", marshal(prepare), nil, http.StatusOK)
			if header.Get("Daynight-Archive-Upload-Version") == "" {
				t.Fatal("missing upload capability")
			}
			var prepared sp.ArchivePrepareReceipt
			if err = json.Unmarshal(raw, &prepared); err != nil || prepared.Phase != "settling" {
				t.Fatalf("prepare: %s %v", raw, err)
			}
			// Isolate this schema's legacy table: any accidental chunk query now fails.
			if _, err = db.Pool.Exec(ctx, `ALTER TABLE session_archive_chunks RENAME TO session_archive_chunks_v1_unavailable`); err != nil {
				t.Fatal(err)
			}
			history := marshal(sp.ArchiveHistoryContent{HistoryEpoch: prepared.HistoryEpoch, SourceThrough: "1", Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{resource, secondResource}})
			historyID := uuid.NewString()
			historyPath := base + "/archive/prepare/history/" + historyID
			put := func(path string, data []byte, offset int, chunk []byte, descriptor *sp.Resource, want int) []byte {
				t.Helper()
				headers := map[string]string{"Daynight-Archive-Upload-Version": "2", "Daynight-File-Byte-Length": strconv.Itoa(len(data)), "Daynight-File-SHA256": digest(data), "Daynight-Chunk-SHA256": digest(chunk)}
				query := "?offset=" + strconv.Itoa(offset)
				if descriptor != nil {
					query += "&purpose=resource&migrationOnly=true"
					headers["Daynight-Resource-Descriptor"] = string(marshal(descriptor))
				}
				b, _ := request(http.MethodPut, path+query, "application/octet-stream", chunk, headers, want)
				return b
			}
			expectReceipt := func(raw []byte, state, offset string) {
				t.Helper()
				var v struct{ State, AcceptedOffset string }
				if e := json.Unmarshal(raw, &v); e != nil || v.State != state || v.AcceptedOffset != offset {
					t.Fatalf("receipt: %s %v", raw, e)
				}
			}
			verifyBackup := func() {
				t.Helper()
				// Stop HTTP writes while B1 reads one PG snapshot and its paired volume.
				server.Close()
				if _, e := db.Pool.Exec(ctx, `ALTER TABLE session_archive_chunks_v1_unavailable RENAME TO session_archive_chunks`); e != nil {
					t.Fatal(e)
				}
				seen := false
				e := db.VerifyStorageInventory(ctx, func(inventory store.StorageInventory) error {
					if inventory.SessionID == snapshot.SessionID {
						seen = true
					}
					return core.VerifyStorageBackup(ctx, files, inventory)
				})
				if e != nil || !seen {
					t.Fatalf("paired backup verification: seen=%v error=%v", seen, e)
				}
				if binary := os.Getenv("DAYNIGHT_TEST_VERIFY_STORAGE_BINARY"); binary != "" {
					command := exec.CommandContext(ctx, binary, "verify-storage", "--root", t.TempDir())
					for _, entry := range os.Environ() {
						key, _, _ := strings.Cut(entry, "=")
						if !strings.HasPrefix(key, "DAYNIGHT_") {
							command.Env = append(command.Env, entry)
						}
					}
					command.Env = append(command.Env, "DAYNIGHT_DATABASE_URL="+db.Pool.Config().ConnString(), "DAYNIGHT_STORAGE_ROOT="+root)
					output, err := command.CombinedOutput()
					if err != nil || !bytes.Contains(output, []byte("Storage backup closure verified.")) {
						t.Fatalf("verify-storage command: %v %s", err, output)
					}
				}
				if _, e = db.Pool.Exec(ctx, `ALTER TABLE session_archive_chunks RENAME TO session_archive_chunks_v1_unavailable`); e != nil {
					t.Fatal(e)
				}
				server = httptest.NewServer(mux)
			}
			namespace, err := sessionarchive.NewNamespace(sessionarchive.Users, owner.UserID, snapshot.SessionID)
			if err != nil {
				t.Fatal(err)
			}
			// A corrupt history may only be replaced through its restart receipt;
			// preparation reset would discard the revision and closure.
			put(historyPath, history, 0, history, nil, http.StatusOK)
			corruptHistory, err := namespace.BlockPath(historyID, 0)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = files.Put(ctx, sessionarchive.Bucket, corruptHistory, bytes.NewReader(bytes.Repeat([]byte("!"), len(history)))); err != nil {
				t.Fatal(err)
			}
			request(http.MethodPost, historyPath+"/complete", "", nil, version, 0)
			var historyRevision int64
			if err = db.Pool.QueryRow(ctx, `SELECT revision FROM session_archive_bundles WHERE session_id=$1`, snapshot.SessionID).Scan(&historyRevision); err != nil {
				t.Fatal(err)
			}
			reset := prepare
			reset.ExpectedTimelineRevision = strconv.FormatInt(historyRevision, 10)
			reset.FailedFileID = historyID
			request(http.MethodPost, base+"/archive/prepare", "application/json", marshal(reset), nil, http.StatusConflict)
			nextHistory := uuid.NewString()
			request(http.MethodPost, historyPath+"/restart", "application/json", marshal(map[string]string{"replacementFileId": nextHistory}), version, http.StatusOK)
			historyID = nextHistory
			historyPath = base + "/archive/prepare/history/" + historyID
			// Force the acknowledgement transaction to roll back after the block
			// has been published, then reconcile using the same file and offset.
			if _, err = db.Pool.Exec(ctx, `CREATE FUNCTION fail_archive_offset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.accepted_offset > OLD.accepted_offset THEN RAISE EXCEPTION 'injected offset failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_archive_offset BEFORE UPDATE ON session_archive_files FOR EACH ROW EXECUTE FUNCTION fail_archive_offset()`); err != nil {
				t.Fatal(err)
			}
			put(historyPath, history, 0, history, nil, 0)
			raw, _ = request(http.MethodGet, historyPath+"/status", "", nil, nil, http.StatusOK)
			expectReceipt(raw, "receiving", "0")
			published, err := namespace.BlockPath(historyID, 0)
			if err != nil {
				t.Fatal(err)
			}
			object, err := files.Open(ctx, sessionarchive.Bucket, published)
			if err != nil {
				t.Fatal(err)
			}
			stored, readErr := io.ReadAll(object.Body)
			if closeErr := object.Body.Close(); readErr != nil || closeErr != nil || !bytes.Equal(stored, history) {
				t.Fatalf("unacknowledged block: %v %v", readErr, closeErr)
			}
			if _, err = db.Pool.Exec(ctx, `DROP TRIGGER fail_archive_offset ON session_archive_files; DROP FUNCTION fail_archive_offset()`); err != nil {
				t.Fatal(err)
			}
			put(historyPath, history, 0, history, nil, http.StatusOK)
			raw, header = request(http.MethodGet, historyPath+"/status", "", nil, nil, http.StatusOK)
			expectReceipt(raw, "receiving", strconv.Itoa(len(history)))
			if header.Get("Daynight-Archive-Upload-Version") != "2" {
				t.Fatal("file version missing")
			}
			verifyBackup()
			raw, _ = request(http.MethodPost, historyPath+"/complete", "", nil, version, http.StatusOK)
			expectReceipt(raw, "complete", strconv.Itoa(len(history)))
			// Replaying the same completion is safe after the first response is lost.
			repeat, _ := request(http.MethodPost, historyPath+"/complete", "", nil, version, http.StatusOK)
			if !bytes.Equal(raw, repeat) {
				t.Fatalf("history completion receipt changed: %s / %s", raw, repeat)
			}
			blobID := "10000000-0000-4000-8000-000000000001"
			blobPath := base + "/archive/files/" + blobID
			if len(original) == 0 {
				put(blobPath, original, 0, original, &resource, http.StatusOK)
			} else {
				split := int(sessionarchive.BlockSize)
				poisonID := uuid.NewString()
				poisonPath := base + "/archive/files/" + poisonID
				put(poisonPath, original, 0, original[:split], &resource, http.StatusOK)
				put(poisonPath, original, split, original[split:], &resource, http.StatusOK)
				var originalRevision int64
				var originalLedger []byte
				if e := db.Pool.QueryRow(ctx, `SELECT revision,ledger FROM session_archive_bundles WHERE session_id=$1`, snapshot.SessionID).Scan(&originalRevision, &originalLedger); e != nil {
					t.Fatal(e)
				}
				setBundle := func(revision int64, ledger []byte) {
					t.Helper()
					if _, e := db.Pool.Exec(ctx, `UPDATE session_archive_bundles SET revision=$2,ledger=$3 WHERE session_id=$1`, snapshot.SessionID, revision, ledger); e != nil {
						t.Fatal(e)
					}
				}
				var altered map[string]json.RawMessage
				if e := json.Unmarshal(originalLedger, &altered); e != nil {
					t.Fatal(e)
				}
				altered["Resources"] = json.RawMessage(`[]`)
				missingResource := marshal(altered)
				for _, stale := range []struct {
					revision int64
					ledger   []byte
				}{{originalRevision, missingResource}} {
					setBundle(stale.revision, stale.ledger)
					request(http.MethodPost, poisonPath+"/complete", "", nil, version, http.StatusConflict)
					raw, _ = request(http.MethodGet, poisonPath+"/status", "", nil, nil, http.StatusOK)
					expectReceipt(raw, "receiving", strconv.Itoa(len(original)))
				}
				setBundle(originalRevision, originalLedger)
				poisonBlock, e := namespace.BlockPath(poisonID, 0)
				if e != nil {
					t.Fatal(e)
				}
				if _, e = files.Put(ctx, sessionarchive.Bucket, poisonBlock, bytes.NewReader(bytes.Repeat([]byte("!"), split))); e != nil {
					t.Fatal(e)
				}
				request(http.MethodPost, poisonPath+"/complete", "", nil, version, 0)
				for _, stale := range []struct {
					revision int64
					ledger   []byte
				}{{originalRevision, missingResource}} {
					setBundle(stale.revision, stale.ledger)
					request(http.MethodPost, poisonPath+"/restart", "application/json", marshal(map[string]string{"replacementFileId": blobID}), version, http.StatusConflict)
					var rows int
					if e = db.Pool.QueryRow(ctx, `SELECT count(*) FROM session_archive_files WHERE session_id=$1 AND file_id=$2`, snapshot.SessionID, blobID).Scan(&rows); e != nil || rows != 0 {
						t.Fatalf("stale successor persisted: %d %v", rows, e)
					}
				}
				setBundle(originalRevision, originalLedger)
				put(blobPath, original, 0, original[:split], &resource, http.StatusConflict)
				var replacements int
				if e = db.Pool.QueryRow(ctx, `SELECT count(*) FROM session_archive_files WHERE session_id=$1 AND file_id=$2`, snapshot.SessionID, blobID).Scan(&replacements); e != nil || replacements != 0 {
					t.Fatalf("unapproved successor persisted: %d %v", replacements, e)
				}
				setBundle(originalRevision+1, originalLedger)
				request(http.MethodPost, poisonPath+"/restart", "application/json", marshal(map[string]string{"replacementFileId": blobID}), version, http.StatusOK)
				setBundle(originalRevision, originalLedger)
				// Hold the first writer at its physical block publication while a
				// second Server on the same root attempts the same offset.
				otherFiles, e := openFiles()
				if e != nil {
					t.Fatal(e)
				}
				t.Cleanup(func() {
					if e := otherFiles.Close(); e != nil {
						t.Error(e)
					}
				})
				otherEngine := core.NewEngine(otherFiles)
				t.Cleanup(func() {
					if e := otherEngine.Stop(context.Background()); e != nil {
						t.Error(e)
					}
				})
				otherMux := http.NewServeMux()
				sessionhttp.NewRoutes(sessionservice.New(db, otherEngine), &authhttp.Authentication{RequestAuthentication: auth}, logger).RegisterRoutes(otherMux)
				otherServer := httptest.NewServer(otherMux)
				defer otherServer.Close()
				faults.entered, faults.release = make(chan struct{}), make(chan struct{})
				release := sync.OnceFunc(func() { close(faults.release) })
				defer release()
				headers := map[string]string{"Daynight-Archive-Upload-Version": "2", "Daynight-File-Byte-Length": strconv.Itoa(len(original)), "Daynight-File-SHA256": digest(original), "Daynight-Chunk-SHA256": digest(original[:split]), "Daynight-Resource-Descriptor": string(marshal(resource))}
				path := blobPath + "?offset=0&purpose=resource&migrationOnly=true"
				newRequest := func(url string) *http.Request {
					req, e := http.NewRequestWithContext(ctx, http.MethodPut, url+path, bytes.NewReader(original[:split]))
					if e != nil {
						t.Fatal(e)
					}
					req.Header.Set("Authorization", "Bearer test-token")
					req.Header.Set("Content-Type", "application/octet-stream")
					for k, v := range headers {
						req.Header.Set(k, v)
					}
					return req
				}
				firstReq := newRequest(server.URL)
				firstResult := make(chan error, 1)
				go func() {
					response, e := server.Client().Do(firstReq)
					if e != nil {
						firstResult <- e
						return
					}
					body, readErr := io.ReadAll(response.Body)
					closeErr := response.Body.Close()
					if response.StatusCode != http.StatusOK {
						firstResult <- fmt.Errorf("first writer: %d %s", response.StatusCode, body)
						return
					}
					firstResult <- errors.Join(readErr, closeErr)
				}()
				select {
				case <-faults.entered:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				response, e := otherServer.Client().Do(newRequest(otherServer.URL))
				if e != nil {
					t.Fatal(e)
				}
				responseBody, readErr := io.ReadAll(response.Body)
				closeErr := response.Body.Close()
				if readErr != nil || closeErr != nil || response.StatusCode < 400 {
					t.Fatalf("competing writer: %d %s %v %v", response.StatusCode, responseBody, readErr, closeErr)
				}
				release()
				if e = <-firstResult; e != nil {
					t.Fatal(e)
				}
				faults.entered, faults.release = nil, nil
				otherServer.Close()
				raw, _ = request(http.MethodGet, blobPath+"/status", "", nil, nil, http.StatusOK)
				expectReceipt(raw, "receiving", strconv.Itoa(split))
				verifyBackup()
				put(blobPath, original, 0, original[:split], &resource, 0)
				put(blobPath, original, split, original[split:], &resource, http.StatusOK)
			}
			raw, _ = request(http.MethodGet, blobPath+"/status", "", nil, nil, http.StatusOK)
			expectReceipt(raw, "receiving", strconv.Itoa(len(original)))
			verifyBackup()
			if len(original) != 0 {
				faults.deleted.Store(0)
				faults.failAt.Store(2)
			}
			raw, _ = request(http.MethodPost, blobPath+"/complete", "", nil, version, http.StatusOK)
			expectReceipt(raw, "complete", strconv.Itoa(len(original)))
			secondBlobID := "f0000000-0000-4000-8000-000000000001"
			secondPath := base + "/archive/files/" + secondBlobID
			uploadSecond := func() {
				put(secondPath, secondData, 0, secondData, &secondResource, http.StatusOK)
				var revision int64
				if err := db.Pool.QueryRow(ctx, `SELECT revision FROM session_archive_bundles WHERE session_id=$1`, snapshot.SessionID).Scan(&revision); err != nil {
					t.Fatal(err)
				}
				if _, err := db.Pool.Exec(ctx, `UPDATE session_archive_bundles SET revision=$2 WHERE session_id=$1`, snapshot.SessionID, revision+1); err != nil {
					t.Fatal(err)
				}
				secondReceipt, _ := request(http.MethodPost, secondPath+"/complete", "", nil, version, http.StatusOK)
				expectReceipt(secondReceipt, "complete", strconv.Itoa(len(secondData)))
				if _, err := db.Pool.Exec(ctx, `UPDATE session_archive_bundles SET revision=$2 WHERE session_id=$1`, snapshot.SessionID, revision); err != nil {
					t.Fatal(err)
				}
			}
			if len(original) != 0 {
				var released bool
				if err = db.Pool.QueryRow(ctx, `SELECT staging_released FROM session_archive_files WHERE session_id=$1 AND file_id=$2`, snapshot.SessionID, blobID).Scan(&released); err != nil || released {
					t.Fatalf("failed cleanup recorded as released: %v %v", released, err)
				}
				request(http.MethodGet, blobPath+"/status", "", nil, nil, http.StatusOK)
				request(http.MethodPost, blobPath+"/complete", "", nil, nil, 0)
				request(http.MethodPost, base+"/archive/prepare/history/"+blobID+"/complete", "", nil, version, 0)
				if err = db.Pool.QueryRow(ctx, `SELECT staging_released FROM session_archive_files WHERE session_id=$1 AND file_id=$2`, snapshot.SessionID, blobID).Scan(&released); err != nil || released {
					t.Fatalf("GET or invalid completion changed cleanup state: %v %v", released, err)
				}
				firstPath, _ := namespace.BlockPath(blobID, 0)
				lastPath, _ := namespace.BlockPath(blobID, sessionarchive.BlockSize)
				if _, e := files.Open(ctx, sessionarchive.Bucket, firstPath); !errors.Is(e, os.ErrNotExist) {
					t.Fatalf("first block not removed: %v", e)
				}
				object, e := files.Open(ctx, sessionarchive.Bucket, lastPath)
				if e != nil {
					t.Fatalf("second block not retained: %v", e)
				}
				if e = object.Body.Close(); e != nil {
					t.Fatal(e)
				}
				// The older file keeps failing. A later file must nevertheless be
				// reclaimed in the same pass, even when it sorts after that failure.
				faults.failAt.Store(0)
				faults.blockedFile = blobID
				uploadSecond()
				var secondReleased bool
				if err = db.Pool.QueryRow(ctx, `SELECT staging_released FROM session_archive_files WHERE session_id=$1 AND file_id=$2`, snapshot.SessionID, secondBlobID).Scan(&secondReleased); err != nil || !secondReleased {
					t.Fatalf("other file not reclaimed: %v %v", secondReleased, err)
				}
				if err = db.Pool.QueryRow(ctx, `SELECT staging_released FROM session_archive_files WHERE session_id=$1 AND file_id=$2`, snapshot.SessionID, blobID).Scan(&released); err != nil || released {
					t.Fatalf("persistently failed file marked released: %v %v", released, err)
				}
				faults.blockedFile = ""
				repeat, _ = request(http.MethodPost, blobPath+"/complete", "", nil, version, http.StatusOK)
				if !bytes.Equal(raw, repeat) {
					t.Fatalf("completion receipt changed: %s / %s", raw, repeat)
				}
				if err = db.Pool.QueryRow(ctx, `SELECT staging_released FROM session_archive_files WHERE session_id=$1 AND file_id=$2`, snapshot.SessionID, blobID).Scan(&released); err != nil || !released {
					t.Fatalf("cleanup retry did not persist release: %v %v", released, err)
				}
			} else {
				uploadSecond()
			}
			raw, _ = request(http.MethodPost, base+"/archive/seal", "", nil, nil, http.StatusOK)
			var sealed sp.ArchivePrepareReceipt
			if err = json.Unmarshal(raw, &sealed); err != nil || sealed.Phase != "sealed" || len(sealed.Resources) != 2 {
				t.Fatalf("seal: %s %v", raw, err)
			}
			timeline := marshal(sp.ArchiveTimeline{Entries: []sp.TimelineEntry{entry}})
			fileID := uuid.NewString()
			filePath := base + "/archive/files/" + fileID
			put(filePath, timeline, 0, timeline, nil, http.StatusOK)
			blockPath, err := namespace.BlockPath(fileID, 0)
			if err != nil {
				t.Fatal(err)
			}
			// Confirmed block corruption must not damage the sealed closure or revision.
			damaged := bytes.Repeat([]byte("!"), len(timeline))
			if _, err = files.Put(ctx, sessionarchive.Bucket, blockPath, bytes.NewReader(damaged)); err != nil {
				t.Fatal(err)
			}
			request(http.MethodPost, filePath+"/complete", "", nil, version, 0)
			raw, _ = request(http.MethodGet, filePath+"/status", "", nil, nil, http.StatusOK)
			var failed sp.ArchiveFileReceipt
			if err = json.Unmarshal(raw, &failed); err != nil || failed.State != "failed" || failed.Error == nil || failed.Error.Code != "staging_corrupt" {
				t.Fatalf("failed receipt: %s %v", raw, err)
			}
			reset = prepare
			reset.ExpectedTimelineRevision = *sealed.TimelineRevision
			reset.FailedFileID = fileID
			request(http.MethodPost, base+"/archive/prepare", "application/json", marshal(reset), nil, http.StatusConflict)
			replacement := uuid.NewString()
			restart := marshal(map[string]string{"replacementFileId": replacement})
			raw, _ = request(http.MethodPost, filePath+"/restart", "application/json", restart, version, http.StatusOK)
			repeat, _ = request(http.MethodPost, filePath+"/restart", "application/json", restart, version, http.StatusOK)
			if !bytes.Equal(raw, repeat) {
				t.Fatalf("restart receipt changed: %s / %s", raw, repeat)
			}
			request(http.MethodPost, filePath+"/restart", "application/json", marshal(map[string]string{"replacementFileId": uuid.NewString()}), version, 0)
			replacementPath := base + "/archive/files/" + replacement
			raw, _ = request(http.MethodGet, replacementPath+"/status", "", nil, nil, http.StatusOK)
			expectReceipt(raw, "receiving", "0")
			put(replacementPath, timeline, 0, timeline, nil, http.StatusOK)
			raw, _ = request(http.MethodPost, replacementPath+"/complete", "", nil, version, http.StatusOK)
			expectReceipt(raw, "complete", strconv.Itoa(len(timeline)))
			manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: snapshot.SessionID, Fence: snapshot.Fence, Provider: registration.Provider, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Timeline: sp.ArchiveFileReference{FileID: replacement, SHA256: digest(timeline), ByteLength: strconv.Itoa(len(timeline))}, Resources: sealed.Resources, Completeness: "complete"}
			manifestBytes := marshal(manifest)
			request(http.MethodPut, base+"/archive/content", "application/json", manifestBytes, nil, http.StatusOK)
			verifyBackup()
			if got, _ := request(http.MethodGet, replacementPath, "", nil, nil, http.StatusOK); !bytes.Equal(got, timeline) {
				t.Fatalf("timeline mismatch: %s", got)
			}
			var rows int
			if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM session_archive_chunks_v1_unavailable WHERE session_id=$1`, snapshot.SessionID).Scan(&rows); err != nil || rows != 0 {
				t.Fatalf("v2 chunk rows %d: %v", rows, err)
			}
		})
	}
}
