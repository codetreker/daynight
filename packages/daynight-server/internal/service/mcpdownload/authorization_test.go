package mcpdownload

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

// signalGate reports admission to the target gate before delegating the wait.
type signalGate struct {
	filestorage.Storage
	entered chan struct{}
}

type blockingRange struct {
	filestorage.TransferStorage
	entered, release chan struct{}
}

func (s blockingRange) OpenTransferRange(ctx context.Context, namespace filestorage.TransferNamespace, id string, offset, length int64) (filestorage.Object, error) {
	obj, err := s.TransferStorage.OpenTransferRange(ctx, namespace, id, offset, length)
	if err != nil {
		return obj, err
	}
	obj.Body = &blockedRangeReader{ReadCloser: obj.Body, ctx: ctx, entered: s.entered, release: s.release}
	return obj, nil
}

type blockedRangeReader struct {
	io.ReadCloser
	ctx              context.Context
	entered, release chan struct{}
	once             sync.Once
}

func (r *blockedRangeReader) Read(p []byte) (int, error) {
	r.once.Do(func() { close(r.entered) })
	select {
	case <-r.release:
		return r.ReadCloser.Read(p)
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	}
}

func TestChunkRejectsCredentialRevokedDuringRangeRead(t *testing.T) {
	tasks, db, project, _, session := testsupport.TaskService(t)
	task := testsupport.CreateTask(t, tasks, session, project.ID, "range authorization")
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
	if _, _, err := attachments.Put(t.Context(), actor.Principal, project.ID, task.ID, "secret.txt", "text/plain", strings.NewReader("private bytes")); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	service := New(attachments, lifecycle, blockingRange{TransferStorage: files, entered: entered, release: release})
	input := Input{ProjectID: project.ID, TaskID: task.ID, Path: "secret.txt", Action: "open", TransferID: uuid.NewString()}
	if _, err := service.Read(t.Context(), actor, input); err != nil {
		t.Fatal(err)
	}
	input.Action, input.Offset, input.Format = "chunk", "0", "base64"
	type result struct {
		data map[string]any
		err  error
	}
	results := make(chan result, 1)
	go func() { data, err := service.Read(t.Context(), actor, input); results <- result{data, err} }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("chunk did not reach range reader")
	}
	if _, err := db.Pool.Exec(t.Context(), `DELETE FROM personal_access_tokens WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	close(release)
	select {
	case got := <-results:
		var fault *model.Fault
		if !errors.As(got.err, &fault) || fault.Code != "unauthenticated" || got.data != nil {
			t.Fatalf("revoked credential returned data: %#v, error: %v", got.data, got.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("chunk remained blocked after range release")
	}
}

func (s signalGate) AcquireGate(ctx context.Context, domain filestorage.GateDomain, key string) (io.Closer, error) {
	if domain == filestorage.TargetGate {
		close(s.entered)
	}
	return s.Storage.AcquireGate(ctx, domain, key)
}

func TestInspectAndInlineRejectCredentialRevokedWhileWaitingForTarget(t *testing.T) {
	for _, action := range []string{"inspect", "inline"} {
		t.Run(action, func(t *testing.T) {
			tasks, db, project, _, session := testsupport.TaskService(t)
			task := testsupport.CreateTask(t, tasks, session, project.ID, "authorization")
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
			writer := attachment.NewAttachments(db, db, files)
			if _, _, err := writer.Put(t.Context(), actor.Principal, project.ID, task.ID, "secret.txt", "text/plain", strings.NewReader("private bytes")); err != nil {
				t.Fatal(err)
			}
			address, err := attachmentcore.NewAddress(project.ID, task.ID, "secret.txt")
			if err != nil {
				t.Fatal(err)
			}
			gate, err := files.AcquireGate(t.Context(), filestorage.TargetGate, address.StoragePath)
			if err != nil {
				t.Fatal(err)
			}
			defer gate.Close()
			entered := make(chan struct{})
			reader := attachment.NewAttachments(db, db, signalGate{Storage: files, entered: entered})
			service := New(reader, lifecycle, files)
			input := Input{ProjectID: project.ID, TaskID: task.ID, Path: "secret.txt", Action: action}
			type result struct {
				data map[string]any
				err  error
			}
			results := make(chan result, 1)
			go func() { data, err := service.Read(t.Context(), actor, input); results <- result{data, err} }()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("read did not reach target gate")
			}
			if _, err := db.Pool.Exec(t.Context(), `DELETE FROM personal_access_tokens WHERE id=$1`, id); err != nil {
				t.Fatal(err)
			}
			if err := gate.Close(); err != nil {
				t.Fatal(err)
			}
			select {
			case got := <-results:
				var fault *model.Fault
				if !errors.As(got.err, &fault) || fault.Code != "unauthenticated" || got.data != nil {
					t.Fatalf("revoked credential returned data: %#v, error: %v", got.data, got.err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("read remained blocked after gate release")
			}
		})
	}
}
