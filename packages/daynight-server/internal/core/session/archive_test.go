package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func archiveFixture(t *testing.T) (fixture, sp.Snapshot, []byte) {
	t.Helper()
	f := setup(t)
	ctx := context.Background()
	phase := f.RegistrationPhase(ctx, map[string]int{"InsertTaskSession": 1})
	v, err := f.s.Register(phase, f.p, f.project, f.task, f.r)
	f.dao.FinishContext(phase)
	if err != nil {
		t.Fatal(err)
	}
	f.SelectRegistrationWrite(t)
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	f.s.files = files
	configureArchiveFixture(f)
	entry := localEntry(t, "1")
	doc := sp.ArchiveDocument{Fence: v.Fence, SchemaVersion: 1, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: v.Identity.Provider, Entries: []sp.TimelineEntry{entry}, Resources: []sp.ArchiveResource{}}
	return f, v, encode(doc)
}
func archiveTerminal(t *testing.T, f fixture) {
	t.Helper()
	f.data.Task.Status = "done"
}
func TestArchiveImmutableReadAfterControllerAndClaimDisappear(t *testing.T) {
	f, v, data := archiveFixture(t)
	f.dao.Expect("SetSessionArchiveReady", 1)
	f.dao.Expect("SetSessionArchiveState", 1)
	ctx := context.Background()
	status, err := fixtureArchiveStatus(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, nil)
	if err != nil || status.State != "unavailable" {
		t.Fatal(status, err)
	}
	if _, err = fixtureArchiveContent(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, nil); err == nil {
		t.Fatal("missing archive read")
	}
	if _, err = fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, data, map[string]int{"SessionArchive": 0}); err == nil {
		t.Fatal("active archive accepted")
	}
	update := sp.ArchiveUpdate{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, State: "pending"}
	if status, err = fixtureArchiveUpdate(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, update, map[string]int{"SetSessionArchiveState": 1}); err != nil || status.State != "pending" {
		t.Fatal(status, err)
	}
	acceptArchiveState(t, f, "pending")
	archiveTerminal(t, f)
	status, err = fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, data, map[string]int{"SetSessionArchiveReady": 1})
	if err != nil || status.State != "ready" || status.SHA256 == nil {
		t.Fatal(status, err)
	}
	acceptArchiveWrites(t, f, v.SessionID, data)
	if _, err = fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, data, nil); err != nil {
		t.Fatal("identical retry", err)
	}
	if _, err = fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, append(data, ' '), nil); err == nil {
		t.Fatal("different bytes replaced immutable archive")
	}
	if status, err = fixtureArchiveUpdate(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, update, nil); err != nil || status.State != "ready" {
		t.Fatal("ready downgraded", status, err)
	}
	worker := *f.data.Task.Worker
	worker.ClaimID = uuid.NewString()
	f.data.Task.Worker = &worker
	// A fresh service has no controller connection or live in-memory session state.
	restarted := New(f.writer, f.s.files)
	got, err := fixtureArchiveContent(f, restarted, ctx, f.p, f.project, f.task, v.SessionID, nil)
	if err != nil || !bytes.Equal(got.Data, data) {
		t.Fatal("offline archive", err)
	}
	if err := got.Close(); err != nil {
		t.Fatal(err)
	}
	phase := f.BrowserPhase(ctx, nil)
	_, err = restarted.Submit(phase, f.p, f.project, f.task, v.SessionID, sp.Command{Fence: v.Fence, Kind: "refresh_controls", OperationID: uuid.NewString()})
	f.dao.FinishContext(phase)
	if err == nil {
		t.Fatal("archive authorized control")
	}
	if _, err = fixtureArchiveStatus(f, restarted, ctx, f.p, uuid.NewString(), f.task, v.SessionID, archiveTaskRefusal()); err == nil {
		t.Fatal("wrong task scope")
	}
	if _, err = fixtureArchiveStatus(f, restarted, ctx, f.p, "", "", v.SessionID, map[string]int{"LockArchiveTask": 0, "LockCredential": 0, "ProjectAccess": 0, "SessionArchive": 0}); err == nil {
		t.Fatal("task archive in test scope")
	}
	f.dao.ProjectAccessFn = func(context.Context, string, string) (model.ProjectAccess, error) {
		return model.ProjectAccess{}, model.ErrNotFound
	}
	if _, err = fixtureArchiveContent(f, restarted, ctx, f.p, f.project, f.task, v.SessionID, archivePreflightOnly(1, 1, 0)); err == nil {
		t.Fatal("removed member read archive")
	}
}

type failingArchiveStorage struct {
	filestorage.Storage
	fail bool
}

func (s *failingArchiveStorage) Put(ctx context.Context, bucket, path string, r io.Reader) (filestorage.FileInfo, error) {
	if s.fail {
		return filestorage.FileInfo{}, errors.New("storage failed")
	}
	return s.Storage.Put(ctx, bucket, path, r)
}
func TestArchiveStorageFailureAndIntegrity(t *testing.T) {
	f, v, data := archiveFixture(t)
	f.dao.Expect("SetSessionArchiveReady", 1)
	f.dao.Expect("SetSessionArchiveState", 1)
	ctx := context.Background()
	archiveTerminal(t, f)
	storage := &failingArchiveStorage{Storage: f.s.files, fail: true}
	f.s.files = storage
	if _, err := fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, data, nil); err == nil {
		t.Fatal("failed put succeeded")
	}
	code := "upload_failed"
	u := sp.ArchiveUpdate{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, State: "failed", ErrorCode: &code}
	if s, err := fixtureArchiveUpdate(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, u, map[string]int{"SetSessionArchiveState": 1}); err != nil || s.State != "failed" {
		t.Fatal(s, err)
	}
	acceptArchiveState(t, f, "failed")
	storage.fail = false
	status, err := fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, data, map[string]int{"SetSessionArchiveReady": 1})
	if err != nil {
		t.Fatal(err)
	}
	acceptArchiveWrites(t, f, v.SessionID, data)
	path := "projects/" + f.project + "/" + v.SessionID[:2] + "/" + v.SessionID + "/" + *status.SHA256 + ".json"
	if _, err = storage.Put(ctx, archiveBucket, path, strings.NewReader("corrupt")); err != nil {
		t.Fatal(err)
	}
	if _, err = fixtureArchiveContent(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, nil); err == nil {
		t.Fatal("corrupt file returned")
	}
	if err = storage.Delete(ctx, archiveBucket, path); err != nil {
		t.Fatal(err)
	}
	if _, err = fixtureArchiveContent(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, nil); err == nil {
		t.Fatal("missing file returned")
	}
}
func TestArchiveUploadFencingAndOwner(t *testing.T) {
	f, v, data := archiveFixture(t)
	f.dao.Expect("SetSessionArchiveReady", 0)
	f.dao.Expect("SetSessionArchiveState", 0)
	ctx := context.Background()
	archiveTerminal(t, f)
	doc, err := sp.DecodeArchive(data)
	if err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*sp.ArchiveDocument){"generation": func(d *sp.ArchiveDocument) { d.ExecutionGeneration = "2" }, "instance": func(d *sp.ArchiveDocument) { d.ControllerInstanceID = uuid.NewString() }, "provider": func(d *sp.ArchiveDocument) { d.Provider = "claude" }, "session": func(d *sp.ArchiveDocument) { d.SessionID = uuid.NewString() }} {
		t.Run(name, func(t *testing.T) {
			bad := doc
			mutate(&bad)
			if _, err := fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, encode(bad), map[string]int{"SessionArchive": 0}); err == nil {
				t.Fatal("bad fence accepted")
			}
		})
	}
	if _, err = fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, []byte("{}"), archivePreflightOnly(1, 1, 1)); err == nil {
		t.Fatal("bad document accepted")
	}
	wrong := f.p
	wrong.UserID = uuid.NewString()
	if _, err = fixtureArchivePut(f, f.s, ctx, wrong, f.project, f.task, v.SessionID, data, archivePreflightOnly(1, 0, 0)); err == nil {
		t.Fatal("wrong owner")
	}
	if err = archiveWriter(model.Principal{Kind: model.SessionCredential, UserID: f.p.UserID}, &record{Owner: f.p.UserID}, v.Fence, "", ""); err == nil {
		t.Fatal("browser uploader")
	}
}
func TestStandaloneArchiveAfterStop(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	f.s.files = files
	f.dao.Expect("SetSessionArchiveReady", 1)
	f.dao.Expect("SetSessionArchiveState", 0)
	reg := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "copilot", InitialInput: "none"}
	phase := f.dao.ContextPhase(ctx, map[string]int{"LockCredential": 1, "LockTestOwner": 1, "FindTestRegistration": 1, "InsertTestSession": 1})
	v, err := f.s.RegisterTest(phase, f.p, reg)
	f.dao.FinishContext(phase)
	if err != nil {
		t.Fatal(err)
	}
	f.SelectRegistrationWrite(t)
	configureArchiveFixture(f)
	doc := sp.ArchiveDocument{Fence: v.Fence, SchemaVersion: 1, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, Provider: reg.Provider, Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}}
	data := encode(doc)
	if _, err = fixtureArchivePut(f, f.s, ctx, f.p, "", "", v.SessionID, data, map[string]int{"SessionArchive": 0}); err == nil {
		t.Fatal("live test archive accepted")
	}
	stop := sp.TestStop{Fence: v.Fence, Protocol: sp.Protocol, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: reg.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	phase = f.BrowserPhase(ctx, map[string]int{"StoppingTestOperations": 1, "SetTestSessionStop": 1, "SaveSession": 1})
	_, err = f.s.StopTest(phase, f.p, v.SessionID, stop)
	f.dao.FinishContext(phase)
	if err != nil {
		t.Fatal(err)
	}
	if f.writes.Session == nil || f.writes.Session.Snapshot.Lifecycle != "archived" {
		t.Fatal("stop did not propose archived lifecycle")
	}
	f.SelectSessionWrite(t)
	if _, err = fixtureArchivePut(f, f.s, ctx, f.p, "", "", v.SessionID, data, map[string]int{"SetSessionArchiveReady": 1}); err != nil {
		t.Fatal(err)
	}
	acceptArchiveWrites(t, f, v.SessionID, data)
	physicalPath := f.data.ArchivePath
	expected := "users/" + f.p.UserID + "/" + v.SessionID[:2] + "/" + v.SessionID + "/"
	if !strings.HasPrefix(physicalPath, expected) {
		t.Fatalf("standalone archive is outside its user's shard: %s", physicalPath)
	}
	content, err := fixtureArchiveContent(f, f.s, ctx, f.p, "", "", v.SessionID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = content.Close(); err != nil {
		t.Fatal(err)
	}
	f.dao.ReadCredentialFn = func(context.Context, model.Principal, time.Time) error { return model.ErrNotFound }
	if _, err = fixtureArchiveContent(f, f.s, ctx, f.p, "", "", v.SessionID, archivePreflightOnly(1, 0, 0)); err == nil {
		t.Fatal("revoked credential")
	}
}

func TestArchiveMemberCanReadButCannotPublish(t *testing.T) {
	f, v, data := archiveFixture(t)
	f.dao.Expect("SetSessionArchiveReady", 1)
	f.dao.Expect("SetSessionArchiveState", 0)
	ctx := context.Background()
	archiveTerminal(t, f)
	member := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	allowFixtureProject(t, f, member, "admin")
	if _, err := fixtureArchivePut(f, f.s, ctx, member, f.project, f.task, v.SessionID, data, archivePreflightOnly(1, 1, 1)); err == nil {
		t.Fatal("another admin published archive")
	}
	update := sp.ArchiveUpdate{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, State: "pending"}
	if _, err := fixtureArchiveUpdate(f, f.s, ctx, member, f.project, f.task, v.SessionID, update, map[string]int{"SessionArchive": 0}); err == nil {
		t.Fatal("another admin changed archive state")
	}
	if _, err := fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, data, map[string]int{"SetSessionArchiveReady": 1}); err != nil {
		t.Fatal(err)
	}
	acceptArchiveWrites(t, f, v.SessionID, data)
	got, err := fixtureArchiveContent(f, f.s, ctx, member, f.project, f.task, v.SessionID, nil)
	if err != nil || !bytes.Equal(got.Data, data) {
		t.Fatal("member cannot read archive", err)
	}
	if err = got.Close(); err != nil {
		t.Fatal(err)
	}
	update.ExecutionGeneration = "2"
	if _, err := fixtureArchiveUpdate(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, update, map[string]int{"SessionArchive": 0}); err == nil {
		t.Fatal("stale update fence")
	}
}

func TestArchiveEstablishesMissingNativeIdentityAtomically(t *testing.T) {
	f, v, data := archiveFixture(t)
	f.dao.Expect("SetSessionArchiveReady", 1)
	f.dao.Expect("SetSessionArchiveState", 0)
	ctx := context.Background()
	doc, err := sp.DecodeArchive(data)
	if err != nil {
		t.Fatal(err)
	}
	native := "native-created-during-disconnection"
	doc.NativeSessionID = &native
	data = encode(doc)
	if _, err = fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, data, map[string]int{"SessionArchive": 0}); err == nil {
		t.Fatal("active archive established identity")
	}
	archiveTerminal(t, f)
	files := f.s.files
	f.s.files = &failingArchiveStorage{Storage: files, fail: true}
	if _, err = fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, data, nil); err == nil {
		t.Fatal("storage failure ignored")
	}
	if f.writes.Session != nil {
		t.Fatal("failed archive proposed native identity before storage completed")
	}
	if before := f.data.Session.Snapshot.Identity.NativeSessionID; before != nil {
		t.Fatal("failed archive changed proposed native identity", before)
	}
	f.s.files = files
	// Treat the first acknowledgement as lost and retry the exact staged file.
	if _, err = fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, data, map[string]int{"SetSessionArchiveReady": 1, "SaveSession": 1}); err != nil {
		t.Fatal(err)
	}
	if f.writes.Session == nil || f.writes.Session.Snapshot.Identity.NativeSessionID == nil || *f.writes.Session.Snapshot.Identity.NativeSessionID != native {
		t.Fatal("archive did not propose finalized native identity")
	}
	f.SelectSessionWrite(t)
	acceptArchiveWrites(t, f, v.SessionID, data)
	if _, err = fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, data, nil); err != nil {
		t.Fatal("lost reply retry", err)
	}
	phase := f.TaskPhase(ctx, map[string]int{"CurrentTaskSession": 1, "SessionBotID": 1, "LockSession": 1})
	current, err := f.s.Current(phase, f.p, f.project, f.task)
	f.dao.FinishContext(phase)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := current["session"].(sp.Snapshot)
	if snapshot.Identity.NativeSessionID == nil || *snapshot.Identity.NativeSessionID != native {
		t.Fatal("final native identity missing")
	}
	foreign := "different-native-session"
	doc.NativeSessionID = &foreign
	if _, err = fixtureArchivePut(f, f.s, ctx, f.p, f.project, f.task, v.SessionID, encode(doc), map[string]int{"SessionArchive": 0}); err == nil {
		t.Fatal("replaced established native identity")
	}
}

func configureArchiveFixture(f fixture) {
	f.data.ArchiveSessionID = f.data.Session.Snapshot.SessionID
	f.data.ArchiveMetadata = store.ArchiveMetadata{Owner: f.p.UserID, Parent: f.p.CredentialID, Project: f.project, Task: f.task, Backend: "web", TaskExists: true, ProjectLive: true, BotValid: true}
	if f.data.Session.Snapshot.TestExecutionID != "" {
		f.data.ArchiveMetadata = store.ArchiveMetadata{Owner: f.p.UserID, Parent: f.p.CredentialID, Backend: "web", Test: true, TaskExists: true, ProjectLive: true, BotValid: true}
	}
	f.data.Archive = sp.ArchiveStatus{State: "unavailable"}
	f.dao.LockTaskFn = func(ctx context.Context, project, id string) (store.SessionTask, error) {
		if project != f.project || id != f.task || f.data.TaskDeleted {
			return store.SessionTask{}, model.ErrNotFound
		}
		return f.data.Task, nil
	}
	f.dao.LockArchiveTaskFn = func(ctx context.Context, project, id string) (store.SessionTask, bool, error) {
		if project != f.project || id != f.task {
			return store.SessionTask{}, false, model.ErrNotFound
		}
		return f.data.Task, f.data.TaskDeleted, nil
	}
	f.dao.ArchiveMetadataFn = func(ctx context.Context, id string) (store.ArchiveMetadata, error) {
		if id != f.data.ArchiveSessionID {
			return store.ArchiveMetadata{}, model.ErrNotFound
		}
		return fixtureCopy(f.data.ArchiveMetadata), nil
	}
	f.dao.SessionArchiveFn = func(ctx context.Context, id string) (sp.ArchiveStatus, string, error) {
		if id != f.data.ArchiveSessionID {
			return sp.ArchiveStatus{}, "", model.ErrNotFound
		}
		return f.data.Archive, f.data.ArchivePath, nil
	}
	f.dao.SetSessionArchiveStateFn = func(ctx context.Context, id, state string, code *string) error {
		if id != f.data.ArchiveSessionID {
			return model.ErrNotFound
		}
		f.writes.ArchiveState = &sp.ArchiveStatus{State: state, ErrorCode: code}
		return nil
	}
	f.dao.SetSessionArchiveReadyFn = func(ctx context.Context, id, digest string, length int, path string) error {
		if id != f.data.ArchiveSessionID {
			return model.ErrNotFound
		}
		f.writes.ArchiveReady = &fixtureArchiveReady{SessionID: id, Digest: digest, Length: length, Path: path}
		return nil
	}
}

type fixtureArchiveReady struct {
	SessionID, Digest, Path string
	Length                  int
}

func acceptArchiveWrites(t *testing.T, f fixture, id string, data []byte) {
	t.Helper()
	write := f.writes.ArchiveReady
	if write == nil {
		t.Fatal("archive did not propose a ready record")
	}
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	prefix := "projects/" + f.project + "/"
	if f.data.ArchiveMetadata.Test {
		prefix = "users/" + f.p.UserID + "/"
	}
	path := prefix + id[:2] + "/" + id + "/" + digest + ".json"
	if write.SessionID != id || write.Digest != digest || write.Length != len(data) || write.Path != path {
		t.Fatalf("archive write = %#v, want %s %s %d %s", write, id, digest, len(data), path)
	}
	size := decimal(int64(len(data)))
	f.data.Archive = sp.ArchiveStatus{State: "ready", SHA256: &digest, ByteLength: &size}
	f.data.ArchivePath = path
	f.writes.ArchiveReady = nil
}

func acceptArchiveState(t *testing.T, f fixture, state string) {
	t.Helper()
	write := f.writes.ArchiveState
	if write == nil || write.State != state {
		t.Fatalf("archive state write = %#v, want %s", write, state)
	}
	f.data.Archive = fixtureCopy(*write)
	f.writes.ArchiveState = nil
}
