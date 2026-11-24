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
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/google/uuid"
)

// The original stopped writer can publish a v1 archive without ever creating an
// active history bundle. The Controller is disconnected before any archive write.
func TestStoppedArchiveWithoutActiveBundleHTTP(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	db, owner, _, _, _ := archiveFixture(t)
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
	t.Cleanup(server.Close)
	base := "/api/v1/test-sessions/" + snapshot.SessionID
	request := func(method, path, contentType string, body []byte, headers map[string]string) []byte {
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
		if e != nil || closeErr != nil || response.StatusCode != http.StatusOK {
			t.Fatalf("%s %s: status=%d body=%s read=%v close=%v", method, path, response.StatusCode, data, e, closeErr)
		}
		return data
	}
	marshal := func(v any) []byte {
		t.Helper()
		b, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		return b
	}
	stop := sp.TestStop{Protocol: sp.Protocol, Fence: snapshot.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, StopProof: sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	request(http.MethodPost, base+"/stop", "application/json", marshal(stop), nil)
	var count int
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM session_archive_bundles WHERE session_id=$1`, snapshot.SessionID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("active bundle before stop archive: %d %v", count, err)
	}
	entry := sp.TimelineEntry{EntryID: uuid.NewString(), EntrySeq: "1", Revision: "1", Kind: "assistant_message", Data: map[string]json.RawMessage{"content": json.RawMessage(`[{"type":"text","text":"stopped source"}]`)}}
	tail := sp.ArchiveSourceTailRequest{Fence: snapshot.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, SourceEpoch: epoch, BatchID: uuid.NewString(), Events: []sp.SourceEvent{{SourceSeq: "1", Kind: "timeline_upsert", Payload: marshal(entry)}}}
	var tailReceipt sp.ArchiveSourceTailReceipt
	if err = json.Unmarshal(request(http.MethodPost, base+"/archive/source-tail", "application/json", marshal(tail), nil), &tailReceipt); err != nil || tailReceipt.LastAckedSourceSeq != "1" || tailReceipt.BatchID != tail.BatchID {
		t.Fatalf("source tail receipt: %+v %v", tailReceipt, err)
	}
	// A recovery response may be lost after commit. Replay it and check that
	// its receipt proves only the supplied event while the old batch remains
	// subject to original event and batch identity checks.
	recovery := sp.ArchiveSourceRecoveryRequest{Fence: snapshot.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, SourceEpoch: epoch, OldBatchID: uuid.NewString(), RecoveryID: uuid.NewString(), Cutoff: "1", Events: tail.Events}
	for i := 0; i < 2; i++ {
		var receipt sp.ArchiveSourceRecoveryReceipt
		if err = json.Unmarshal(request(http.MethodPost, base+"/archive/source-tail/recover", "application/json", marshal(recovery), nil), &receipt); err != nil || receipt.VerifiedThrough != "1" || receipt.CurrentThrough != "1" || receipt.RecoveryID != recovery.RecoveryID {
			t.Fatal(receipt, err)
		}
	}
	refuse := func(path string, body []byte) {
		t.Helper()
		req, e := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+path, bytes.NewReader(body))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Authorization", "Bearer test-token")
		req.Header.Set("Content-Type", "application/json")
		response, e := server.Client().Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusConflict {
			data, _ := io.ReadAll(response.Body)
			t.Fatalf("expected conflict: %d %s", response.StatusCode, data)
		}
	}
	var reordered map[string]json.RawMessage
	if err = json.Unmarshal(tail.Events[0].Payload, &reordered); err != nil {
		t.Fatal(err)
	}
	changed := tail
	changed.BatchID = recovery.OldBatchID
	changed.Events = append([]sp.SourceEvent(nil), tail.Events...)
	keys := make([]string, 0, len(reordered))
	for key := range reordered {
		keys = append(keys, key)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(keys)))
	var raw bytes.Buffer
	raw.WriteByte('{')
	for index, key := range keys {
		if index > 0 {
			raw.WriteByte(',')
		}
		raw.Write(marshal(key))
		raw.WriteByte(':')
		raw.Write(reordered[key])
	}
	raw.WriteByte('}')
	changed.Events[0].Payload = raw.Bytes()
	if bytes.Equal(changed.Events[0].Payload, tail.Events[0].Payload) {
		t.Fatal("fixture did not reorder source event")
	}
	refuse(base+"/archive/source-tail", marshal(changed))
	// A different recovery cannot bypass an existing original batch ID.
	existing := recovery
	existing.RecoveryID = uuid.NewString()
	existing.OldBatchID = tail.BatchID
	refuse(base+"/archive/source-tail/recover", marshal(existing))
	prepare := sp.ArchivePrepareRequest{Fence: snapshot.Fence, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID}
	var prepared sp.ArchivePrepareReceipt
	if err = json.Unmarshal(request(http.MethodPost, base+"/archive/prepare", "application/json", marshal(prepare), nil), &prepared); err != nil || prepared.Phase != "settling" || prepared.SourceThrough != "1" {
		t.Fatalf("prepare: %+v %v", prepared, err)
	}
	digest := func(b []byte) string { d := sha256.Sum256(b); return hex.EncodeToString(d[:]) }
	put := func(path string, body []byte) {
		t.Helper()
		hash := digest(body)
		var receipt sp.ArchiveFileReceipt
		data := request(http.MethodPut, path+"?offset=0", "application/octet-stream", body, map[string]string{"Daynight-File-Byte-Length": strconv.Itoa(len(body)), "Daynight-File-SHA256": hash, "Daynight-Chunk-SHA256": hash})
		if e := json.Unmarshal(data, &receipt); e != nil || receipt.State != "complete" || receipt.SHA256 != hash || receipt.AcceptedOffset != strconv.Itoa(len(body)) {
			t.Fatalf("file receipt: %+v %v", receipt, e)
		}
	}
	history := marshal(sp.ArchiveHistoryContent{HistoryEpoch: prepared.HistoryEpoch, SourceThrough: "1", Entries: []sp.TimelineEntry{entry}, Resources: []sp.Resource{}})
	put(base+"/archive/prepare/history/"+uuid.NewString(), history)
	var sealed sp.ArchivePrepareReceipt
	if err = json.Unmarshal(request(http.MethodPost, base+"/archive/seal", "", nil, nil), &sealed); err != nil || sealed.Phase != "sealed" || len(sealed.Resources) != 0 {
		t.Fatalf("seal: %+v %v", sealed, err)
	}
	refuse(base+"/archive/source-tail/recover", marshal(recovery))
	timeline := marshal(sp.ArchiveTimeline{Entries: []sp.TimelineEntry{entry}})
	fileID := uuid.NewString()
	put(base+"/archive/files/"+fileID, timeline)
	manifest := sp.ArchiveManifest{SchemaVersion: 3, ContentKind: "native_timeline", RecordID: snapshot.SessionID, Fence: snapshot.Fence, Provider: registration.Provider, ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Timeline: sp.ArchiveFileReference{FileID: fileID, SHA256: digest(timeline), ByteLength: strconv.Itoa(len(timeline))}, Resources: sealed.Resources, Completeness: "complete"}
	manifestBytes := marshal(manifest)
	request(http.MethodPut, base+"/archive/content", "application/json", manifestBytes, nil)
	if got := request(http.MethodGet, base+"/archive/content", "", nil, nil); !bytes.Equal(got, manifestBytes) {
		t.Fatalf("manifest changed: %s", got)
	}
	if got := request(http.MethodGet, base+"/archive/files/"+fileID, "", nil, nil); !bytes.Equal(got, timeline) {
		t.Fatalf("timeline changed: %s", got)
	}
	var phase string
	if err = db.Pool.QueryRow(ctx, `SELECT phase FROM session_archive_bundles WHERE session_id=$1`, snapshot.SessionID).Scan(&phase); err != nil || (phase != "committed" && phase != "verified") {
		t.Fatalf("durable archive phase %q: %v", phase, err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM session_source_recoveries WHERE session_id=$1 AND recovery_id=$2`, snapshot.SessionID, recovery.RecoveryID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("archive publication lost recovery receipt: %d %v", count, err)
	}
}
