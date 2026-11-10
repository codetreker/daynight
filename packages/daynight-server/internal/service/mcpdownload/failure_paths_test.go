package mcpdownload

import (
	"context"
	"errors"
	"io"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/google/uuid"
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
	f := newFixture(t)
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
			if data, err := f.service.Read(t.Context(), f.actor, in); err == nil || data != nil {
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
func TestChunkStorageFailuresAreNotReturnedAsContent(t *testing.T) {
	f := newFixture(t)
	f.put(t, []byte("content"))
	in := f.input
	in.Action = "open"
	in.TransferID = uuid.NewString()
	f.read(t, in)
	in.Action = "chunk"
	in.Offset = "0"
	in.Format = "base64"
	real := f.service.files
	for _, mode := range []string{"open", "size", "read", "short"} {
		f.service.files = alteredRange{TransferStorage: real, mode: mode}
		if result, err := f.service.Read(t.Context(), f.actor, in); err == nil || result != nil {
			t.Fatalf("%s failure returned bytes: %#v %v", mode, result, err)
		}
	}
	in.Offset = "01"
	if result, err := f.service.Read(t.Context(), f.actor, in); err == nil || result != nil {
		t.Fatalf("noncanonical offset: %#v %v", result, err)
	}
}
