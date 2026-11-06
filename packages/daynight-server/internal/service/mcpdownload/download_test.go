package mcpdownload

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

type fixture struct {
	service     *Service
	attachments *attachment.Attachments
	lifecycle   *mcptransfer.Lifecycle
	actor       mcptransfer.Actor
	input       Input
	db          *postgres.Store
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	tasks, db, project, _, session := testsupport.TaskService(t)
	task := testsupport.CreateTask(t, tasks, session, project.ID, "download")
	id := uuid.NewString()
	hash := sha256.Sum256([]byte(id))
	if _, err := db.Pool.Exec(t.Context(), `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'test',now())`, id, session.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	actor := mcptransfer.Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: session.UserID, CredentialID: id}, AuthorityKind: "pat", AuthorityID: id}
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	lifecycle, err := mcptransfer.New(db, files, files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := lifecycle.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	attachments := attachment.NewAttachments(db, db, files)
	return fixture{New(attachments, lifecycle, files), attachments, lifecycle, actor, Input{ProjectID: project.ID, TaskID: task.ID, Path: "file"}, db}
}
func (f fixture) put(t *testing.T, data []byte) {
	t.Helper()
	if _, _, err := f.attachments.Put(t.Context(), f.actor.Principal, f.input.ProjectID, f.input.TaskID, f.input.Path, "application/octet-stream", bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
}
func (f fixture) read(t *testing.T, in Input) map[string]any {
	t.Helper()
	r, err := f.service.Read(t.Context(), f.actor, in)
	if err != nil {
		t.Fatalf("read %s: %v", in.Action, err)
	}
	return r
}
func TestSnapshotRetainsBytesAndReportsRanges(t *testing.T) {
	f := newFixture(t)
	original := []byte("a界b\x00tail")
	f.put(t, original)
	inspect := f.read(t, f.input)
	if inspect["contentIncluded"] != false || inspect["contentRef"] == nil {
		t.Fatalf("inspect: %#v", inspect)
	}
	in := f.input
	in.Action = "open"
	in.TransferID = uuid.NewString()
	opened := f.read(t, in)
	sum := sha256.Sum256(original)
	if opened["state"] != "readable" || opened["sha256"] != hex.EncodeToString(sum[:]) || opened["totalBytes"] != "10" {
		t.Fatalf("open: %#v", opened)
	}
	f.put(t, []byte("replacement"))
	again := f.read(t, in)
	if again["sha256"] != opened["sha256"] {
		t.Fatalf("duplicate open recopied: %#v", again)
	}
	in.Action = "chunk"
	in.Offset = "0"
	in.MaxBytes = 3
	in.Format = "text"
	first := f.read(t, in)
	if first["text"] != "a" || first["nextOffset"] != "1" || first["readBytes"] != "1" || first["eof"] != false {
		t.Fatalf("text boundary: %#v", first)
	}
	in.Offset = "1"
	in.MaxBytes = MaxChunkBytes
	in.Format = "base64"
	rest := f.read(t, in)
	decoded, err := base64.StdEncoding.DecodeString(rest["contentBase64"].(string))
	if err != nil || !bytes.Equal(decoded, original[1:]) || rest["eof"] != true {
		t.Fatalf("range: %#v %v", rest, err)
	}
	in.Offset = "10"
	eof := f.read(t, in)
	if eof["readBytes"] != "0" || eof["eof"] != true {
		t.Fatalf("EOF: %#v", eof)
	}
	in.Offset = "11"
	if _, err := f.service.Read(t.Context(), f.actor, in); err == nil {
		t.Fatal("past EOF accepted")
	}
	in.Action = "close"
	in.Offset = ""
	result := f.read(t, in)
	if result["state"] != "cleanup_pending" || result["cleanupState"] != "pending" {
		t.Fatalf("close: %#v", result)
	}
	if err := f.lifecycle.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	result = f.read(t, in)
	if result["state"] != "closed" || result["cleanupState"] != "complete" {
		t.Fatalf("closed: %#v", result)
	}
	in = f.input
	in.Action = "inline"
	in.Format = "text"
	if got := f.read(t, in)["text"]; got != "replacement" {
		t.Fatalf("close removed target: %v", got)
	}
}
func TestInlineLimitsAndInvalidUTF8(t *testing.T) {
	f := newFixture(t)
	f.put(t, []byte{'a', 0xff})
	in := f.input
	in.Action = "inline"
	r := f.read(t, in)
	if r["contentIncluded"] != false || r["requiresExplicitBinaryRead"] != true || r["text"] != nil {
		t.Fatalf("binary auto: %#v", r)
	}
	in.Format = "text"
	if _, err := f.service.Read(t.Context(), f.actor, in); err == nil {
		t.Fatal("invalid text accepted")
	}
	in.Format = "base64"
	r = f.read(t, in)
	if r["contentBase64"] != "Yf8=" {
		t.Fatalf("binary: %#v", r)
	}
	in.MaxBytes = 1
	if _, err := f.service.Read(t.Context(), f.actor, in); err == nil {
		t.Fatal("oversized inline accepted")
	}
}
func TestTextPrefix(t *testing.T) {
	cases := []struct {
		input string
		end   bool
		n     int
		ok    bool
	}{{"a\xe7\x95", false, 1, true}, {"a\xff", false, 0, false}, {"\xe7", false, 0, false}, {"a\xe7", true, 0, false}, {"a界", true, 4, true}, {"", true, 0, true}, {"a\xef\xbf\xbd", true, 4, true}}
	for _, c := range cases {
		n, ok := textPrefix([]byte(c.input), c.end)
		if n != c.n || ok != c.ok {
			t.Errorf("%q: %d %v", c.input, n, ok)
		}
	}
}
func TestOwnershipBindingAndPreparing(t *testing.T) {
	f := newFixture(t)
	f.put(t, []byte("original"))
	in := f.input
	in.Action = "open"
	in.TransferID = uuid.NewString()
	binding := mcptransfer.Binding{ID: in.TransferID, Direction: "download", ProjectID: in.ProjectID, TaskID: in.TaskID, Path: in.Path}
	if _, created, err := f.lifecycle.OpenRecord(t.Context(), f.actor, binding); err != nil || !created {
		t.Fatalf("record: %v", err)
	}
	r := f.read(t, in)
	if r["state"] != "preparing" || r["sha256"] != nil || r["eof"] != nil {
		t.Fatalf("preparing: %#v", r)
	}
	other := f.actor
	other.AuthorityID = uuid.NewString()
	other.Principal.CredentialID = other.AuthorityID
	if _, err := f.service.Read(t.Context(), other, in); err == nil {
		t.Fatal("different credential accepted")
	}
	in.Path = "other"
	if _, err := f.service.Read(t.Context(), f.actor, in); !errors.Is(err, mcptransfer.ErrConflict) {
		t.Fatalf("binding: %v", err)
	}
	in.Path = "file"
	in.Action = "chunk"
	in.Offset = "0"
	if _, err := f.service.Read(t.Context(), f.actor, in); err == nil || !strings.Contains(err.Error(), "not readable") {
		t.Fatalf("preparing chunk: %v", err)
	}
}
