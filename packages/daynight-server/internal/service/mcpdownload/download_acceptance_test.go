package mcpdownload

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

type acceptanceFixture struct {
	db          *postgres.Store
	files       *local.Storage
	attachments *attachment.Attachments
	lifecycle   *mcptransfer.Lifecycle
	service     *Service
	actor       mcptransfer.Actor
	input       Input
}

func newAcceptanceFixture(t *testing.T) acceptanceFixture {
	t.Helper()
	tasks, db, project, _, session := testsupport.TaskService(t)
	task := testsupport.CreateTask(t, tasks, session, project.ID, "download acceptance")
	id := uuid.NewString()
	hash := sha256.Sum256([]byte(id))
	if _, err := db.Pool.Exec(t.Context(), `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'test',now())`, id, session.UserID, hash[:]); err != nil {
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
	actor := mcptransfer.Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: session.UserID, CredentialID: id}, AuthorityKind: "pat", AuthorityID: id}
	return acceptanceFixture{db, files, attachments, lifecycle, New(attachments, lifecycle, files), actor, Input{ProjectID: project.ID, TaskID: task.ID, Path: "file"}}
}

func (f acceptanceFixture) put(t *testing.T, data []byte) {
	t.Helper()
	if _, _, err := f.attachments.Put(t.Context(), f.actor.Principal, f.input.ProjectID, f.input.TaskID, f.input.Path, "application/octet-stream", bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
}

type heldSource struct {
	Opener
	opened  chan struct{}
	release chan struct{}
	calls   atomic.Int32
}

func (h *heldSource) OpenBounded(ctx context.Context, p model.Principal, project, task, path string, limit int) (model.Attachment, filestorage.Object, error) {
	a, object, err := h.Opener.OpenBounded(ctx, p, project, task, path, limit)
	if err != nil {
		return a, object, err
	}
	if h.calls.Add(1) == 1 {
		return a, object, nil
	}
	close(h.opened)
	select {
	case <-h.release:
		return a, object, nil
	case <-ctx.Done():
		_ = object.Body.Close()
		return model.Attachment{}, filestorage.Object{}, ctx.Err()
	}
}

func TestDownloadConcurrentOverwriteAndRestart(t *testing.T) {
	f := newAcceptanceFixture(t)
	original := bytes.Repeat([]byte("original\x00sequence"), 50000)
	replacement := bytes.Repeat([]byte("replacement\xff"), 60000)
	f.put(t, original)
	held := &heldSource{Opener: f.attachments, opened: make(chan struct{}), release: make(chan struct{})}
	svc := New(held, f.lifecycle, f.files)
	in := f.input
	in.Action, in.TransferID = "open", uuid.NewString()
	type result struct {
		data map[string]any
		err  error
	}
	resultCh := make(chan result, 1)
	go func() { data, err := svc.Read(t.Context(), f.actor, in); resultCh <- result{data, err} }()
	select {
	case <-held.opened:
	case <-time.After(10 * time.Second):
		t.Fatal("source open timed out")
	}
	f.put(t, replacement)
	close(held.release)
	var opened result
	select {
	case opened = <-resultCh:
	case <-time.After(10 * time.Second):
		t.Fatal("snapshot timed out")
	}
	sum := sha256.Sum256(original)
	if opened.err != nil || opened.data["state"] != "readable" || opened.data["sha256"] != hex.EncodeToString(sum[:]) {
		t.Fatalf("open: %#v %v", opened.data, opened.err)
	}
	if err := f.lifecycle.Close(t.Context()); err != nil {
		t.Fatal(err)
	}
	restarted, err := mcptransfer.New(f.db, f.files, f.files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := restarted.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	svc = New(f.attachments, restarted, f.files)
	for i := 0; i < 6; i++ {
		again, err := svc.Read(t.Context(), f.actor, in)
		if err != nil || again["sha256"] != opened.data["sha256"] {
			t.Fatalf("repeat after restart %d: %#v %v", i, again, err)
		}
	}
	for i := 0; i < 3; i++ {
		other := in
		other.TransferID = uuid.NewString()
		if _, err := svc.Read(t.Context(), f.actor, other); err != nil {
			t.Fatalf("slot %d: %v", i, err)
		}
	}
	fifth := in
	fifth.TransferID = uuid.NewString()
	if _, err := svc.Read(t.Context(), f.actor, fifth); err == nil {
		t.Fatal("fifth active transfer accepted")
	}
	chunk := Input{ProjectID: in.ProjectID, TaskID: in.TaskID, TransferID: in.TransferID, Action: "chunk", Format: "base64", MaxBytes: 65536}
	hash := sha256.New()
	for offset := 0; offset < len(original); {
		chunk.Offset = strconv.Itoa(offset)
		part, err := svc.Read(t.Context(), f.actor, chunk)
		if err != nil {
			t.Fatal(err)
		}
		b, err := base64.StdEncoding.DecodeString(part["contentBase64"].(string))
		if err != nil || len(b) == 0 {
			t.Fatalf("chunk: %v %#v", err, part)
		}
		_, _ = hash.Write(b)
		offset += len(b)
		if part["nextOffset"] != strconv.Itoa(offset) || part["eof"] != (offset == len(original)) {
			t.Fatalf("chunk range: %#v", part)
		}
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != opened.data["sha256"] {
		t.Fatalf("snapshot hash %s vs %s", got, opened.data["sha256"])
	}
}

func TestDownloadOAuthGrantAndRevocation(t *testing.T) {
	f := newAcceptanceFixture(t)
	f.put(t, []byte("secret snapshot"))
	grant, otherGrant := uuid.NewString(), uuid.NewString()
	for _, id := range []string{grant, otherGrant} {
		if _, err := f.db.Pool.Exec(t.Context(), `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at) VALUES($1,$2,'test','{}','https://example.test/mcp','daynight:mcp',now(),now()+interval '1 hour')`, id, f.actor.Principal.UserID); err != nil {
			t.Fatal(err)
		}
	}
	newActor := func(grantID string) mcptransfer.Actor {
		id := uuid.NewString()
		hash := sha256.Sum256([]byte(id))
		if _, err := f.db.Pool.Exec(t.Context(), `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,now(),now()+interval '30 minutes')`, id, grantID, f.actor.Principal.UserID, hash[:]); err != nil {
			t.Fatal(err)
		}
		return mcptransfer.Actor{Principal: model.Principal{Kind: model.OAuthCredential, UserID: f.actor.Principal.UserID, CredentialID: id}, AuthorityKind: "oauth", AuthorityID: grantID}
	}
	first, replacement, other := newActor(grant), newActor(grant), newActor(otherGrant)
	in := f.input
	in.Action, in.TransferID = "open", uuid.NewString()
	if _, err := f.service.Read(t.Context(), first, in); err != nil {
		t.Fatal(err)
	}
	in.Action, in.Offset, in.Format = "chunk", "0", "base64"
	if _, err := f.service.Read(t.Context(), replacement, in); err != nil {
		t.Fatalf("same grant new token: %v", err)
	}
	if _, err := f.service.Read(t.Context(), other, in); err == nil {
		t.Fatal("different grant accepted")
	}
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE oauth_grants SET revoked_at=now() WHERE id=$1`, grant); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"chunk", "close"} {
		in.Action = action
		if _, err := f.service.Read(t.Context(), replacement, in); err == nil {
			t.Fatal(fmt.Sprintf("revoked grant accepted for %s", action))
		}
	}
}
