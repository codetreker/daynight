package attachment

import (
	"errors"
	"io"
	"strings"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestWritePathLimitAndLegacyAttachmentAccess(t *testing.T) {
	service, _, database, files, task, principal := attachmentService(t)
	ctx := t.Context()
	path := strings.Repeat(strings.Repeat("界", 50)+"/", 20) + "界界界界"
	legacy := path + "x"
	if _, _, err := service.Put(ctx, principal, task.ProjectID, task.ID, path, "text/plain", strings.NewReader("within")); err != nil {
		t.Fatalf("1024 characters: %v", err)
	}
	if _, _, err := service.Put(ctx, principal, task.ProjectID, task.ID, path, "text/plain", strings.NewReader("replacement")); err != nil {
		t.Fatalf("1024-character replacement: %v", err)
	}
	var fault *model.Fault
	if _, _, err := service.Put(ctx, principal, task.ProjectID, task.ID, legacy, "text/plain", strings.NewReader("rejected")); !errors.As(err, &fault) || fault.Code != "invalid_input" {
		t.Fatalf("1025-character write: %v", err)
	}
	address, err := attachmentcore.NewAddress(task.ProjectID, task.ID, legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := files.Put(ctx, attachmentcore.Bucket, address.StoragePath, strings.NewReader("legacy")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := database.PutAttachment(ctx, model.Attachment{ProjectID: task.ProjectID, TaskID: task.ID, Path: legacy, ContentType: "text/plain", SizeBytes: 6}); err != nil {
		t.Fatal(err)
	}
	following := path + "y"
	if _, _, err := database.PutAttachment(ctx, model.Attachment{ProjectID: task.ProjectID, TaskID: task.ID, Path: following, ContentType: "text/plain", SizeBytes: 0}); err != nil {
		t.Fatal(err)
	}
	first, err := service.List(ctx, principal, task.ProjectID, task.ID, model.PageRequest{Limit: 1})
	if err != nil || len(first.Items) != 1 || first.Items[0].Path != path || first.NextCursor == nil {
		t.Fatalf("first page: %+v %v", first, err)
	}
	second, err := service.List(ctx, principal, task.ProjectID, task.ID, model.PageRequest{Limit: 1, Cursor: first.NextCursor})
	if err != nil || len(second.Items) != 1 || second.Items[0].Path != legacy || second.NextCursor == nil {
		t.Fatalf("legacy page: %+v %v", second, err)
	}
	third, err := service.List(ctx, principal, task.ProjectID, task.ID, model.PageRequest{Limit: 1, Cursor: second.NextCursor})
	if err != nil || len(third.Items) != 1 || third.Items[0].Path != following {
		t.Fatalf("page after legacy cursor: %+v %v", third, err)
	}
	_, object, err := service.Open(ctx, principal, task.ProjectID, task.ID, legacy)
	if err != nil {
		t.Fatalf("open legacy: %v", err)
	}
	data, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || string(data) != "legacy" {
		t.Fatalf("legacy content %q: %v %v", data, readErr, closeErr)
	}
	if _, _, err := service.Put(ctx, principal, task.ProjectID, task.ID, legacy, "text/plain", strings.NewReader("blocked")); !errors.As(err, &fault) || fault.Code != "invalid_input" {
		t.Fatalf("legacy replacement accepted: %v", err)
	}
	if err := service.Delete(ctx, principal, task.ProjectID, task.ID, legacy); err != nil {
		t.Fatalf("delete legacy: %v", err)
	}
}
