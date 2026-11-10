package mcpdownload

import (
	"bytes"
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
	"github.com/google/uuid"
)

type rejectingTransferWriter struct{ t *testing.T }

func (w rejectingTransferWriter) WritePrivateTransfer(context.Context, func(store.PrivateTransferDAO) error) (store.Completion, error) {
	w.t.Error("unexpected private transfer transaction")
	return store.Completion{}, errors.New("unexpected private transfer transaction")
}

type sourceFixture struct {
	t         *testing.T
	ctx       context.Context
	files     *local.Storage
	lifecycle *mcptransfer.Lifecycle
	service   *Service
	actor     mcptransfer.Actor
	input     Input
	metadata  model.Attachment
	size      int64
	openErr   error
	authErrs  []error
	steps     []string
	bodies    []*sourceBody
}

type sourceContextKey struct{}

func newSourceFixture(t *testing.T, data []byte) *sourceFixture {
	t.Helper()
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), sourceContextKey{}, "source context"))
	t.Cleanup(cancel)
	files, err := local.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Errorf("close storage: %v", err)
		}
	})
	if _, err := files.Put(ctx, "source", "file", bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	lifecycle, err := mcptransfer.New(rejectingTransferWriter{t}, files, files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := lifecycle.Close(closeCtx); err != nil {
			t.Errorf("close lifecycle: %v", err)
		}
	})
	credential := uuid.NewString()
	actor := mcptransfer.Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: credential}, AuthorityKind: "pat", AuthorityID: credential}
	in := Input{ProjectID: uuid.NewString(), TaskID: uuid.NewString(), Path: "file"}
	f := &sourceFixture{t: t, ctx: ctx, files: files, lifecycle: lifecycle, actor: actor, input: in, size: int64(len(data)), metadata: model.Attachment{ProjectID: in.ProjectID, TaskID: in.TaskID, Path: in.Path, ContentType: "application/octet-stream", SizeBytes: int64(len(data))}}
	f.service = New(f, lifecycle, files)
	t.Cleanup(func() {
		if len(f.steps) != 0 || len(f.authErrs) != 0 {
			t.Errorf("unconsumed source expectations: steps=%v authorization results=%v", f.steps, f.authErrs)
		}
		for _, body := range f.bodies {
			if body.closes != 1 {
				t.Errorf("source body closed %d times, want 1", body.closes)
				if body.closes == 0 {
					if err := body.ReadCloser.Close(); err != nil {
						t.Errorf("close leaked source body: %v", err)
					}
				}
			}
		}
	})
	return f
}

func (f *sourceFixture) expect(steps []string, authErrs ...error) {
	f.t.Helper()
	if len(f.steps) != 0 || len(f.authErrs) != 0 {
		f.t.Fatalf("previous source expectations not consumed: %v %v", f.steps, f.authErrs)
	}
	f.steps = append([]string(nil), steps...)
	f.authErrs = append([]error(nil), authErrs...)
	f.service.authorize = f.authorize
}

func (f *sourceFixture) step(name string) bool {
	f.t.Helper()
	if len(f.steps) == 0 || f.steps[0] != name {
		f.t.Errorf("unexpected %s; remaining steps %v", name, f.steps)
		return false
	}
	f.steps = f.steps[1:]
	return true
}

func (f *sourceFixture) Open(ctx context.Context, principal model.Principal, project, task, path string) (model.Attachment, filestorage.Object, error) {
	if !f.step("open") || ctx != f.ctx || principal != f.actor.Principal || project != f.input.ProjectID || task != f.input.TaskID || path != f.input.Path {
		f.t.Errorf("unexpected open arguments: context=%v principal=%+v project=%s task=%s path=%s", ctx == f.ctx, principal, project, task, path)
		return model.Attachment{}, filestorage.Object{}, errors.New("unexpected open")
	}
	if f.openErr != nil {
		return model.Attachment{}, filestorage.Object{}, f.openErr
	}
	obj, err := f.files.Open(ctx, "source", "file")
	if err != nil {
		return model.Attachment{}, filestorage.Object{}, err
	}
	if obj.Info.Size != f.size {
		f.t.Errorf("file size %d, want %d", obj.Info.Size, f.size)
	}
	body := &sourceBody{ReadCloser: obj.Body, fixture: f}
	f.bodies = append(f.bodies, body)
	obj.Body = body
	return f.metadata, obj, nil
}

func (f *sourceFixture) authorize(lifecycle *mcptransfer.Lifecycle, ctx context.Context, actor mcptransfer.Actor, project, task string) error {
	if !f.step("authorize") || lifecycle != f.lifecycle || ctx != f.ctx || actor != f.actor || project != f.input.ProjectID || task != f.input.TaskID || len(f.authErrs) == 0 {
		f.t.Errorf("unexpected authorize arguments: lifecycle=%v context=%v actor=%+v project=%s task=%s", lifecycle == f.lifecycle, ctx == f.ctx, actor, project, task)
		return errors.New("unexpected authorize")
	}
	err := f.authErrs[0]
	f.authErrs = f.authErrs[1:]
	return err
}

type sourceBody struct {
	io.ReadCloser
	fixture *sourceFixture
	reads   int
	closes  int
}

func (b *sourceBody) Read(p []byte) (int, error) {
	if b.reads == 0 {
		b.fixture.step("read")
	}
	b.reads++
	return b.ReadCloser.Read(p)
}

func (b *sourceBody) Close() error {
	b.fixture.step("close")
	b.closes++
	return b.ReadCloser.Close()
}

func TestSourceConstructorBinding(t *testing.T) {
	f := newSourceFixture(t, []byte("content"))
	if f.service.attachments != f || f.service.lifecycle != f.lifecycle || f.service.files != f.files || f.service.renewInterval != 20*time.Second {
		t.Fatal("constructor did not retain dependencies or renewal interval")
	}
	if reflect.ValueOf(f.service.authorize).Pointer() != reflect.ValueOf((*mcptransfer.Lifecycle).Authorize).Pointer() {
		t.Fatal("constructor did not bind Lifecycle.Authorize")
	}
	withoutLifecycle := New(f, nil, f.files)
	if result, err := withoutLifecycle.Read(f.ctx, f.actor, f.input); result != nil || err == nil {
		t.Fatalf("missing lifecycle: %#v %v", result, err)
	}
}

func TestSourceAuthorizationFailuresDoNotPublish(t *testing.T) {
	refusal := errors.New("authorization refused")
	for _, tc := range []struct {
		name  string
		steps []string
		errs  []error
	}{
		{"source", []string{"open", "authorize", "close"}, []error{refusal}},
		{"post-read", []string{"open", "authorize", "authorize", "read", "authorize", "close"}, []error{nil, nil, refusal}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newSourceFixture(t, []byte("content"))
			f.expect(tc.steps, tc.errs...)
			in := f.input
			in.Action = "inline"
			result, err := f.service.Read(f.ctx, f.actor, in)
			if result != nil || !errors.Is(err, refusal) {
				t.Fatalf("authorization refusal: %#v %v", result, err)
			}
		})
	}
}
