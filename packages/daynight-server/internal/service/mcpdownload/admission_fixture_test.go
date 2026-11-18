package mcpdownload

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

type admissionFixture struct {
	t       *testing.T
	ctx     context.Context
	now     time.Time
	service *Service
	actor   mcptransfer.Actor
	input   Input
	pending []admissionStep
}

type admissionStep struct {
	name    string
	cause   error
	outcome store.TransactionOutcome
	calls   []admissionDAOCall
	source  Input
}

type admissionDAOCall struct {
	name   string
	args   []any
	cause  error
	record model.PrivateTransfer
	saved  model.PrivateTransfer
}

type admissionDAO struct {
	store.PrivateTransferDAO
	t       *testing.T
	ctx     context.Context
	pending []admissionDAOCall
}

type admissionFiles struct {
	filestorage.Storage
	filestorage.TransferStorage
	t *testing.T
}

func (s admissionFiles) AcquireGate(context.Context, filestorage.GateDomain, string) (io.Closer, error) {
	s.t.Fatal("download admission unexpectedly opened a storage gate")
	return nil, nil
}

func (s admissionFiles) PutTransfer(context.Context, filestorage.TransferNamespace, string, io.Reader) (filestorage.FileInfo, error) {
	s.t.Fatal("download admission unexpectedly copied content")
	return filestorage.FileInfo{}, nil
}

func newAdmissionFixture(t *testing.T) *admissionFixture {
	t.Helper()
	const credential = "20000000-0000-4000-8000-000000000001"
	f := &admissionFixture{
		t: t, ctx: t.Context(), now: time.Now().UTC().Truncate(time.Microsecond),
		actor: mcptransfer.Actor{
			Principal:     model.Principal{Kind: model.PATCredential, UserID: "10000000-0000-4000-8000-000000000001", CredentialID: credential},
			AuthorityKind: "pat", AuthorityID: credential,
		},
		input: Input{ProjectID: "30000000-0000-4000-8000-000000000001", TaskID: "40000000-0000-4000-8000-000000000001", Path: "file"},
	}
	files := admissionFiles{t: t}
	lifecycle, err := mcptransfer.New(f, files, files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	f.service = New(f, lifecycle, files)
	t.Cleanup(func() {
		if len(f.pending) != 0 {
			t.Errorf("unconsumed download admission steps: %#v", f.pending)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := lifecycle.Close(ctx); err != nil {
			t.Errorf("close admission lifecycle: %v", err)
		}
	})
	return f
}

func (f *admissionFixture) openInput() Input {
	in := f.input
	in.Action, in.TransferID = "open", "50000000-0000-4000-8000-000000000001"
	return in
}

func (f *admissionFixture) expect(steps ...admissionStep) {
	f.t.Helper()
	if len(f.pending) != 0 {
		f.t.Fatalf("previous download admission steps were not consumed: %#v", f.pending)
	}
	f.pending = steps
}

func (f *admissionFixture) take(ctx context.Context, name string) admissionStep {
	f.t.Helper()
	if ctx != f.ctx || len(f.pending) == 0 || f.pending[0].name != name {
		f.t.Fatalf("unexpected download admission step %s: same context=%v pending=%#v", name, ctx == f.ctx, f.pending)
	}
	step := f.pending[0]
	f.pending = f.pending[1:]
	return step
}

func (f *admissionFixture) Open(ctx context.Context, principal model.Principal, project, task, path string) (model.Attachment, filestorage.Object, error) {
	step := f.take(ctx, "source")
	if principal != f.actor.Principal || project != step.source.ProjectID || task != step.source.TaskID || path != step.source.Path {
		f.t.Fatalf("unexpected attachment precheck: principal=%+v project=%s task=%s path bytes=%d", principal, project, task, len(path))
	}
	return model.Attachment{}, filestorage.Object{}, step.cause
}

func (f *admissionFixture) admit(ctx context.Context) error {
	return f.take(ctx, "admit").cause
}

func (f *admissionFixture) WritePrivateTransfer(ctx context.Context, work func(store.PrivateTransferDAO) error) (store.Completion, error) {
	step := f.take(ctx, "scope")
	plan := &admissionDAO{t: f.t, ctx: ctx, pending: step.calls}
	err := work(plan)
	if len(plan.pending) != 0 || !errors.Is(err, step.cause) {
		f.t.Fatalf("transfer scope error=%v want %v; pending=%#v", err, step.cause, plan.pending)
	}
	completion := store.Completion{Outcome: step.outcome}
	if err != nil {
		return completion, &store.TransactionError{Phase: "operation", Outcome: step.outcome, Cause: err}
	}
	return completion, nil
}

func (d *admissionDAO) take(ctx context.Context, name string, args ...any) admissionDAOCall {
	d.t.Helper()
	if ctx != d.ctx || len(d.pending) == 0 {
		d.t.Fatalf("unexpected transfer DAO call %s(%#v): same context=%v pending=%#v", name, args, ctx == d.ctx, d.pending)
	}
	call := d.pending[0]
	d.pending = d.pending[1:]
	if call.name != name || !reflect.DeepEqual(call.args, args) {
		d.t.Fatalf("transfer DAO call %s(%#v), want %s(%#v)", name, args, call.name, call.args)
	}
	return call
}

func admissionRecordCopy(r model.PrivateTransfer) model.PrivateTransfer {
	r.Binding = bytes.Clone(r.Binding)
	r.Data = bytes.Clone(r.Data)
	return r
}

func (d *admissionDAO) Get(ctx context.Context, id string) (model.PrivateTransfer, error) {
	call := d.take(ctx, "Get", id)
	return admissionRecordCopy(call.record), call.cause
}

func (d *admissionDAO) Authorize(ctx context.Context, principal model.Principal, kind, authorityID, project, task string) error {
	return d.take(ctx, "Authorize", principal, kind, authorityID, project, task).cause
}

func (d *admissionDAO) Put(ctx context.Context, record model.PrivateTransfer, version int64) (model.PrivateTransfer, error) {
	call := d.take(ctx, "Put", record.ID, version)
	before := call.record
	if record.UpdatedAt.Before(before.UpdatedAt) || !record.UpdatedAt.Before(before.HardExpiresAt) {
		d.t.Fatalf("invalid transfer renewal time: %v", record.UpdatedAt)
	}
	before.UpdatedAt = record.UpdatedAt
	before.ExpiresAt = minTransferDeadline(record.UpdatedAt.Add(time.Hour), before.HardExpiresAt)
	if !reflect.DeepEqual(record, before) {
		d.t.Fatalf("renewal changed transfer content or binding: got %#v want %#v", record, before)
	}
	return admissionRecordCopy(call.saved), nil
}

func minTransferDeadline(idle, hard time.Time) time.Time {
	if hard.Before(idle) {
		return hard
	}
	return idle
}

func committedAdmissionScope(calls ...admissionDAOCall) admissionStep {
	return admissionStep{name: "scope", outcome: store.TransactionCommitted, calls: calls}
}

func failedAdmissionScope(cause error, calls ...admissionDAOCall) admissionStep {
	return admissionStep{name: "scope", outcome: store.TransactionNotCommitted, cause: cause, calls: calls}
}

func missingAdmissionRecord(id string) admissionStep {
	return failedAdmissionScope(model.ErrNotFound, admissionDAOCall{name: "Get", args: []any{id}, cause: model.ErrNotFound})
}

func admissionGet(record model.PrivateTransfer) admissionDAOCall {
	return admissionDAOCall{name: "Get", args: []any{record.ID}, record: record}
}

func (f *admissionFixture) authorize(in Input) admissionDAOCall {
	return admissionDAOCall{name: "Authorize", args: []any{f.actor.Principal, f.actor.AuthorityKind, f.actor.AuthorityID, in.ProjectID, in.TaskID}}
}

func (f *admissionFixture) record(in Input, state string) model.PrivateTransfer {
	return model.PrivateTransfer{
		ID: in.TransferID, UserID: f.actor.Principal.UserID, AuthorityKind: f.actor.AuthorityKind, AuthorityID: f.actor.AuthorityID,
		Direction: "download", ProjectID: in.ProjectID, TaskID: in.TaskID, Path: in.Path,
		State: state, Binding: json.RawMessage("{}"), Data: json.RawMessage("{}"), Version: 3,
		CreatedAt: f.now, UpdatedAt: f.now, ExpiresAt: f.now.Add(time.Hour), HardExpiresAt: f.now.Add(24 * time.Hour),
	}
}

func (f *admissionFixture) readable(in Input, content string) (model.PrivateTransfer, string) {
	f.t.Helper()
	record := f.record(in, "readable")
	digest := sha256.Sum256([]byte(content))
	hash := hex.EncodeToString(digest[:])
	raw, err := json.Marshal(snapshot{
		Attachment: model.Attachment{
			ProjectID: in.ProjectID, TaskID: in.TaskID, Path: in.Path, ContentType: "application/octet-stream",
			SizeBytes: int64(len(content)), CreatedAt: f.now, UpdatedAt: f.now,
		},
		ObjectID: in.TransferID, TotalBytes: int64(len(content)), SHA256: hash, Text: true,
	})
	if err != nil {
		f.t.Fatal(err)
	}
	record.Data = raw
	return record, hash
}

func (f *admissionFixture) touch(in Input, original model.PrivateTransfer) (admissionStep, model.PrivateTransfer) {
	saved := original
	saved.Version++
	saved.UpdatedAt = f.now.Add(time.Millisecond)
	saved.ExpiresAt = minTransferDeadline(saved.UpdatedAt.Add(time.Hour), saved.HardExpiresAt)
	return committedAdmissionScope(
		admissionGet(original), f.authorize(in), admissionGet(original),
		admissionDAOCall{name: "Put", args: []any{original.ID, original.Version}, record: original, saved: saved},
	), saved
}
