package mcptransfer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"sync"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/google/uuid"
)

type uploadDependencies struct {
	t      *testing.T
	mu     sync.Mutex
	leases []func(context.Context, model.Principal, string, string) (io.Closer, error)
	inline []func(context.Context, model.Principal, string, string, string, string, io.Reader) (model.Attachment, bool, error)
}

func (a *uploadDependencies) AcquireUploadLease(ctx context.Context, p model.Principal, project, task string) (io.Closer, error) {
	a.mu.Lock()
	if len(a.leases) == 0 {
		a.mu.Unlock()
		a.t.Errorf("unconfigured upload lease")
		panic("unconfigured upload lease")
	}
	fn := a.leases[0]
	a.leases = a.leases[1:]
	a.mu.Unlock()
	return fn(ctx, p, project, task)
}
func (a *uploadDependencies) Put(ctx context.Context, p model.Principal, project, task, path, contentType string, body io.Reader) (model.Attachment, bool, error) {
	a.mu.Lock()
	if len(a.inline) == 0 {
		a.mu.Unlock()
		a.t.Errorf("unconfigured inline Put")
		panic("unconfigured inline Put")
	}
	fn := a.inline[0]
	a.inline = a.inline[1:]
	a.mu.Unlock()
	return fn(ctx, p, project, task, path, contentType, body)
}

type uploadLease struct {
	mu     sync.Mutex
	closes int
}

func (l *uploadLease) Close() error { l.mu.Lock(); defer l.mu.Unlock(); l.closes++; return nil }
func (l *uploadLease) count() int   { l.mu.Lock(); defer l.mu.Unlock(); return l.closes }

type uploadHarness struct {
	lifecycleFixture
	uploads *Uploads
	lower   *uploadDependencies
}

func newUploadHarness(t *testing.T) uploadHarness {
	f := newFixture(t)
	lower := &uploadDependencies{t: t}
	u := NewUploads(f.lifecycle, f.files, lower)
	u.admitTransfer = func(context.Context, model.Principal, string, string, string, string, filestorage.TransferNamespace) (transferAdmission, error) {
		t.Errorf("unconfigured transfer admission")
		panic("unconfigured transfer admission")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := f.lifecycle.Close(ctx); err != nil {
			t.Error(err)
		}
		lower.mu.Lock()
		defer lower.mu.Unlock()
		if len(lower.leases) != 0 || len(lower.inline) != 0 {
			t.Errorf("unconsumed upload dependencies: leases=%d inline=%d", len(lower.leases), len(lower.inline))
		}
	})
	return uploadHarness{f, u, lower}
}
func (h uploadHarness) record(path string, offset int64) model.PrivateTransfer {
	r := h.lifecycleFixture.record()
	r.Path = path
	r.Binding = []byte(`{}`)
	r.Data = encodeUpload(uploadData{NextOffset: offset})
	r.ReservedBytes = offset
	return r
}
func (h uploadHarness) execute(actor Actor, in UploadInput) (map[string]any, error) {
	return h.uploads.Execute(h.t.Context(), actor, h.binding.ProjectID, h.binding.TaskID, in)
}
func (h uploadHarness) run(actor Actor, in UploadInput) map[string]any {
	h.t.Helper()
	result, err := h.execute(actor, in)
	if err != nil {
		h.t.Fatalf("%s: %v", in.Action, err)
	}
	return result
}
func (h uploadHarness) lookup(a Actor, r model.PrivateTransfer, err error) {
	h.expect(get(r), auth(a, r, err))
}
func (h uploadHarness) lease(a Actor, err error) *uploadLease {
	l := &uploadLease{}
	if err == nil {
		h.t.Cleanup(func() {
			if got := l.count(); got != 1 {
				h.t.Errorf("upload lease closed %d times, expected once", got)
			}
		})
	}
	h.lower.leases = append(h.lower.leases, func(ctx context.Context, p model.Principal, project, task string) (io.Closer, error) {
		if ctx.Err() != nil || p != a.Principal || project != h.binding.ProjectID || task != h.binding.TaskID {
			h.t.Errorf("lease actor/address/context changed")
		}
		if err != nil {
			return nil, err
		}
		return l, nil
	})
	return l
}
func assertUploadWrite(t *testing.T, before, after, proposed model.PrivateTransfer, version int64) {
	t.Helper()
	want := cloneTransfer(after)
	want.Data = uploadJSON(t, want.Data)
	proposed.Data = uploadJSON(t, proposed.Data)
	want.Version = before.Version
	if version != before.Version {
		t.Errorf("write version %d expected %d", version, before.Version)
	}
	now := time.Now()
	if proposed.UpdatedAt.Before(before.UpdatedAt) || proposed.UpdatedAt.After(now) {
		t.Errorf("write time outside operation: %v", proposed.UpdatedAt)
	}
	if proposed.ExpiresAt.After(proposed.HardExpiresAt) || proposed.ExpiresAt.Before(before.ExpiresAt) || !proposed.ExpiresAt.After(now) {
		t.Errorf("write expiry outside lifetime: %v", proposed.ExpiresAt)
	}
	proposed.UpdatedAt = want.UpdatedAt
	proposed.ExpiresAt = want.ExpiresAt
	if want.LeaseUntil != nil && proposed.LeaseUntil != nil {
		if time.Until(*proposed.LeaseUntil) > time.Minute || time.Until(*proposed.LeaseUntil) < 0 {
			t.Errorf("write lease outside lifetime: %v", proposed.LeaseUntil)
		}
		proposed.LeaseUntil = want.LeaseUntil
	}
	if !reflect.DeepEqual(proposed, want) {
		t.Errorf("proposed transfer\n got %+v\nwant %+v", proposed, want)
	}
}
func uploadPut(t *testing.T, before, after model.PrivateTransfer, check func(model.PrivateTransfer), err error) daoStep {
	return daoStep{method: "Put", check: func(args []any) {
		proposed := args[0].(model.PrivateTransfer)
		if check != nil {
			check(proposed)
		}
		assertUploadWrite(t, before, after, proposed, args[1].(int64))
	}, result: cloneTransfer(after), err: err}
}
func (h uploadHarness) permit(a Actor, r model.PrivateTransfer) model.PrivateTransfer {
	after := cloneTransfer(r)
	after.Version++
	h.expect(get(r), auth(a, r, nil), get(r), uploadPut(h.t, r, after, func(p model.PrivateTransfer) {
		if !p.ExpiresAt.After(p.UpdatedAt) || p.ExpiresAt.Before(time.Now().Add(time.Hour-time.Second)) && !p.ExpiresAt.Equal(p.HardExpiresAt) || !bytes.Equal(p.Data, r.Data) {
			h.t.Errorf("permit renewal changed data or expiry")
		}
	}, nil))
	return after
}
func (h uploadHarness) prepare(a Actor, r model.PrivateTransfer) model.PrivateTransfer {
	h.lookup(a, r, nil)
	h.lease(a, nil)
	current := h.permit(a, r)
	h.expect(get(current))
	return current
}
func (h uploadHarness) reserve(r model.PrivateTransfer, n int64) model.PrivateTransfer {
	after := cloneTransfer(r)
	after.Version++
	after.ReservedBytes += n
	after.OutstandingBytes += n
	steps := []daoStep{get(r), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID), method("LockLedger", nil, nil), method("OutstandingTotal", int64(0), nil), get(r), method("LockLedger", nil, nil), method("ReservedTotal", int64(0), nil)}
	if n > 0 {
		steps = append(steps, method("AddReservation", after, nil, r.ID, n))
	} else {
		after = r
	}
	h.expect(steps...)
	return after
}
func (h uploadHarness) planChunk(a Actor, r model.PrivateTransfer, in UploadInput, content []byte) (model.PrivateTransfer, *model.UploadChunk) {
	current := h.prepare(a, r)
	h.missingReceipt(current, in.ChunkID)
	reserved := h.reserve(current, int64(len(content)))
	consumed := cloneTransfer(reserved)
	consumed.Version++
	consumed.OutstandingBytes -= int64(len(content))
	after := cloneTransfer(consumed)
	after.Version++
	after.Data = encodeUpload(uploadData{NextOffset: uploadNextOffset(r) + int64(len(content))})
	receipt := &model.UploadChunk{TransferID: r.ID, ChunkID: in.ChunkID, Offset: uploadNextOffset(r), Size: int64(len(content)), SHA256: digest(content)}
	h.expect(get(reserved), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID), daoStep{method: "InsertUploadChunk", check: func(args []any) {
		got := args[0].(model.UploadChunk)
		expected := *receipt
		expected.ObjectID = got.ObjectID
		if !transfer.Canonical(got.ObjectID) || got != expected {
			h.t.Errorf("chunk receipt %+v want %+v", got, expected)
		}
		receipt.ObjectID = got.ObjectID
	}}, get(reserved), method("LockLedger", nil, nil), method("SubtractOutstanding", consumed, nil, r.ID, int64(len(content))), get(consumed), daoStep{method: "Put", check: func(args []any) {
		proposed := args[0].(model.PrivateTransfer)
		if proposed.Version != reserved.Version {
			h.t.Errorf("chunk proposal version %d expected %d", proposed.Version, reserved.Version)
		}
		proposed.Version = consumed.Version
		expected := cloneTransfer(after)
		expected.OutstandingBytes = reserved.OutstandingBytes
		assertUploadWrite(h.t, consumed, expected, proposed, args[1].(int64))
	}, result: cloneTransfer(after)})
	return after, receipt
}
func (h uploadHarness) replay(a Actor, r model.PrivateTransfer, in UploadInput, receipt model.UploadChunk) model.PrivateTransfer {
	current := h.prepare(a, r)
	h.expect(get(current), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID), method("UploadChunk", receipt, nil, r.ID, in.ChunkID))
	return current
}
func (h uploadHarness) streamReads(r model.PrivateTransfer, chunks []model.UploadChunk) {
	for _, c := range chunks {
		h.expect(get(r), method("UploadChunkAt", c, nil, r.ID, c.Offset))
	}
}
func (h uploadHarness) seed(r model.PrivateTransfer, parts ...[]byte) []model.UploadChunk {
	ns, _ := filestorage.NewTransferNamespace(r.ID)
	g, err := h.files.AcquireGate(h.t.Context(), filestorage.PrivateGate, r.ID)
	if err != nil {
		h.t.Fatal(err)
	}
	defer g.Close()
	chunks := make([]model.UploadChunk, len(parts))
	var offset int64
	for i, b := range parts {
		c := model.UploadChunk{TransferID: r.ID, ChunkID: uuid.NewString(), ObjectID: uuid.NewString(), Offset: offset, Size: int64(len(b)), SHA256: digest(b)}
		if _, err := h.files.PutTransfer(h.t.Context(), ns, c.ObjectID, bytes.NewReader(b)); err != nil {
			h.t.Fatal(err)
		}
		chunks[i] = c
		offset += int64(len(b))
	}
	return chunks
}

type uploadScope struct {
	t      *testing.T
	id     string
	chunks []model.UploadChunk
	calls  int
}

func (s *uploadScope) UploadChunkAt(ctx context.Context, id string, offset int64) (model.UploadChunk, error) {
	if s.calls >= len(s.chunks) {
		s.t.Errorf("extra scoped chunk read")
		panic("extra scoped chunk read")
	}
	c := s.chunks[s.calls]
	s.calls++
	if id != s.id || offset != c.Offset || ctx.Err() != nil {
		s.t.Errorf("scoped receipt read id=%s offset=%d ctx=%v", id, offset, ctx.Err())
	}
	return c, nil
}

type uploadAdmission struct {
	t            *testing.T
	lease        *uploadLease
	scope        *uploadScope
	content      []byte
	item         model.Attachment
	created      bool
	err          error
	effect       func(context.Context, []byte)
	closes, puts int
}

func (a *uploadAdmission) PutFromWithLease(ctx context.Context, l io.Closer, source func(store.AttachmentMutationScope) (io.ReadCloser, error)) (model.Attachment, bool, error) {
	a.puts++
	if a.puts != 1 || l != a.lease || a.lease.count() != 0 {
		a.t.Errorf("admission reused or lease not held")
	}
	reader, err := source(a.scope)
	if err != nil {
		return model.Attachment{}, false, err
	}
	b, readErr := io.ReadAll(reader)
	closeErr := reader.Close()
	if readErr != nil || closeErr != nil {
		return model.Attachment{}, false, errors.Join(readErr, closeErr)
	}
	if !bytes.Equal(b, a.content) || a.scope.calls != len(a.scope.chunks) {
		a.t.Errorf("actual admission stream mismatch: bytes=%d expected=%d receipts=%d/%d", len(b), len(a.content), a.scope.calls, len(a.scope.chunks))
	}
	if a.effect != nil {
		a.effect(ctx, b)
	}
	return a.item, a.created, a.err
}
func (a *uploadAdmission) Close() error {
	a.closes++
	if a.closes != 1 {
		a.t.Errorf("admission closed %d times", a.closes)
	}
	return nil
}
func (h uploadHarness) admission(a Actor, r model.PrivateTransfer, lease *uploadLease, chunks []model.UploadChunk, content []byte, item model.Attachment, created bool, err error) *uploadAdmission {
	admission := &uploadAdmission{t: h.t, lease: lease, scope: &uploadScope{t: h.t, id: r.ID, chunks: append([]model.UploadChunk(nil), chunks...)}, content: append([]byte(nil), content...), item: item, created: created, err: err}
	calls := 0
	h.uploads.admitTransfer = func(ctx context.Context, p model.Principal, project, task, path, contentType string, ns filestorage.TransferNamespace) (transferAdmission, error) {
		calls++
		expected, _ := filestorage.NewTransferNamespace(r.ID)
		if calls != 1 || ctx.Err() != nil || p != a.Principal || project != r.ProjectID || task != r.TaskID || path != r.Path || contentType != r.ContentType || ns != expected {
			h.t.Errorf("admission actor/address/namespace changed")
		}
		return admission, nil
	}
	h.t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := h.lifecycle.Close(ctx); err != nil {
			h.t.Error(err)
		}
		if calls != 1 || admission.closes != 1 {
			h.t.Errorf("admission calls=%d closes=%d", calls, admission.closes)
		}
	})
	return admission
}
func uploadAttachment(r model.PrivateTransfer, size int64) model.Attachment {
	now := time.Now().UTC()
	return model.Attachment{ProjectID: r.ProjectID, TaskID: r.TaskID, Path: r.Path, ContentType: r.ContentType, SizeBytes: size, CreatedAt: now, UpdatedAt: now}
}
func (h uploadHarness) target(r model.PrivateTransfer, content []byte) {
	address, err := attachmentcore.NewAddress(r.ProjectID, r.TaskID, r.Path)
	if err != nil {
		h.t.Fatal(err)
	}
	if _, err = h.files.Put(h.t.Context(), attachmentcore.Bucket, address.StoragePath, bytes.NewReader(content)); err != nil {
		h.t.Fatal(err)
	}
}
func (h uploadHarness) verifyTarget(r model.PrivateTransfer, want []byte) {
	h.t.Helper()
	address, _ := attachmentcore.NewAddress(r.ProjectID, r.TaskID, r.Path)
	obj, err := h.files.Open(h.t.Context(), attachmentcore.Bucket, address.StoragePath)
	if err != nil {
		h.t.Fatal(err)
	}
	b, e := io.ReadAll(obj.Body)
	e = errors.Join(e, obj.Body.Close())
	if e != nil || !bytes.Equal(b, want) {
		h.t.Fatalf("target bytes=%q error=%v", b, e)
	}
}

func (h uploadHarness) begin(a Actor, r model.PrivateTransfer, existing bool) {
	if existing {
		h.lookup(a, r, nil)
		return
	}
	input := cloneTransfer(r)
	input.Data = []byte(`{}`)
	h.expect(getMissing(r.ID), auth(a, r, nil), daoStep{method: "Insert", check: checkInitialRecord(h.t, input), result: insertFact{record: cloneTransfer(r), created: true}}, method("LockLedger", nil, nil), method("CountActive", 1, nil, a.Principal.UserID))
}
func dynamicGet(r func() model.PrivateTransfer) daoStep {
	first := r()
	return daoStep{method: "Get", key: first.ID, args: []any{first.ID}, result: func() any { return cloneTransfer(r()) }}
}
func (h uploadHarness) dynamicPut(before, after func() model.PrivateTransfer, check func(model.PrivateTransfer), err error) daoStep {
	return daoStep{method: "Put", check: func(args []any) {
		proposed := args[0].(model.PrivateTransfer)
		if check != nil {
			check(proposed)
		}
		assertUploadWrite(h.t, before(), after(), proposed, args[1].(int64))
	}, result: func() any { return cloneTransfer(after()) }, err: err}
}

type uploadRequestKey struct{}

type commitPlan struct {
	current, reserved     model.PrivateTransfer
	operation             string
	total                 int64
	hash                  string
	lease                 time.Time
	item                  model.Attachment
	created               bool
	outcome               string
	finishErr, cleanupErr error
}

func (p *commitPlan) committing() model.PrivateTransfer {
	r := cloneTransfer(p.reserved)
	r.Version++
	r.State = "committing"
	lease := p.lease
	r.LeaseUntil = &lease
	r.Data = encodeUpload(uploadData{NextOffset: p.total, OperationID: p.operation, TotalBytes: &p.total, SHA256: p.hash, WriteOutcome: "unknown"})
	return r
}
func (p *commitPlan) finished() model.PrivateTransfer {
	r := p.committing()
	r.Version++
	r.LeaseUntil = nil
	d := uploadData{NextOffset: p.total, OperationID: p.operation, TotalBytes: &p.total, SHA256: p.hash, WriteOutcome: p.outcome}
	switch p.outcome {
	case "confirmed":
		r.State = "committed"
		item := p.item
		created := p.created
		d.Attachment = &item
		d.Created = &created
	case "not_committed":
		r.State = "failed"
	default:
		r.State = "unknown"
	}
	r.Data = encodeUpload(d)
	return r
}
func (p *commitPlan) pending() model.PrivateTransfer {
	r := p.finished()
	r.Version++
	from := r.State
	r.CleanupFromState = &from
	r.State = "cleanup_pending"
	return r
}
func (h uploadHarness) commit(a Actor, r model.PrivateTransfer, chunks []model.UploadChunk, content []byte, item model.Attachment, created bool, publicationErr, finishErr, cleanupErr error) (*commitPlan, *uploadAdmission) {
	h.db.mu.Lock()
	planStart := len(h.db.plans)
	h.db.mu.Unlock()
	h.lookup(a, r, nil)
	lease := h.lease(a, nil)
	current := h.permit(a, r)
	h.expect(get(current))
	h.streamReads(current, chunks)
	reserved := h.reserve(current, int64(len(content)))
	outcome := "confirmed"
	if publicationErr != nil && !(attachmentservice.FileEffectPossible(publicationErr) && operationCompletion(publicationErr) == store.TransactionCommitted) {
		outcome = "unknown"
		if !attachmentservice.FileEffectPossible(publicationErr) {
			outcome = "not_committed"
		}
	}
	p := &commitPlan{lease: time.Now().UTC().Add(time.Minute), current: current, reserved: reserved, total: int64(len(content)), hash: digest(content), item: item, created: created, outcome: outcome, finishErr: finishErr, cleanupErr: cleanupErr}
	start := func() model.PrivateTransfer { return p.committing() }
	before := func() model.PrivateTransfer { return reserved }
	h.expect(get(reserved), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID), get(reserved), h.dynamicPut(before, start, func(proposed model.PrivateTransfer) {
		d, e := uploadDataOf(proposed)
		if e != nil || !transfer.Canonical(d.OperationID) || d.NextOffset != p.total || d.TotalBytes == nil || *d.TotalBytes != p.total || d.SHA256 != p.hash || d.WriteOutcome != "unknown" || d.Attachment != nil || d.Created != nil || proposed.LeaseUntil == nil || time.Until(*proposed.LeaseUntil) < 50*time.Second {
			h.t.Errorf("start commit data %s lease=%v", proposed.Data, proposed.LeaseUntil)
		}
		p.operation = d.OperationID
	}, nil))
	end := func() model.PrivateTransfer { return p.finished() }
	h.expect(dynamicGet(start), dynamicGet(start), h.dynamicPut(start, end, func(proposed model.PrivateTransfer) {
		if !bytes.Equal(uploadJSON(h.t, proposed.Data), uploadJSON(h.t, p.finished().Data)) {
			h.t.Errorf("receipt data %s expected %s", proposed.Data, p.finished().Data)
		}
	}, finishErr))
	if finishErr == nil && outcome != "unknown" {
		pending := func() model.PrivateTransfer { return p.pending() }
		h.expect(dynamicGet(end), dynamicGet(end), h.dynamicPut(end, pending, func(proposed model.PrivateTransfer) {
			if !bytes.Equal(uploadJSON(h.t, proposed.Data), uploadJSON(h.t, p.finished().Data)) || proposed.CleanupFromState == nil || *proposed.CleanupFromState != p.finished().State {
				h.t.Errorf("cleanup lost original outcome")
			}
		}, cleanupErr))
	}
	h.db.mu.Lock()
	for _, plan := range h.db.plans[planStart:] {
		plan.steps[0].matchContext = func(ctx context.Context) bool { return ctx.Value(uploadRequestKey{}) == nil }
	}
	h.db.mu.Unlock()
	admission := h.admission(a, r, lease, chunks, content, item, created, publicationErr)
	return p, admission
}
func operationCompletion(err error) store.TransactionOutcome {
	var tx *store.TransactionError
	if errors.As(err, &tx) {
		return tx.Outcome
	}
	return store.TransactionNotCommitted
}
func (h uploadHarness) status(a Actor, r model.PrivateTransfer) map[string]any {
	h.lookup(a, r, nil)
	return h.run(a, UploadInput{Action: "status", TransferID: r.ID})
}
func (h uploadHarness) cleanup(a Actor, r model.PrivateTransfer) model.PrivateTransfer {
	h.lookup(a, r, nil)
	pending := cloneTransfer(r)
	pending.Version++
	pending.State = "cleanup_pending"
	from := r.State
	pending.CleanupFromState = &from
	h.expect(get(r), auth(a, r, nil), get(r), uploadPut(h.t, r, pending, func(p model.PrivateTransfer) {
		if !bytes.Equal(p.Data, r.Data) || p.CleanupFromState == nil || *p.CleanupFromState != r.State {
			h.t.Errorf("cleanup discarded receipt")
		}
	}, nil))
	return pending
}
func (h uploadHarness) maintain(r model.PrivateTransfer) model.PrivateTransfer {
	h.expect(daoStep{method: "Due", check: func(args []any) {
		if args[1].(int) != SweepLimit {
			h.t.Errorf("sweep limit changed")
		}
	}, result: []model.PrivateTransfer{cloneTransfer(r)}})
	h.expect(get(r))
	closed := cloneTransfer(r)
	closed.Version++
	closed.State = "closed"
	closed.ReservedBytes = 0
	closed.OutstandingBytes = 0
	h.expect(get(r), get(r), method("LockLedger", nil, nil), daoStep{method: "Release", check: func(args []any) {
		got := args[0].(model.PrivateTransfer)
		if !reflect.DeepEqual(got, r) || args[1].(int64) != r.Version || args[3].(string) != "closed" || time.Until(args[2].(time.Time)) < Retention-time.Minute {
			h.t.Errorf("release receipt args %#v", args)
		}
	}, result: closed})
	h.expect(daoStep{method: "Prune", check: func(args []any) {
		if args[1].(int) != SweepLimit {
			h.t.Errorf("prune limit changed")
		}
	}, result: int64(0)})
	h.expect(method("Stats", store.PrivateTransferStats{}, nil))
	return closed
}
func (h uploadHarness) planInline(a Actor, path string, content []byte, item model.Attachment, created bool, err error) {
	h.lower.inline = append(h.lower.inline, func(ctx context.Context, p model.Principal, project, task, gotPath, contentType string, reader io.Reader) (model.Attachment, bool, error) {
		b, e := io.ReadAll(reader)
		if e != nil || ctx.Err() != nil || p != a.Principal || project != h.binding.ProjectID || task != h.binding.TaskID || gotPath != path || contentType != item.ContentType || !bytes.Equal(b, content) {
			h.t.Errorf("inline arguments/content changed")
		}
		return item, created, err
	})
}

func (a *uploadDependencies) AdmitTransfer(context.Context, model.Principal, string, string, string, string, filestorage.TransferNamespace) (*attachmentservice.TransferAdmission, error) {
	a.t.Errorf("unconfigured concrete transfer admission")
	panic("unconfigured concrete transfer admission")
}
func (s *uploadScope) unexpected(method string) {
	s.t.Helper()
	s.t.Errorf("unconfigured publication scope %s", method)
	panic("unconfigured publication scope " + method)
}
func (s *uploadScope) LockTaskPresence(context.Context, string, string) (store.TaskPresence, error) {
	s.unexpected("LockTaskPresence")
	return store.TaskPresence{}, nil
}
func (s *uploadScope) ProjectAuthorization(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	s.unexpected("ProjectAuthorization")
	return model.ProjectAccess{}, nil
}
func (s *uploadScope) ProjectLive(context.Context, string) error {
	s.unexpected("ProjectLive")
	return nil
}
func (s *uploadScope) AttachmentDAO() store.AttachmentMutationDAO {
	s.unexpected("AttachmentDAO")
	return nil
}

func (h uploadHarness) missingReceipt(r model.PrivateTransfer, chunk string) {
	failure := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.ErrNotFound}
	plan := h.db.expect(store.Completion{Outcome: store.TransactionNotCommitted}, failure, get(r), method("LockProjectLifecycle", nil, nil, r.ProjectID, r.TaskID), method("UploadChunk", nil, model.ErrNotFound, r.ID, chunk))
	plan.callbackCheck = func(err error) {
		if !errors.Is(err, model.ErrNotFound) {
			h.t.Errorf("missing receipt callback %v", err)
		}
	}
}

func uploadJSON(t *testing.T, raw []byte) []byte {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var parsed any
	if err := decoder.Decode(&parsed); err != nil {
		t.Errorf("invalid transfer data %q: %v", raw, err)
		return nil
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		t.Errorf("extra transfer data after JSON: %v", err)
	}
	normalized, err := json.Marshal(parsed)
	if err != nil {
		t.Errorf("cannot normalize transfer data: %v", err)
	}
	return normalized
}
