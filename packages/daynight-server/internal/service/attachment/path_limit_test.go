package attachment

import (
	"errors"
	"io"
	"strings"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestWritePathLimitAndLegacyAttachmentAccess(t *testing.T) {
	service, m, files, task, principal := attachmentUnit(t)
	ctx := t.Context()
	path := strings.Repeat(strings.Repeat("界", 50)+"/", 20) + "界界界界"
	legacy := path + "x"
	firstItem := attachmentItem(task, path, "text/plain", 6)
	planAttachmentPut(m, principal, task, firstItem, true)
	if _, _, err := service.Put(ctx, principal, task.ProjectID, task.ID, path, "text/plain", strings.NewReader("within")); err != nil {
		t.Fatalf("1024 characters: %v", err)
	}
	replacement := attachmentItem(task, path, "text/plain", 11)
	planAttachmentPut(m, principal, task, replacement, false)
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
	legacyItem := attachmentItem(task, legacy, "text/plain", 6)
	following := path + "y"
	followingItem := attachmentItem(task, following, "text/plain", 0)
	m.read(principal, task)
	m.expect("list", task.ProjectID, task.ID, store.AttachmentQuery{Limit: 1}).result = store.AttachmentPage{Items: []model.Attachment{replacement}, HasMore: true}
	first, err := service.List(ctx, principal, task.ProjectID, task.ID, model.PageRequest{Limit: 1})
	if err != nil || len(first.Items) != 1 || first.Items[0].Path != path || first.NextCursor == nil {
		t.Fatalf("first page: %+v %v", first, err)
	}
	m.read(principal, task)
	m.expect("list", task.ProjectID, task.ID, store.AttachmentQuery{Limit: 1, After: &path}).result = store.AttachmentPage{Items: []model.Attachment{legacyItem}, HasMore: true}
	second, err := service.List(ctx, principal, task.ProjectID, task.ID, model.PageRequest{Limit: 1, Cursor: first.NextCursor})
	if err != nil || len(second.Items) != 1 || second.Items[0].Path != legacy || second.NextCursor == nil {
		t.Fatalf("legacy page: %+v %v", second, err)
	}
	m.read(principal, task)
	m.expect("list", task.ProjectID, task.ID, store.AttachmentQuery{Limit: 1, After: &legacy}).result = store.AttachmentPage{Items: []model.Attachment{followingItem}}
	third, err := service.List(ctx, principal, task.ProjectID, task.ID, model.PageRequest{Limit: 1, Cursor: second.NextCursor})
	if err != nil || len(third.Items) != 1 || third.Items[0].Path != following {
		t.Fatalf("page after legacy cursor: %+v %v", third, err)
	}
	planAttachmentOpen(m, principal, task, legacyItem)
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
	planAttachmentDelete(m, principal, task, legacyItem)
	if err := service.Delete(ctx, principal, task.ProjectID, task.ID, legacy); err != nil {
		t.Fatalf("delete legacy: %v", err)
	}
}
