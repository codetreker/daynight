package sessionrelay

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage/local"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
)

func archiveFixture(t *testing.T) (fixture, sp.Snapshot, []byte) {
	t.Helper()
	f := setup(t)
	ctx := context.Background()
	v, err := f.s.Register(ctx, f.p, f.project, f.task, f.r)
	if err != nil {
		t.Fatal(err)
	}
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
	entry := localEntry(t, "1")
	doc := sp.ArchiveDocument{Fence: v.Fence, SchemaVersion: 1, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, Provider: v.Identity.Provider, Entries: []sp.TimelineEntry{entry}, Resources: []sp.ArchiveResource{}}
	return f, v, encode(doc)
}
func archiveTerminal(t *testing.T, f fixture) {
	t.Helper()
	if _, err := f.s.DB.Pool.Exec(context.Background(), `UPDATE tasks SET status='done' WHERE id=$1`, f.task); err != nil {
		t.Fatal(err)
	}
}
func TestArchiveImmutableReadAfterControllerAndClaimDisappear(t *testing.T) {
	f, v, data := archiveFixture(t)
	ctx := context.Background()
	status, err := f.s.ArchiveStatus(ctx, f.p, f.project, f.task, v.SessionID)
	if err != nil || status.State != "unavailable" {
		t.Fatal(status, err)
	}
	if _, err = f.s.ArchiveContent(ctx, f.p, f.project, f.task, v.SessionID); err == nil {
		t.Fatal("missing archive read")
	}
	if _, err = f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data); err == nil {
		t.Fatal("active archive accepted")
	}
	update := sp.ArchiveUpdate{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, State: "pending"}
	if status, err = f.s.UpdateArchive(ctx, f.p, f.project, f.task, v.SessionID, update); err != nil || status.State != "pending" {
		t.Fatal(status, err)
	}
	archiveTerminal(t, f)
	status, err = f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data)
	if err != nil || status.State != "ready" || status.SHA256 == nil {
		t.Fatal(status, err)
	}
	if _, err = f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data); err != nil {
		t.Fatal("identical retry", err)
	}
	if _, err = f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, append(data, ' ')); err == nil {
		t.Fatal("different bytes replaced immutable archive")
	}
	if status, err = f.s.UpdateArchive(ctx, f.p, f.project, f.task, v.SessionID, update); err != nil || status.State != "ready" {
		t.Fatal("ready downgraded", status, err)
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `UPDATE tasks SET properties=jsonb_set(properties::jsonb,'{worker,claimId}',to_jsonb($2::text)) WHERE id=$1`, f.task, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	// A fresh service has no controller connection or live in-memory session state.
	restarted := New(f.s.DB, f.s.files)
	got, err := restarted.ArchiveContent(ctx, f.p, f.project, f.task, v.SessionID)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatal("offline archive", err)
	}
	if _, err = restarted.Submit(ctx, f.p, f.project, f.task, v.SessionID, sp.Command{Fence: v.Fence, Kind: "refresh_controls", OperationID: uuid.NewString()}); err == nil {
		t.Fatal("archive authorized control")
	}
	if _, err = restarted.ArchiveStatus(ctx, f.p, uuid.NewString(), f.task, v.SessionID); err == nil {
		t.Fatal("wrong task scope")
	}
	if _, err = restarted.ArchiveStatus(ctx, f.p, "", "", v.SessionID); err == nil {
		t.Fatal("task archive in test scope")
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM project_members WHERE project_id=$1 AND user_id=$2`, f.project, f.p.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err = restarted.ArchiveContent(ctx, f.p, f.project, f.task, v.SessionID); err == nil {
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
	ctx := context.Background()
	archiveTerminal(t, f)
	storage := &failingArchiveStorage{Storage: f.s.files, fail: true}
	f.s.files = storage
	if _, err := f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data); err == nil {
		t.Fatal("failed put succeeded")
	}
	code := "upload_failed"
	u := sp.ArchiveUpdate{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, State: "failed", ErrorCode: &code}
	if s, err := f.s.UpdateArchive(ctx, f.p, f.project, f.task, v.SessionID, u); err != nil || s.State != "failed" {
		t.Fatal(s, err)
	}
	storage.fail = false
	status, err := f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data)
	if err != nil {
		t.Fatal(err)
	}
	path := v.SessionID + "/" + *status.SHA256 + ".json"
	if _, err = storage.Put(ctx, archiveBucket, path, strings.NewReader("corrupt")); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.ArchiveContent(ctx, f.p, f.project, f.task, v.SessionID); err == nil {
		t.Fatal("corrupt file returned")
	}
	if err = storage.Delete(ctx, archiveBucket, path); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.ArchiveContent(ctx, f.p, f.project, f.task, v.SessionID); err == nil {
		t.Fatal("missing file returned")
	}
}
func TestArchiveUploadFencingAndOwner(t *testing.T) {
	f, v, data := archiveFixture(t)
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
			if _, err := f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, encode(bad)); err == nil {
				t.Fatal("bad fence accepted")
			}
		})
	}
	if _, err = f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, []byte("{}")); err == nil {
		t.Fatal("bad document accepted")
	}
	wrong := f.p
	wrong.UserID = uuid.NewString()
	if _, err = f.s.PutArchive(ctx, wrong, f.project, f.task, v.SessionID, data); err == nil {
		t.Fatal("wrong owner")
	}
	if err = archiveWriter(core.Principal{Kind: core.SessionCredential, UserID: f.p.UserID}, &record{Owner: f.p.UserID}, v.Fence, "", ""); err == nil {
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
	reg := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "copilot", InitialInput: "none"}
	v, err := f.s.RegisterTest(ctx, f.p, reg)
	if err != nil {
		t.Fatal(err)
	}
	doc := sp.ArchiveDocument{Fence: v.Fence, SchemaVersion: 1, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, Provider: reg.Provider, Entries: []sp.TimelineEntry{}, Resources: []sp.ArchiveResource{}}
	data := encode(doc)
	if _, err = f.s.PutArchive(ctx, f.p, "", "", v.SessionID, data); err == nil {
		t.Fatal("live test archive accepted")
	}
	stop := sp.TestStop{Fence: v.Fence, Protocol: sp.Protocol, ControllerID: reg.ControllerID, ControllerInstanceID: reg.ControllerInstanceID, StopProof: sp.StopProof{Kind: "never_started", RecordID: uuid.NewString(), PreviousControllerInstanceID: reg.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	if _, err = f.s.StopTest(ctx, f.p, v.SessionID, stop); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.PutArchive(ctx, f.p, "", "", v.SessionID, data); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.ArchiveContent(ctx, f.p, "", "", v.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.DB.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.p.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.ArchiveContent(ctx, f.p, "", "", v.SessionID); err == nil {
		t.Fatal("revoked credential")
	}
}

func TestArchiveMemberCanReadButCannotPublish(t *testing.T) {
	f, v, data := archiveFixture(t)
	ctx := context.Background()
	archiveTerminal(t, f)
	member := core.Principal{Kind: core.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1::uuid,($1::uuid)::text,now(),now())`, []any{member.UserID}},
		{`INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1::uuid,$2,sha256(($1::uuid)::text::bytea),'archive reader',now())`, []any{member.CredentialID, member.UserID}},
		{`INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'admin')`, []any{f.project, member.UserID}},
	} {
		if _, err := f.s.DB.Pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.s.PutArchive(ctx, member, f.project, f.task, v.SessionID, data); err == nil {
		t.Fatal("another admin published archive")
	}
	update := sp.ArchiveUpdate{Fence: v.Fence, ControllerID: v.Identity.ControllerID, ControllerInstanceID: v.Identity.ControllerInstanceID, State: "pending"}
	if _, err := f.s.UpdateArchive(ctx, member, f.project, f.task, v.SessionID, update); err == nil {
		t.Fatal("another admin changed archive state")
	}
	if _, err := f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data); err != nil {
		t.Fatal(err)
	}
	if got, err := f.s.ArchiveContent(ctx, member, f.project, f.task, v.SessionID); err != nil || !bytes.Equal(got, data) {
		t.Fatal("member cannot read archive", err)
	}
	update.ExecutionGeneration = "2"
	if _, err := f.s.UpdateArchive(ctx, f.p, f.project, f.task, v.SessionID, update); err == nil {
		t.Fatal("stale update fence")
	}
}

func TestArchiveEstablishesMissingNativeIdentityAtomically(t *testing.T) {
	f, v, data := archiveFixture(t)
	ctx := context.Background()
	doc, err := sp.DecodeArchive(data)
	if err != nil {
		t.Fatal(err)
	}
	native := "native-created-during-disconnection"
	doc.NativeSessionID = &native
	data = encode(doc)
	if _, err = f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data); err == nil {
		t.Fatal("active archive established identity")
	}
	archiveTerminal(t, f)
	files := f.s.files
	f.s.files = &failingArchiveStorage{Storage: files, fail: true}
	if _, err = f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data); err == nil {
		t.Fatal("storage failure ignored")
	}
	var before *string
	if err = f.s.DB.Pool.QueryRow(ctx, `SELECT snapshot->'identity'->>'nativeSessionId' FROM task_sessions WHERE id=$1`, v.SessionID).Scan(&before); err != nil || before != nil {
		t.Fatal("failed archive changed native identity", before, err)
	}
	f.s.files = files
	// Treat the first acknowledgement as lost and retry the exact staged file.
	if _, err = f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data); err != nil {
		t.Fatal(err)
	}
	if _, err = f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, data); err != nil {
		t.Fatal("lost reply retry", err)
	}
	current, err := f.s.Current(ctx, f.p, f.project, f.task)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := current["session"].(sp.Snapshot)
	if snapshot.Identity.NativeSessionID == nil || *snapshot.Identity.NativeSessionID != native {
		t.Fatal("final native identity missing")
	}
	foreign := "different-native-session"
	doc.NativeSessionID = &foreign
	if _, err = f.s.PutArchive(ctx, f.p, f.project, f.task, v.SessionID, encode(doc)); err == nil {
		t.Fatal("replaced established native identity")
	}
}
