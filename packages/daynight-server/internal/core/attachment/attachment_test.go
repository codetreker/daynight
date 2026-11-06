package attachment

import (
	"context"
	"encoding/base64"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type readerProbe struct {
	store.AttachmentReader
	query    store.AttachmentConflictQuery
	conflict bool
	err      error
}

func (r *readerProbe) AttachmentPathConflict(_ context.Context, _, _ string, query store.AttachmentConflictQuery) (bool, error) {
	r.query = query
	return r.conflict, r.err
}

func TestAddressAndConflictQuery(t *testing.T) {
	project := "AB000000-0000-4000-8000-000000000001"
	task := "CD000000-0000-4000-8000-000000000002"
	address, err := NewAddress(project, task, "文档/a%_/file")
	if err != nil || address.ProjectID != "ab000000-0000-4000-8000-000000000001" || address.TaskID != "cd000000-0000-4000-8000-000000000002" || address.StoragePath != "ab000000-0000-4000-8000-000000000001/cd/cd000000-0000-4000-8000-000000000002/文档/a%_/file" {
		t.Fatalf("address = %#v, %v", address, err)
	}
	probe := &readerProbe{conflict: true}
	var fault *model.Fault
	if err := CheckPathConflict(t.Context(), probe, address); !errors.As(err, &fault) || fault.Code != "path_conflict" {
		t.Fatalf("conflict = %v", err)
	}
	want := store.AttachmentConflictQuery{Ancestors: []string{"文档", "文档/a%_"}, DescendantPrefix: "文档/a%_/file/"}
	if !reflect.DeepEqual(probe.query, want) {
		t.Fatalf("query = %#v, want %#v", probe.query, want)
	}
	if _, err := NewAddress(project, task, "../file"); err == nil {
		t.Fatal("accepted invalid path")
	}
	if err := ValidateContentType("text/plain; charset=utf-8"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateContentType("text/plain; charset"); err == nil {
		t.Fatal("accepted malformed MIME parameters")
	}
}

func TestCursorBindingAndStrictDecoding(t *testing.T) {
	page, err := MakePage(store.AttachmentPage{Items: []model.Attachment{{Path: "docs/a"}}, HasMore: true}, "project", "task")
	if err != nil || page.NextCursor == nil {
		t.Fatalf("page = %#v, %v", page, err)
	}
	query, err := ListQuery(model.PageRequest{Limit: 2, Cursor: page.NextCursor}, "project", "task")
	if err != nil || query.After == nil || *query.After != "docs/a" {
		t.Fatalf("query = %#v, %v", query, err)
	}
	if _, err := ListQuery(model.PageRequest{Limit: 2, Cursor: page.NextCursor}, "project", "other"); err == nil {
		t.Fatal("accepted another task's cursor")
	}
	invalid := base64.RawURLEncoding.EncodeToString([]byte(`{"version":1,"kind":"attachments","projectId":"project","taskId":"task","path":"docs/a","extra":true}`))
	if _, err := ListQuery(model.PageRequest{Limit: 2, Cursor: &invalid}, "project", "task"); err == nil {
		t.Fatal("accepted an unknown cursor field")
	}
}

type metadataReader struct {
	store.AttachmentReader
	project, task, path string
	result              model.Attachment
	err                 error
}

func (r *metadataReader) Attachment(_ context.Context, project, task, path string) (model.Attachment, error) {
	r.project, r.task, r.path = project, task, path
	return r.result, r.err
}

type metadataWriter struct {
	input               model.Attachment
	project, task, path string
	result              model.Attachment
	created             bool
	err                 error
}

func (w *metadataWriter) PutAttachment(_ context.Context, input model.Attachment) (model.Attachment, bool, error) {
	w.input = input
	return w.result, w.created, w.err
}

func (w *metadataWriter) DeleteAttachment(_ context.Context, project, task, path string) error {
	w.project, w.task, w.path = project, task, path
	return w.err
}

func TestMetadataDelegationAndErrors(t *testing.T) {
	address := Address{ProjectID: "project", TaskID: "task", RelativePath: "docs/a.txt"}
	want := model.Attachment{ProjectID: address.ProjectID, TaskID: address.TaskID, Path: address.RelativePath, ContentType: "text/plain; charset=utf-8", SizeBytes: 17}
	reader := &metadataReader{result: want}
	got, err := Metadata(t.Context(), reader, address)
	if err != nil || got != want || reader.project != address.ProjectID || reader.task != address.TaskID || reader.path != address.RelativePath {
		t.Fatalf("metadata = %#v, %v; query = %#v", got, err, reader)
	}
	writer := &metadataWriter{result: want, created: true}
	got, created, err := PutMetadata(t.Context(), writer, address, want.ContentType, want.SizeBytes)
	if err != nil || got != want || !created || writer.input != want {
		t.Fatalf("put = %#v, %t, %v; input = %#v", got, created, err, writer.input)
	}
	if err := DeleteMetadata(t.Context(), writer, address); err != nil || writer.project != address.ProjectID || writer.task != address.TaskID || writer.path != address.RelativePath {
		t.Fatalf("delete = %v; query = %#v", err, writer)
	}

	failure := errors.New("database failure")
	for _, source := range []error{model.ErrNotFound, failure} {
		reader.err, writer.err = source, source
		_, readErr := Metadata(t.Context(), reader, address)
		_, _, putErr := PutMetadata(t.Context(), writer, address, want.ContentType, want.SizeBytes)
		deleteErr := DeleteMetadata(t.Context(), writer, address)
		if !errors.Is(readErr, source) || !errors.Is(putErr, source) || !errors.Is(deleteErr, source) {
			t.Fatalf("lost cause %v: read=%v put=%v delete=%v", source, readErr, putErr, deleteErr)
		}
		for _, gotErr := range []error{readErr, deleteErr} {
			var fault *model.Fault
			if errors.Is(source, model.ErrNotFound) {
				if !errors.As(gotErr, &fault) || fault.Code != "not_found" {
					t.Fatalf("missing metadata error = %v", gotErr)
				}
			} else if errors.As(gotErr, &fault) {
				t.Fatalf("database failure converted to fault: %v", gotErr)
			}
		}
	}
}

func TestAddressValidationAndConflictFailure(t *testing.T) {
	const id = "ab000000-0000-4000-8000-000000000001"
	for _, item := range []struct{ project, task, path string }{
		{"bad", id, "file"}, {id, "bad", "file"}, {id, id, "../file"}, {id, id, ""},
	} {
		if _, err := NewAddress(item.project, item.task, item.path); err == nil {
			t.Fatalf("accepted address %#v", item)
		}
	}
	for _, value := range []string{"", "text", "text/plain; charset", "text/plain; charset=utf-8; charset=latin1"} {
		if err := ValidateContentType(value); err == nil {
			t.Fatalf("accepted content type %q", value)
		}
	}
	for _, value := range []string{"application/octet-stream", "text/plain; charset=utf-8"} {
		if err := ValidateContentType(value); err != nil {
			t.Fatalf("rejected content type %q: %v", value, err)
		}
	}
	reader := &readerProbe{}
	if err := CheckPathConflict(t.Context(), reader, Address{RelativePath: "file"}); err != nil || len(reader.query.Ancestors) != 0 || reader.query.DescendantPrefix != "file/" {
		t.Fatalf("non-conflicting query = %#v, %v", reader.query, err)
	}
	failure := errors.New("unavailable")
	reader.err = failure
	if err := CheckPathConflict(t.Context(), reader, Address{RelativePath: "file"}); !errors.Is(err, failure) {
		t.Fatalf("conflict check lost cause: %v", err)
	}
	fault := StorageConflict(failure)
	if fault.Code != "path_conflict" || !errors.Is(fault, failure) {
		t.Fatalf("storage conflict = %v", fault)
	}
}

func TestCursorBoundsAndInvalidEncodings(t *testing.T) {
	for _, limit := range []int{0, -1, 101} {
		if _, err := ListQuery(model.PageRequest{Limit: limit}, "project", "task"); err == nil {
			t.Fatalf("accepted limit %d", limit)
		}
	}
	for _, limit := range []int{1, 100} {
		query, err := ListQuery(model.PageRequest{Limit: limit}, "project", "task")
		if err != nil || query.Limit != limit || query.After != nil {
			t.Fatalf("limit %d: %#v %v", limit, query, err)
		}
	}
	encode := func(value string) string { return base64.RawURLEncoding.EncodeToString([]byte(value)) }
	for _, value := range []string{
		"%%%", encode("{"),
		encode(`{"version":1,"kind":"attachments","projectId":"project","taskId":"task","path":"a"} true`),
		encode(`{"version":2,"kind":"attachments","projectId":"project","taskId":"task","path":"a"}`),
		encode(`{"version":1,"kind":"tasks","projectId":"project","taskId":"task","path":"a"}`),
		encode(`{"version":1,"kind":"attachments","projectId":"other","taskId":"task","path":"a"}`),
		encode(`{"version":1,"kind":"attachments","projectId":"project","taskId":"task","path":"../a"}`),
	} {
		if _, err := ListQuery(model.PageRequest{Limit: 1, Cursor: &value}, "project", "task"); err == nil {
			t.Fatalf("accepted cursor %q", value)
		}
	}
	items := []model.Attachment{{Path: "a"}}
	page, err := MakePage(store.AttachmentPage{Items: items}, "project", "task")
	if err != nil || page.NextCursor != nil || !reflect.DeepEqual(page.Items, items) {
		t.Fatalf("final page = %#v, %v", page, err)
	}
}

func TestContentTypeByteLimit(t *testing.T) {
	prefix, suffix := `text/plain; name="`, `"`
	for _, tc := range []struct {
		name, value string
		valid       bool
	}{
		{"ascii boundary", prefix + strings.Repeat("a", 2048-len(prefix)-len(suffix)) + suffix, true},
		{"ascii over", prefix + strings.Repeat("a", 2049-len(prefix)-len(suffix)) + suffix, false},
		{"utf8 boundary", prefix + strings.Repeat("界", 676) + strings.Repeat("a", 2048-len(prefix)-len(suffix)-676*3) + suffix, true},
		{"utf8 over", prefix + strings.Repeat("界", 676) + strings.Repeat("a", 2049-len(prefix)-len(suffix)-676*3) + suffix, false},
		{"invalid syntax", "text/plain; charset", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateContentType(tc.value)
			if tc.valid && err != nil {
				t.Fatalf("rejected %d bytes: %v", len(tc.value), err)
			}
			if !tc.valid {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "invalid_input" {
					t.Fatalf("accepted or wrong error for %d bytes: %v", len(tc.value), err)
				}
				if len(tc.value) > MaxContentTypeBytes && fault.Message != "Attachment content type must not exceed 2048 bytes." {
					t.Fatalf("unexpected message: %s", fault.Message)
				}
			}
		})
	}
}
