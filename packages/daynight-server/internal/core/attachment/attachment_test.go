package attachment

import (
	"context"
	"encoding/base64"
	"errors"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
)

type readerProbe struct {
	store.AttachmentReader
	query         store.AttachmentConflictQuery
	context       context.Context
	project, task string
	calls         int
	conflict      bool
	err           error
}

func TestCursorEncodedBoundBeforeDecode(t *testing.T) {
	path := strings.Repeat("😀", MaxPathCharacters)
	page, err := MakePage(store.AttachmentPage{Items: []model.Attachment{{Path: path}}, HasMore: true}, "project", "task")
	if err != nil || page.NextCursor == nil {
		t.Fatalf("cursor: %v", err)
	}
	if query, err := ListQuery(model.PageRequest{Limit: 1, Cursor: page.NextCursor}, "project", "task"); err != nil || query.After == nil || *query.After != path {
		t.Fatalf("max path cursor: %v", err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(*page.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, []byte(strings.Repeat(" ", transport.MaxEncodedCursorBytes*3/4-len(raw)))...)
	boundary := base64.RawURLEncoding.EncodeToString(raw)
	if len(boundary) != transport.MaxEncodedCursorBytes {
		t.Fatal("bad fixture")
	}
	if _, err := ListQuery(model.PageRequest{Limit: 1, Cursor: &boundary}, "project", "task"); err != nil {
		t.Fatalf("boundary rejected: %v", err)
	}
	tooLong := boundary + "A"
	if _, err := ListQuery(model.PageRequest{Limit: 1, Cursor: &tooLong}, "project", "task"); err == nil {
		t.Fatal("accepted oversized cursor")
	}
	oversized := strings.Repeat("A", 1<<20)
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	_, _ = ListQuery(model.PageRequest{Limit: 1, Cursor: &oversized}, "project", "task")
	runtime.ReadMemStats(&after)
	if used := after.TotalAlloc - before.TotalAlloc; used > 64<<10 {
		t.Fatalf("oversized cursor allocated %d bytes", used)
	}
}

func (r *readerProbe) AttachmentPathConflict(ctx context.Context, project, task string, query store.AttachmentConflictQuery) (bool, error) {
	r.context, r.project, r.task = ctx, project, task
	r.calls++
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
	if !reflect.DeepEqual(probe.query, want) || probe.context != t.Context() || probe.project != address.ProjectID || probe.task != address.TaskID || probe.calls != 1 {
		t.Fatalf("conflict delegation: query=%#v context=%v project=%q task=%q calls=%d; want query=%#v address=%#v", probe.query, probe.context, probe.project, probe.task, probe.calls, want, address)
	}
	segments := make([]string, 13)
	for index := range segments {
		segments[index] = strings.Repeat("中", 78)
	}
	segments[12] = strings.Repeat("中", 76)
	boundaryPath := strings.Join(segments, "/")
	if utf8.RuneCountInString(boundaryPath) != 1024 {
		t.Fatal("incorrect transport path geometry")
	}
	ancestors := make([]string, 0, 12)
	for end := 1; end < len(segments); end++ {
		ancestors = append(ancestors, strings.Join(segments[:end], "/"))
	}
	for _, original := range []struct {
		path      string
		ancestors []string
	}{
		{path: boundaryPath, ancestors: ancestors},
		{path: "😀", ancestors: []string{}},
	} {
		const projectID = "c3333333-3333-4333-8333-333333333333"
		const taskID = "d4444444-4444-4444-8444-444444444444"
		address, err := NewAddress(projectID, taskID, original.path)
		expectedAddress := Address{ProjectID: projectID, TaskID: taskID, RelativePath: original.path, StoragePath: projectID + "/d4/" + taskID + "/" + original.path}
		if err != nil || address != expectedAddress {
			t.Fatalf("transport address: got=%#v want=%#v error=%v", address, expectedAddress, err)
		}
		if err := ValidateWritePath(address.RelativePath); err != nil {
			t.Fatalf("transport write path: %v", err)
		}
		probe := &readerProbe{}
		err = CheckPathConflict(t.Context(), probe, address)
		expectedQuery := store.AttachmentConflictQuery{Ancestors: append([]string{}, original.ancestors...), DescendantPrefix: original.path + "/"}
		if err != nil || probe.calls != 1 || probe.context != t.Context() || probe.project != projectID || probe.task != taskID || !reflect.DeepEqual(probe.query, expectedQuery) {
			t.Fatalf("transport conflict query: got=%#v want=%#v calls=%d context=%v project=%s task=%s error=%v", probe.query, expectedQuery, probe.calls, probe.context, probe.project, probe.task, err)
		}
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
	putContext, deleteContext context.Context
	putCalls, deleteCalls     int
	input                     model.Attachment
	project, task, path       string
	result                    model.Attachment
	created                   bool
	err                       error
}

func (w *metadataWriter) PutAttachment(ctx context.Context, input model.Attachment) (model.Attachment, bool, error) {
	w.putContext = ctx
	w.putCalls++
	w.input = input
	return w.result, w.created, w.err
}

func (w *metadataWriter) DeleteAttachment(ctx context.Context, project, task, path string) error {
	w.deleteContext = ctx
	w.deleteCalls++
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
	if err != nil || got != want || !created || writer.input != want || writer.putContext != t.Context() || writer.putCalls != 1 {
		t.Fatalf("put = %#v, %t, %v; input = %#v", got, created, err, writer.input)
	}
	if err := DeleteMetadata(t.Context(), writer, address); err != nil || writer.project != address.ProjectID || writer.task != address.TaskID || writer.path != address.RelativePath || writer.deleteContext != t.Context() || writer.deleteCalls != 1 {
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

	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	writer = &metadataWriter{err: context.Canceled}
	got, created, err = PutMetadata(ctx, writer, address, want.ContentType, want.SizeBytes)
	if !errors.Is(err, context.Canceled) || got != (model.Attachment{}) || created || writer.putContext != ctx || writer.putContext.Err() != context.Canceled || writer.putCalls != 1 || writer.input != want {
		t.Fatalf("canceled metadata put: result=%#v created=%v error=%v context=%v calls=%d input=%#v", got, created, err, writer.putContext, writer.putCalls, writer.input)
	}
	err = DeleteMetadata(ctx, writer, address)
	if !errors.Is(err, context.Canceled) || writer.deleteContext != ctx || writer.deleteContext.Err() != context.Canceled || writer.deleteCalls != 1 || writer.project != address.ProjectID || writer.task != address.TaskID || writer.path != address.RelativePath {
		t.Fatalf("canceled metadata delete: error=%v context=%v calls=%d address=%s/%s/%s", err, writer.deleteContext, writer.deleteCalls, writer.project, writer.task, writer.path)
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
