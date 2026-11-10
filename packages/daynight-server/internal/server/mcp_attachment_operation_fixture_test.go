package server

import (
	"context"
	"errors"
	"io"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	uploadservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

func mcpAttachmentCallCount(t *testing.T, want int64) func() {
	t.Helper()
	var calls atomic.Int64
	t.Cleanup(func() {
		if got := calls.Load(); got != want {
			t.Errorf("MCP Attachment calls=%d, want %d", got, want)
		}
	})
	return func() {
		if got := calls.Add(1); got > want {
			t.Errorf("extra MCP Attachment call: %d > %d", got, want)
		}
	}
}

func mcpAttachmentWireExpected(item model.Attachment) map[string]any {
	return map[string]any{"path": item.Path, "contentType": item.ContentType, "sizeBytes": strconv.FormatInt(item.SizeBytes, 10), "createdAt": item.CreatedAt.Format(time.RFC3339Nano), "updatedAt": item.UpdatedAt.Format(time.RFC3339Nano)}
}

type mcpAttachmentOperations struct {
	t          *testing.T
	ListCall   func(context.Context, model.Principal, string, string, model.PageRequest) (attachmentcore.Page, error)
	DeleteCall func(context.Context, model.Principal, string, string, string) error
}

var _ application.AttachmentOperations = (*mcpAttachmentOperations)(nil)

func (o *mcpAttachmentOperations) missing(name string) error {
	o.t.Errorf("unexpected Attachment.%s call", name)
	return errors.New("unexpected Attachment." + name)
}
func (o *mcpAttachmentOperations) List(ctx context.Context, actor model.Principal, project, task string, request model.PageRequest) (attachmentcore.Page, error) {
	mcpOperationContext(o.t, ctx, actor)
	if o.ListCall == nil {
		return attachmentcore.Page{}, o.missing("List")
	}
	return o.ListCall(ctx, actor, project, task, request)
}
func (o *mcpAttachmentOperations) Delete(ctx context.Context, actor model.Principal, project, task, path string) error {
	mcpOperationContext(o.t, ctx, actor)
	if o.DeleteCall == nil {
		return o.missing("Delete")
	}
	return o.DeleteCall(ctx, actor, project, task, path)
}
func (o *mcpAttachmentOperations) Put(context.Context, model.Principal, string, string, string, string, io.Reader) (model.Attachment, bool, error) {
	return model.Attachment{}, false, o.missing("Put")
}
func (o *mcpAttachmentOperations) PutRetained(context.Context, model.Principal, string, string, string, string, io.Reader) (model.Attachment, bool, io.Closer, error) {
	return model.Attachment{}, false, nil, o.missing("PutRetained")
}
func (o *mcpAttachmentOperations) Open(context.Context, model.Principal, string, string, string) (model.Attachment, filestorage.Object, error) {
	return model.Attachment{}, filestorage.Object{}, o.missing("Open")
}
func (o *mcpAttachmentOperations) AdmitTransfer(context.Context, model.Principal, string, string, string, string, filestorage.TransferNamespace) (*attachmentservice.TransferAdmission, error) {
	return nil, o.missing("AdmitTransfer")
}
func (o *mcpAttachmentOperations) AcquireUploadLease(context.Context, model.Principal, string, string) (io.Closer, error) {
	return nil, o.missing("AcquireUploadLease")
}

func cloneMCPAttachmentPage(value attachmentcore.Page) attachmentcore.Page {
	if value.Items != nil {
		value.Items = append([]model.Attachment{}, value.Items...)
	}
	if value.NextCursor != nil {
		cursor := *value.NextCursor
		value.NextCursor = &cursor
	}
	return value
}
func (o *mcpAttachmentOperations) expectList(actor model.Principal, project, task string, request model.PageRequest, result attachmentcore.Page, resultErr error) {
	o.t.Helper()
	expected := request
	if request.Cursor != nil {
		cursor := *request.Cursor
		expected.Cursor = &cursor
	}
	frozen := cloneMCPAttachmentPage(result)
	called := mcpAttachmentCallCount(o.t, 1)
	o.ListCall = func(ctx context.Context, actual model.Principal, pid, tid string, got model.PageRequest) (attachmentcore.Page, error) {
		called()
		mcpAttachmentCheck(o.t, actual, actor)
		mcpAttachmentCheck(o.t, []string{pid, tid}, []string{project, task})
		mcpAttachmentCheck(o.t, got, expected)
		return cloneMCPAttachmentPage(frozen), resultErr
	}
}
func (o *mcpAttachmentOperations) expectDelete(actor model.Principal, project, task, path string, resultErr error) {
	called := mcpAttachmentCallCount(o.t, 1)
	o.DeleteCall = func(ctx context.Context, actual model.Principal, pid, tid, got string) error {
		called()
		mcpAttachmentCheck(o.t, actual, actor)
		mcpAttachmentCheck(o.t, []string{pid, tid, got}, []string{project, task, path})
		return resultErr
	}
}

type mcpUploadOperations struct {
	t    *testing.T
	mu   sync.Mutex
	call func(context.Context, transfer.Actor, string, string, uploadservice.UploadInput) (map[string]any, error)
}

var _ application.UploadOperations = (*mcpUploadOperations)(nil)

func cloneMCPUploadData(input map[string]any) map[string]any {
	if input == nil {
		return nil
	}
	out := make(map[string]any, len(input))
	for key, value := range input {
		if nested, ok := value.(map[string]any); ok {
			out[key] = cloneMCPUploadData(nested)
		} else {
			out[key] = value
		}
	}
	return out
}
func mcpUploadExpectedData(input map[string]any) map[string]any {
	out := make(map[string]any, len(input))
	for key, value := range input {
		switch item := value.(type) {
		case map[string]any:
			out[key] = mcpUploadExpectedData(item)
		case time.Time:
			out[key] = item.Format(time.RFC3339Nano)
		case int:
			out[key] = float64(item)
		case int64:
			out[key] = float64(item)
		default:
			out[key] = item
		}
	}
	return out
}

func (o *mcpUploadOperations) expect(actor transfer.Actor, project, task string, input uploadservice.UploadInput, result map[string]any, resultErr error, calls int) {
	o.t.Helper()
	count := 0
	frozen := cloneMCPUploadData(result)
	o.t.Cleanup(func() {
		o.mu.Lock()
		defer o.mu.Unlock()
		if count != calls {
			o.t.Errorf("Upload.Execute calls=%d, want %d for %s", count, calls, input.Action)
		}
	})
	o.mu.Lock()
	o.call = func(ctx context.Context, actual transfer.Actor, pid, tid string, got uploadservice.UploadInput) (map[string]any, error) {
		count++
		if count > calls {
			o.t.Errorf("extra Upload.Execute call for %s: %d > %d", input.Action, count, calls)
		}
		mcpAttachmentCheck(o.t, actual, actor)
		mcpAttachmentCheck(o.t, []string{pid, tid}, []string{project, task})
		mcpAttachmentCheck(o.t, got, input)
		return cloneMCPUploadData(frozen), resultErr
	}
	o.mu.Unlock()
}
func (o *mcpUploadOperations) Execute(ctx context.Context, actor transfer.Actor, project, task string, input uploadservice.UploadInput) (map[string]any, error) {
	mcpOperationContext(o.t, ctx, actor.Principal)
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.call == nil {
		o.t.Errorf("unexpected Upload.Execute call")
		return nil, errors.New("unexpected Upload.Execute")
	}
	return o.call(ctx, actor, project, task, input)
}
