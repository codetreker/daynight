package mcptransfer

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	"github.com/google/uuid"
)

type mcpDeletedUploadDAO struct {
	store.PrivateTransferDAO
	t                                  *testing.T
	actor                              Actor
	record                             model.PrivateTransfer
	missing                            bool
	transactions, gets, authorizations int
}

func (d *mcpDeletedUploadDAO) WritePrivateTransfer(ctx context.Context, fn func(store.PrivateTransferDAO) error) (store.Completion, error) {
	d.transactions++
	if d.transactions != 1 || ctx.Err() != nil {
		d.t.Fatalf("unexpected transfer transaction: count=%d context=%v", d.transactions, ctx.Err())
	}
	err := fn(d)
	if err == nil {
		d.t.Fatal("deleted project operation completed without authorization failure")
	}
	return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
}

func (d *mcpDeletedUploadDAO) Get(ctx context.Context, id string) (model.PrivateTransfer, error) {
	d.gets++
	if d.gets != 1 || id != d.record.ID || ctx.Err() != nil {
		d.t.Fatalf("unexpected transfer read: count=%d id=%s context=%v", d.gets, id, ctx.Err())
	}
	if d.missing {
		return model.PrivateTransfer{}, model.ErrNotFound
	}
	return d.record, nil
}

func (d *mcpDeletedUploadDAO) Authorize(ctx context.Context, principal model.Principal, kind, authority, project, task string) error {
	d.authorizations++
	if d.authorizations != 1 || principal != d.actor.Principal || kind != d.actor.AuthorityKind || authority != d.actor.AuthorityID || project != d.record.ProjectID || task != d.record.TaskID || ctx.Err() != nil {
		d.t.Fatalf("unexpected deleted-project authorization: principal=%+v authority=%s/%s project=%s task=%s calls=%d", principal, kind, authority, project, task, d.authorizations)
	}
	return model.ErrNotFound
}

type mcpDeletedUploadAttachments struct {
	attachmentPut
	t             *testing.T
	actor         model.Principal
	project, task string
	puts          int
}

func (a *mcpDeletedUploadAttachments) Put(ctx context.Context, principal model.Principal, project, task, path, contentType string, body io.Reader) (model.Attachment, bool, error) {
	a.puts++
	content, err := io.ReadAll(body)
	if a.puts != 1 || principal != a.actor || project != a.project || task != a.task || path != "late.txt" || contentType != "text/plain" || string(content) != "a" || err != nil || ctx.Err() != nil {
		a.t.Fatalf("unexpected inline operation: calls=%d principal=%+v project=%s task=%s path=%s type=%s content=%q error=%v", a.puts, principal, project, task, path, contentType, content, err)
	}
	return model.Attachment{}, false, &model.Fault{Code: "not_found", Message: "Project is unavailable."}
}

func TestMCPUploadActionsRecheckDeletedProject(t *testing.T) {
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	credential := uuid.NewString()
	actor := Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: credential}, AuthorityKind: "pat", AuthorityID: credential}
	project := uuid.NewString()
	for _, taskKind := range []string{"live", "historical"} {
		t.Run(taskKind, func(t *testing.T) {
			task, id := uuid.NewString(), uuid.NewString()
			for _, action := range []string{"begin", "status", "chunk", "commit", "abort", "inline"} {
				t.Run(action, func(t *testing.T) {
					record, err := transfer.NewRecord(actor, Binding{ID: id, Direction: "upload", ProjectID: project, TaskID: task, Path: "late.txt", ContentType: "text/plain"}, time.Now().UTC())
					if err != nil {
						t.Fatal(err)
					}
					dao := &mcpDeletedUploadDAO{t: t, actor: actor, record: record, missing: action == "begin"}
					lifecycle, err := New(dao, files, files, 1<<20, 0)
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() {
						ctx, cancel := context.WithTimeout(context.Background(), time.Second)
						defer cancel()
						if err := lifecycle.Close(ctx); err != nil {
							t.Error(err)
						}
					})
					attachments := &mcpDeletedUploadAttachments{t: t, actor: actor.Principal, project: project, task: task}
					subject := NewUploads(lifecycle, files, attachments)
					input := UploadInput{Action: action, Path: "late.txt", ContentType: "text/plain", TransferID: id, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ==", TotalBytes: "0"}
					result, err := subject.Execute(t.Context(), actor, project, task, input)
					fault, known := operation.KnownFault(err)
					if !known || fault.Code != "not_found" || result != nil && result["attachment"] != nil {
						t.Fatalf("deleted project: result=%+v fault=%+v error=%v", result, fault, err)
					}
					if action == "inline" {
						if attachments.puts != 1 || dao.transactions != 0 {
							t.Fatalf("inline calls: puts=%d transactions=%d", attachments.puts, dao.transactions)
						}
					} else if dao.transactions != 1 || dao.gets != 1 || dao.authorizations != 1 || attachments.puts != 0 {
						t.Fatalf("refusal calls: transactions=%d gets=%d authorize=%d puts=%d", dao.transactions, dao.gets, dao.authorizations, attachments.puts)
					}
				})
			}
		})
	}
	for _, state := range []string{"live-project-missing", "deleted-project-missing"} {
		for _, action := range []string{"status", "chunk", "commit", "abort"} {
			t.Run(state+"/"+action, func(t *testing.T) {
				dao := &mcpDeletedUploadDAO{t: t, actor: actor, missing: true, record: model.PrivateTransfer{ID: uuid.NewString()}}
				lifecycle, err := New(dao, files, files, 1<<20, 0)
				if err != nil {
					t.Fatal(err)
				}
				defer lifecycle.Close(t.Context())
				subject := NewUploads(lifecycle, files, &mcpDeletedUploadAttachments{t: t})
				_, err = subject.Execute(t.Context(), actor, project, uuid.NewString(), UploadInput{Action: action, TransferID: dao.record.ID, ChunkID: uuid.NewString(), Offset: "0", ContentBase64: "YQ==", TotalBytes: "0"})
				fault, known := operation.KnownFault(err)
				if !known || fault.Code != "not_found" || !errors.Is(err, model.ErrNotFound) || dao.transactions != 1 || dao.gets != 1 || dao.authorizations != 0 {
					t.Fatalf("missing transfer: calls=%d/%d/%d error=%v", dao.transactions, dao.gets, dao.authorizations, err)
				}
			})
		}
	}
}
