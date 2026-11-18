package mcpdownload

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

var storageFailure = errors.New("test storage failure")

type alteredOpener struct {
	Opener
	mode string
}

func (o alteredOpener) Open(ctx context.Context, p model.Principal, project, task, path string) (model.Attachment, filestorage.Object, error) {
	a, obj, err := o.Opener.Open(ctx, p, project, task, path)
	if err != nil {
		return a, obj, err
	}
	switch o.mode {
	case "close":
		obj.Body = &failureBody{ReadCloser: obj.Body, failClose: true}
	case "read":
		obj.Body = &failureBody{ReadCloser: obj.Body, failRead: true}
	case "short":
		obj.Body = &limitedBody{ReadCloser: obj.Body, reader: io.LimitReader(obj.Body, 1)}
	}
	return a, obj, nil
}

type failureBody struct {
	io.ReadCloser
	failRead, failClose bool
}

func (b *failureBody) Read(p []byte) (int, error) {
	if b.failRead {
		return 0, storageFailure
	}
	return b.ReadCloser.Read(p)
}
func (b *failureBody) Close() error {
	err := b.ReadCloser.Close()
	if b.failClose {
		return errors.Join(err, storageFailure)
	}
	return err
}

type limitedBody struct {
	io.ReadCloser
	reader io.Reader
}

func (b *limitedBody) Read(p []byte) (int, error) { return b.reader.Read(p) }

type alteredRange struct {
	filestorage.TransferStorage
	mode string
}

func (s alteredRange) OpenTransferRange(ctx context.Context, n filestorage.TransferNamespace, id string, offset, length int64) (filestorage.Object, error) {
	if s.mode == "open" {
		return filestorage.Object{}, storageFailure
	}
	obj, err := s.TransferStorage.OpenTransferRange(ctx, n, id, offset, length)
	if err != nil {
		return obj, err
	}
	switch s.mode {
	case "size":
		obj.Info.Size++
	case "read":
		obj.Body = &failureBody{ReadCloser: obj.Body, failRead: true}
	case "short":
		obj.Body = &limitedBody{ReadCloser: obj.Body, reader: io.LimitReader(obj.Body, 1)}
	}
	return obj, nil
}
func TestReadRejectsInvalidInputs(t *testing.T) {
	f := newAdmissionFixture(t)
	base := f.input
	cases := []struct {
		name string
		edit func(*Input)
	}{
		{"format", func(i *Input) { i.Format = "hex" }}, {"max-negative", func(i *Input) { i.MaxBytes = -1 }}, {"max-over", func(i *Input) { i.MaxBytes = MaxChunkBytes + 1 }},
		{"project", func(i *Input) { i.ProjectID = "bad" }}, {"task", func(i *Input) { i.TaskID = "bad" }}, {"path", func(i *Input) { i.Path = "../secret" }},
		{"transfer", func(i *Input) { i.Action = "chunk"; i.TransferID = "bad" }}, {"action", func(i *Input) { i.Action = "unknown" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := base
			tc.edit(&in)
			if data, err := f.service.Read(f.ctx, f.actor, in); err == nil || data != nil {
				t.Fatalf("invalid input: %#v %v", data, err)
			}
		})
	}
	var missing *Service
	if data, err := missing.Read(t.Context(), mcptransfer.Actor{}, base); err == nil || data != nil {
		t.Fatal("missing dependencies accepted")
	}
}
func TestInspectAndInlineStorageFailures(t *testing.T) {
	for _, action := range []string{"inspect", "inline"} {
		t.Run("missing "+action, func(t *testing.T) {
			f := newSourceFixture(t, nil)
			f.openErr = &model.Fault{Code: "not_found", Message: "Attachment not found", Cause: model.ErrNotFound}
			f.expect([]string{"open", "authorize"}, nil)
			in := f.input
			in.Action = action
			result, err := f.service.Read(f.ctx, f.actor, in)
			if result != nil || !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("missing source %s: %#v %v", action, result, err)
			}
		})
	}
	for _, tc := range []struct {
		action, mode string
		steps        []string
		authCount    int
	}{
		{"inspect", "close", []string{"open", "authorize", "close"}, 1},
		{"inline", "read", []string{"open", "authorize", "authorize", "close"}, 2},
		{"inline", "short", []string{"open", "authorize", "authorize", "read", "close"}, 2},
	} {
		t.Run(tc.action+" "+tc.mode, func(t *testing.T) {
			f := newSourceFixture(t, []byte("content"))
			f.service.attachments = alteredOpener{Opener: f, mode: tc.mode}
			f.expect(tc.steps, make([]error, tc.authCount)...)
			in := f.input
			in.Action = tc.action
			result, err := f.service.Read(f.ctx, f.actor, in)
			if err == nil || result != nil || (tc.mode != "short" && !errors.Is(err, storageFailure)) {
				t.Fatalf("%s %s returned content: %#v %v", tc.action, tc.mode, result, err)
			}
		})
	}
}

type chunkAdmissionContextKey struct{}

type chunkFailureStorage struct {
	*local.Storage
	fixture    *admissionFixture
	transferID string
	mode       string
	gate       *chunkFailureGate
	body       *chunkFailureBody
}

type chunkFailureGate struct {
	io.Closer
	storage *chunkFailureStorage
	closes  int
}

func (g *chunkFailureGate) Close() error {
	g.closes++
	if g.storage.body != nil && g.storage.body.closes != 1 {
		g.storage.fixture.t.Error("private permit released before its range body closed")
	}
	err := g.Closer.Close()
	if err != nil {
		g.storage.fixture.t.Errorf("release real private gate: %v", err)
	}
	return err
}

type chunkFailureBody struct {
	io.ReadCloser
	reads  int
	closes int
}

func (b *chunkFailureBody) Read(buf []byte) (int, error) {
	b.reads++
	return b.ReadCloser.Read(buf)
}

func (b *chunkFailureBody) Close() error {
	b.closes++
	return b.ReadCloser.Close()
}

func (s *chunkFailureStorage) AcquireGate(ctx context.Context, domain filestorage.GateDomain, id string) (io.Closer, error) {
	f := s.fixture
	f.t.Helper()
	if ctx == f.ctx || ctx.Value(chunkAdmissionContextKey{}) != f || ctx.Err() != nil ||
		domain != filestorage.PrivateGate || id != s.transferID {
		f.t.Fatalf("invalid chunk gate scope: domain=%q id=%q", domain, id)
	}
	f.permitCtx = ctx
	f.take(ctx, "gate")
	permit, err := s.Storage.AcquireGate(ctx, domain, id)
	if err != nil {
		return nil, err
	}
	s.gate = &chunkFailureGate{Closer: permit, storage: s}
	return s.gate, nil
}

func (s *chunkFailureStorage) OpenTransferRange(ctx context.Context, ns filestorage.TransferNamespace, id string, offset, length int64) (filestorage.Object, error) {
	f := s.fixture
	f.t.Helper()
	f.take(ctx, "range")
	if s.gate == nil || s.gate.closes != 0 || ns.ID() != s.transferID || id != s.transferID || offset != 0 || length != DefaultBytes {
		f.t.Fatalf("invalid chunk range: namespace=%q object=%q offset=%d length=%d", ns.ID(), id, offset, length)
	}
	obj, err := (alteredRange{TransferStorage: s.Storage, mode: s.mode}).OpenTransferRange(ctx, ns, id, offset, length)
	if err != nil {
		return obj, err
	}
	s.body = &chunkFailureBody{ReadCloser: obj.Body}
	obj.Body = s.body
	return obj, nil
}

func (s *chunkFailureStorage) PutTransfer(context.Context, filestorage.TransferNamespace, string, io.Reader) (filestorage.FileInfo, error) {
	s.fixture.t.Fatal("chunk failure unexpectedly wrote a transfer object")
	return filestorage.FileInfo{}, nil
}

func TestChunkStorageFailuresAreNotReturnedAsContent(t *testing.T) {
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Errorf("close chunk storage: %v", err)
		}
	})
	storage := &chunkFailureStorage{Storage: files}
	f := newAdmissionFixtureWithStorage(t, storage)
	f.ctx = context.WithValue(f.ctx, chunkAdmissionContextKey{}, f)
	in := f.openInput()
	in.Action, in.Offset, in.Format = "chunk", "0", "base64"
	storage.fixture, storage.transferID = f, in.TransferID

	const content = "content"
	ns, err := filestorage.NewTransferNamespace(in.TransferID)
	if err != nil {
		t.Fatal(err)
	}
	seedGate, err := files.AcquireGate(f.ctx, filestorage.PrivateGate, in.TransferID)
	if err != nil {
		t.Fatal(err)
	}
	info, writeErr := files.PutTransfer(f.ctx, ns, in.TransferID, strings.NewReader(content))
	if err := errors.Join(writeErr, seedGate.Close()); err != nil || info.Size != int64(len(content)) {
		t.Fatalf("seed chunk snapshot: size=%d err=%v", info.Size, err)
	}
	record, _ := f.readable(in, content)
	record.CreatedAt = f.now.Add(-23*time.Hour - 30*time.Minute)
	record.HardExpiresAt = record.CreatedAt.Add(24 * time.Hour)
	record.ExpiresAt = f.now.Add(20 * time.Minute)

	for i, mode := range []string{"open", "size", "read", "short"} {
		storage.mode, storage.gate, storage.body = mode, nil, nil
		saved := record
		saved.Version++
		saved.UpdatedAt = f.now.Add(time.Duration(i+1) * time.Millisecond)
		saved.ExpiresAt = record.HardExpiresAt
		renew := committedAdmissionScope(admissionGet(record), f.authorize(in), admissionGet(record),
			admissionDAOCall{
				name: "Put", args: []any{record.ID, record.Version}, record: record, saved: saved, permitRenewal: true,
			})
		renew.permit = true
		reread := committedAdmissionScope(admissionGet(saved), f.authorize(in))
		reread.permit = true
		f.expect(
			committedAdmissionScope(admissionGet(record), f.authorize(in)),
			admissionStep{name: "gate", permit: true}, renew, reread,
			admissionStep{name: "range", permit: true},
		)

		result, err := f.service.Read(f.ctx, f.actor, in)
		if err == nil || result != nil {
			t.Fatalf("%s failure returned bytes: %#v %v", mode, result, err)
		}
		switch mode {
		case "open", "read":
			if !errors.Is(err, storageFailure) {
				t.Fatalf("%s lost its storage failure: %v", mode, err)
			}
		case "size":
			if err.Error() != "snapshot size differs from receipt" {
				t.Fatalf("unexpected size failure: %v", err)
			}
		case "short":
			if err.Error() != "snapshot range was incomplete" {
				t.Fatalf("unexpected short-read failure: %v", err)
			}
		}
		if storage.gate == nil || storage.gate.closes != 1 || !errors.Is(f.permitCtx.Err(), context.Canceled) {
			t.Fatalf("%s did not close its private permit", mode)
		}
		if mode == "open" {
			if storage.body != nil {
				t.Fatal("failed range open returned a body")
			}
		} else {
			if storage.body == nil || storage.body.closes != 1 {
				t.Fatalf("%s range had incorrect close behavior: %#v", mode, storage.body)
			}
			readAttempted := storage.body.reads > 0
			wantRead := mode != "size"
			if readAttempted != wantRead {
				t.Fatalf("%s range attempted read=%v, want %v", mode, readAttempted, wantRead)
			}
		}
		record = saved
	}

	f.expect()
	in.Offset = "01"
	if result, err := f.service.Read(f.ctx, f.actor, in); err == nil || result != nil {
		t.Fatalf("noncanonical offset: %#v %v", result, err)
	}
}
