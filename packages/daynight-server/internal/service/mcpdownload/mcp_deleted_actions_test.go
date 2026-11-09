package mcpdownload

import (
	"context"
	"errors"
	"io"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	"github.com/google/uuid"
)

type deletedDownloadLookup struct {
	method string
	record *model.PrivateTransfer
}

type deletedDownloadWriter struct {
	store.PrivateTransferDAO
	t       *testing.T
	ctx     context.Context
	actor   mcptransfer.Actor
	input   Input
	plan    []deletedDownloadLookup
	current *deletedDownloadLookup
	calls   []string
}

func (w *deletedDownloadWriter) WritePrivateTransfer(ctx context.Context, call func(store.PrivateTransferDAO) error) (store.Completion, error) {
	w.t.Helper()
	if ctx != w.ctx || len(w.plan) == 0 || w.current != nil {
		w.t.Fatalf("unexpected download transaction: context=%v remaining=%d", ctx == w.ctx, len(w.plan))
	}
	w.current, w.plan = &w.plan[0], w.plan[1:]
	err := call(w)
	if w.current != nil {
		w.t.Fatal("download transaction did not consume its DAO operation")
	}
	return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
}

func (w *deletedDownloadWriter) Get(ctx context.Context, id string) (model.PrivateTransfer, error) {
	w.t.Helper()
	if ctx != w.ctx || id != w.input.TransferID || w.current == nil || w.current.method != "get" {
		w.t.Fatalf("unexpected download lookup: id=%q", id)
	}
	step := w.current
	w.current = nil
	w.calls = append(w.calls, "get")
	if step.record == nil {
		return model.PrivateTransfer{}, model.ErrNotFound
	}
	// The existing row is independently configured; no write determines a later read.
	w.current = &deletedDownloadLookup{method: "authorize"}
	return *step.record, nil
}

func (w *deletedDownloadWriter) Authorize(ctx context.Context, principal model.Principal, kind, authority, project, task string) error {
	w.t.Helper()
	if ctx != w.ctx || principal != w.actor.Principal || kind != w.actor.AuthorityKind || authority != w.actor.AuthorityID || project != w.input.ProjectID || task != w.input.TaskID || w.current == nil || w.current.method != "authorize" {
		w.t.Fatalf("unexpected download authorization: principal=%+v authority=%s/%s project=%s task=%s", principal, kind, authority, project, task)
	}
	w.current = nil
	w.calls = append(w.calls, "authorize")
	return model.ErrNotFound
}

func (w *deletedDownloadWriter) Insert(context.Context, model.PrivateTransfer) (model.PrivateTransfer, bool, error) {
	w.t.Fatal("deleted Project allocated a download transfer")
	return model.PrivateTransfer{}, false, errors.New("unexpected transfer insert")
}

func (w *deletedDownloadWriter) Put(context.Context, model.PrivateTransfer, int64) (model.PrivateTransfer, error) {
	w.t.Fatal("deleted Project changed a download transfer")
	return model.PrivateTransfer{}, errors.New("unexpected transfer update")
}

type deletedDownloadOpener struct {
	t     *testing.T
	ctx   context.Context
	actor mcptransfer.Actor
	input Input
	want  int
	calls int
}

func (o *deletedDownloadOpener) OpenBounded(ctx context.Context, principal model.Principal, project, task, path string, limit int) (model.Attachment, filestorage.Object, error) {
	o.t.Helper()
	o.calls++
	if o.calls > o.want || ctx != o.ctx || principal != o.actor.Principal || project != o.input.ProjectID || task != o.input.TaskID || path != "content.txt" || limit != MaxContentTypeBytes {
		o.t.Fatalf("unexpected attachment operation: calls=%d project=%s task=%s path=%s limit=%d", o.calls, project, task, path, limit)
	}
	return model.Attachment{}, filestorage.Object{}, model.ErrNotFound
}

type deletedDownloadFiles struct {
	filestorage.Storage
	filestorage.TransferStorage
	t *testing.T
}

func (s deletedDownloadFiles) AcquireGate(context.Context, filestorage.GateDomain, string) (io.Closer, error) {
	s.t.Fatal("deleted Project acquired a private content gate")
	return nil, errors.New("unexpected gate acquisition")
}

func (s deletedDownloadFiles) PutTransfer(context.Context, filestorage.TransferNamespace, string, io.Reader) (filestorage.FileInfo, error) {
	s.t.Fatal("deleted Project wrote private content")
	return filestorage.FileInfo{}, errors.New("unexpected content write")
}

func (s deletedDownloadFiles) OpenTransferRange(context.Context, filestorage.TransferNamespace, string, int64, int64) (filestorage.Object, error) {
	s.t.Fatal("deleted Project read private content")
	return filestorage.Object{}, errors.New("unexpected content read")
}

func TestMCPDownloadActionsRecheckDeletedProject(t *testing.T) {
	projectID := uuid.NewString()
	for _, identity := range []struct {
		name string
		kind model.CredentialKind
		auth string
	}{{"live/PAT", model.PATCredential, "pat"}, {"historical/OAuth", model.OAuthCredential, "oauth"}} {
		t.Run(identity.name, func(t *testing.T) {
			credential, authority := uuid.NewString(), uuid.NewString()
			if identity.auth == "pat" {
				authority = credential
			}
			actor := mcptransfer.Actor{Principal: model.Principal{Kind: identity.kind, UserID: uuid.NewString(), CredentialID: credential}, AuthorityKind: identity.auth, AuthorityID: authority}
			taskID, transferID := uuid.NewString(), uuid.NewString()
			record := model.PrivateTransfer{ID: transferID, UserID: actor.Principal.UserID, AuthorityKind: actor.AuthorityKind, AuthorityID: actor.AuthorityID, Direction: "download", ProjectID: projectID, TaskID: taskID, Path: "content.txt", State: "readable"}
			for _, action := range []string{"inspect", "inline", "open-new", "open-existing", "chunk", "close"} {
				t.Run(action, func(t *testing.T) {
					ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
					defer cancel()
					input := Input{ProjectID: projectID, TaskID: taskID, Path: "content.txt", Action: action, TransferID: transferID, Offset: "0", Format: "text"}
					var plan []deletedDownloadLookup
					var wantCalls []string
					wantSource, wantAdmitted := 0, 0
					switch action {
					case "inspect", "inline":
						plan = []deletedDownloadLookup{{method: "authorize"}}
						wantCalls, wantSource = []string{"authorize"}, 1
					case "open-new":
						input.Action, input.TransferID = "open", uuid.NewString()
						plan = []deletedDownloadLookup{{method: "get"}, {method: "authorize"}, {method: "get"}}
						wantCalls, wantSource, wantAdmitted = []string{"get", "authorize", "get"}, 1, 1
					case "open-existing":
						input.Action = "open"
						plan = []deletedDownloadLookup{{method: "get", record: &record}, {method: "authorize"}, {method: "get", record: &record}}
						wantCalls, wantSource, wantAdmitted = []string{"get", "authorize", "authorize", "get", "authorize"}, 1, 1
					default:
						plan = []deletedDownloadLookup{{method: "get", record: &record}}
						wantCalls = []string{"get", "authorize"}
					}
					writer := &deletedDownloadWriter{t: t, ctx: ctx, actor: actor, input: input, plan: plan}
					opener := &deletedDownloadOpener{t: t, ctx: ctx, actor: actor, input: input, want: wantSource}
					files, err := local.New(t.TempDir())
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() {
						if err := files.Close(); err != nil {
							t.Error(err)
						}
					})
					guardedFiles := deletedDownloadFiles{Storage: files, TransferStorage: files, t: t}
					lifecycle, err := mcptransfer.New(writer, guardedFiles, guardedFiles, 1<<30, 0)
					if err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() {
						closeCtx, closeCancel := context.WithTimeout(context.Background(), 5*time.Second)
						defer closeCancel()
						if err := lifecycle.Close(closeCtx); err != nil {
							t.Error(err)
						}
					})
					admitted := 0
					result, err := New(opener, lifecycle, guardedFiles).ReadAdmitted(ctx, actor, input, func(got context.Context) error {
						admitted++
						if got != ctx || admitted > wantAdmitted {
							t.Fatal("existing download requested content admission")
						}
						return nil
					})
					fault, known := operation.KnownFault(err)
					if !known || fault.Code != "not_found" || !errors.Is(err, model.ErrNotFound) || result != nil {
						t.Fatalf("deleted Project returned content: result=%v error=%v", result, err)
					}
					if len(writer.plan) != 0 || writer.current != nil || !reflect.DeepEqual(writer.calls, wantCalls) || opener.calls != wantSource || admitted != wantAdmitted {
						t.Fatalf("download calls=%v source=%d admitted=%d; want %v/%d/%d", writer.calls, opener.calls, admitted, wantCalls, wantSource, wantAdmitted)
					}
				})
			}
		})
	}
}
