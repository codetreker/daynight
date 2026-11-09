package mcptransfer

import (
	"context"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type mcpChunkContextKey struct{}

type mcpChunkDAOCall struct {
	method string
	record model.PrivateTransfer
	chunk  model.UploadChunk
	err    error
}

type mcpChunkTransaction struct {
	calls   []mcpChunkDAOCall
	outcome store.TransactionOutcome
	cause   error
}

type mcpChunkWriter struct {
	store.PrivateTransferDAO
	t            *testing.T
	actor        Actor
	project      string
	task         string
	id           string
	chunkID      string
	plan         []mcpChunkTransaction
	current      *mcpChunkTransaction
	ctx          context.Context
	inserted     []model.UploadChunk
	transactions int
}

func (w *mcpChunkWriter) take(ctx context.Context, method string) mcpChunkDAOCall {
	w.t.Helper()
	if ctx != w.ctx || ctx.Err() != nil || ctx.Value(mcpChunkContextKey{}) != w || w.current == nil || len(w.current.calls) == 0 || w.current.calls[0].method != method {
		w.t.Fatalf("unexpected chunk DAO call %q in transaction %d", method, w.transactions)
	}
	call := w.current.calls[0]
	w.current.calls = w.current.calls[1:]
	return call
}

func (w *mcpChunkWriter) WritePrivateTransfer(ctx context.Context, fn func(store.PrivateTransferDAO) error) (store.Completion, error) {
	w.t.Helper()
	if len(w.plan) == 0 || w.current != nil || ctx.Err() != nil || ctx.Value(mcpChunkContextKey{}) != w {
		w.t.Fatalf("unexpected chunk transaction %d", w.transactions+1)
	}
	w.transactions++
	current := w.plan[0]
	w.plan = w.plan[1:]
	w.current, w.ctx = &current, ctx
	err := fn(w)
	w.current, w.ctx = nil, nil
	if len(current.calls) != 0 || !errors.Is(err, current.cause) {
		w.t.Fatalf("chunk transaction %d: remaining=%v error=%v want=%v", w.transactions, current.calls, err, current.cause)
	}
	completion := store.Completion{Outcome: current.outcome}
	if current.cause != nil {
		return completion, &store.TransactionError{Phase: "operation", Outcome: current.outcome, Cause: err}
	}
	return completion, nil
}

func (w *mcpChunkWriter) Get(ctx context.Context, id string) (model.PrivateTransfer, error) {
	call := w.take(ctx, "get")
	if id != w.id {
		w.t.Fatalf("chunk read id=%s want=%s", id, w.id)
	}
	return call.record, call.err
}

func (w *mcpChunkWriter) Authorize(ctx context.Context, p model.Principal, kind, authority, project, task string) error {
	call := w.take(ctx, "authorize")
	if p != w.actor.Principal || kind != w.actor.AuthorityKind || authority != w.actor.AuthorityID || project != w.project || task != w.task {
		w.t.Fatalf("chunk authorization changed actor or address: %+v %s/%s %s/%s", p, kind, authority, project, task)
	}
	return call.err
}

func (w *mcpChunkWriter) LockProjectLifecycle(ctx context.Context, project, task string) error {
	call := w.take(ctx, "project")
	if project != w.project || task != w.task {
		w.t.Fatalf("chunk lifecycle address=%s/%s", project, task)
	}
	return call.err
}

func (w *mcpChunkWriter) LockLedger(ctx context.Context) error {
	return w.take(ctx, "ledger").err
}

func (w *mcpChunkWriter) OutstandingTotal(ctx context.Context) (int64, error) {
	call := w.take(ctx, "outstanding")
	return 0, call.err
}

func (w *mcpChunkWriter) ReservedTotal(ctx context.Context) (int64, error) {
	call := w.take(ctx, "reserved")
	return 0, call.err
}

func (w *mcpChunkWriter) AddReservation(ctx context.Context, id string, size int64) (model.PrivateTransfer, error) {
	call := w.take(ctx, "reserve")
	if id != w.id || size != 1 {
		w.t.Fatalf("chunk reservation id=%s size=%d", id, size)
	}
	return call.record, call.err
}

func (w *mcpChunkWriter) SubtractOutstanding(ctx context.Context, id string, size int64) (model.PrivateTransfer, error) {
	call := w.take(ctx, "consume")
	if id != w.id || size != 1 {
		w.t.Fatalf("chunk materialization id=%s size=%d", id, size)
	}
	return call.record, call.err
}

func (w *mcpChunkWriter) UploadChunk(ctx context.Context, id, chunkID string) (model.UploadChunk, error) {
	call := w.take(ctx, "chunk")
	if id != w.id || chunkID != w.chunkID {
		w.t.Fatalf("chunk receipt id=%s chunk=%s", id, chunkID)
	}
	return call.chunk, call.err
}

func (w *mcpChunkWriter) InsertUploadChunk(ctx context.Context, chunk model.UploadChunk) error {
	call := w.take(ctx, "insert-chunk")
	if chunk.TransferID != w.id || chunk.ChunkID != w.chunkID || chunk.Offset != 0 || chunk.Size != 1 || chunk.SHA256 != digest([]byte("a")) || !transfer.Canonical(chunk.ObjectID) {
		w.t.Fatalf("proposed chunk receipt=%+v", chunk)
	}
	w.inserted = append(w.inserted, chunk)
	return call.err
}

func (w *mcpChunkWriter) Put(ctx context.Context, proposed model.PrivateTransfer, version int64) (model.PrivateTransfer, error) {
	call := w.take(ctx, "put")
	if proposed.ID != w.id || proposed.ProjectID != w.project || proposed.TaskID != w.task || proposed.UserID != w.actor.Principal.UserID || proposed.AuthorityKind != w.actor.AuthorityKind || proposed.AuthorityID != w.actor.AuthorityID || proposed.Direction != "upload" || proposed.State != "receiving" || version != call.record.Version-1 || !reflect.DeepEqual(proposed.Data, call.record.Data) || !proposed.ExpiresAt.After(proposed.UpdatedAt) {
		w.t.Fatalf("proposed transfer=%+v version=%d; configured result=%+v", proposed, version, call.record)
	}
	return call.record, call.err
}

type mcpChunkLease struct{ close func() }

func (c mcpChunkLease) Close() error { c.close(); return nil }

type mcpChunkAttachments struct {
	attachmentPut
	t             *testing.T
	writer        *mcpChunkWriter
	calls, closes int
}

func (a *mcpChunkAttachments) AcquireUploadLease(ctx context.Context, p model.Principal, project, task string) (io.Closer, error) {
	a.calls++
	if a.calls > 2 || ctx.Value(mcpChunkContextKey{}) != a.writer || ctx.Err() != nil || p != a.writer.actor.Principal || project != a.writer.project || task != a.writer.task {
		a.t.Fatalf("unexpected upload lease: actor=%+v address=%s/%s calls=%d", p, project, task, a.calls)
	}
	return mcpChunkLease{close: func() { a.closes++ }}, nil
}

type mcpChunkFiles struct {
	filestorage.TransferStorage
	t      *testing.T
	id     string
	writes int
}

func (s *mcpChunkFiles) PutTransfer(ctx context.Context, namespace filestorage.TransferNamespace, id string, body io.Reader) (filestorage.FileInfo, error) {
	s.writes++
	content, err := io.ReadAll(body)
	if s.writes != 1 || namespace.ID() != s.id || !transfer.Canonical(id) || string(content) != "a" || err != nil {
		s.t.Fatalf("private chunk write: namespace=%s object=%s content=%q writes=%d error=%v", namespace.ID(), id, content, s.writes, err)
	}
	return s.TransferStorage.PutTransfer(ctx, namespace, id, strings.NewReader(string(content)))
}

func TestMCPChunkCleanupFailurePreservesAcceptedAndReplayReceipts(t *testing.T) {
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
	project, task, id, chunkID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	before, err := transfer.NewRecord(actor, Binding{ID: id, Direction: "upload", ProjectID: project, TaskID: task, Path: "file", ContentType: "text/plain"}, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	before.Version = 1
	before.Data = encodeUpload(uploadData{})
	renewed := before
	renewed.Version = 2
	reserved := renewed
	reserved.Version, reserved.ReservedBytes, reserved.OutstandingBytes = 3, 1, 1
	consumed := reserved
	consumed.Version, consumed.OutstandingBytes = 4, 0
	accepted := consumed
	accepted.Version, accepted.Data = 5, encodeUpload(uploadData{NextOffset: 1})
	replayed := accepted
	replayed.Version = 6
	prior := model.UploadChunk{TransferID: id, ChunkID: chunkID, ObjectID: uuid.NewString(), Offset: 0, Size: 1, SHA256: digest([]byte("a"))}
	get := func(r model.PrivateTransfer) mcpChunkDAOCall { return mcpChunkDAOCall{method: "get", record: r} }
	call := func(method string) mcpChunkDAOCall { return mcpChunkDAOCall{method: method} }
	put := func(r model.PrivateTransfer) mcpChunkDAOCall { return mcpChunkDAOCall{method: "put", record: r} }
	tx := func(calls ...mcpChunkDAOCall) mcpChunkTransaction {
		return mcpChunkTransaction{calls: calls, outcome: store.TransactionCommitted}
	}
	writer := &mcpChunkWriter{t: t, actor: actor, project: project, task: task, id: id, chunkID: chunkID, plan: []mcpChunkTransaction{
		tx(get(before), call("authorize")),
		tx(get(before), call("authorize"), get(before), put(renewed)),
		tx(get(renewed)),
		{calls: []mcpChunkDAOCall{get(renewed), call("project"), {method: "chunk", err: model.ErrNotFound}}, outcome: store.TransactionNotCommitted, cause: model.ErrNotFound},
		tx(get(renewed), call("project"), call("ledger"), call("outstanding"), get(renewed), call("ledger"), call("reserved"), mcpChunkDAOCall{method: "reserve", record: reserved}),
		tx(get(reserved), call("project"), call("insert-chunk"), get(reserved), call("ledger"), mcpChunkDAOCall{method: "consume", record: consumed}, get(consumed), put(accepted)),
		tx(get(accepted), call("authorize")),
		tx(get(accepted), call("authorize"), get(accepted), put(replayed)),
		tx(get(replayed)),
		tx(get(replayed), call("project"), mcpChunkDAOCall{method: "chunk", chunk: prior}),
		tx(get(replayed), call("authorize")),
	}}
	ctx := context.WithValue(t.Context(), mcpChunkContextKey{}, writer)
	cause := errors.New("private gate close failed")
	private := &mcpChunkFiles{TransferStorage: files, t: t, id: id}
	lifecycle, err := New(writer, uploadGateCloseError{Storage: files, cause: cause}, private, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := lifecycle.Close(closeCtx); err != nil {
			t.Error(err)
		}
	})
	attachments := &mcpChunkAttachments{t: t, writer: writer}
	uploads := NewUploads(lifecycle, private, attachments)
	input := UploadInput{Action: "chunk", TransferID: id, ChunkID: chunkID, Offset: "0", ContentBase64: "YQ=="}
	for _, receipt := range []string{"accepted", "already_accepted"} {
		result, err := uploads.Execute(ctx, actor, project, task, input)
		if !errors.Is(err, cause) || result["receipt"] != receipt || result["transferId"] != id || result["chunkId"] != chunkID || result["offset"] != "0" || result["acceptedBytes"] != "1" || result["nextOffset"] != "1" || result["sha256"] != digest([]byte("a")) || result["expiresAt"] != accepted.ExpiresAt.UTC() || result["writeOutcome"] != nil {
			t.Fatalf("chunk receipt=%+v error=%v", result, err)
		}
	}
	status, err := uploads.Execute(ctx, actor, project, task, UploadInput{Action: "status", TransferID: id})
	if err != nil || status["nextOffset"] != "1" || status["state"] != "receiving" || len(writer.plan) != 0 || len(writer.inserted) != 1 || private.writes != 1 || attachments.calls != 2 || attachments.closes != 2 {
		t.Fatalf("status=%+v error=%v remaining=%d inserted=%d writes=%d leases=%d/%d", status, err, len(writer.plan), len(writer.inserted), private.writes, attachments.calls, attachments.closes)
	}
	namespace, err := filestorage.NewTransferNamespace(id)
	if err != nil {
		t.Fatal(err)
	}
	object, err := files.OpenTransfer(ctx, namespace, writer.inserted[0].ObjectID)
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || string(content) != "a" {
		t.Fatalf("private chunk content=%q read=%v close=%v", content, readErr, closeErr)
	}
}
