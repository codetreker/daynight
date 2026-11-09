package attachment

import (
	"errors"
	"io"
	"io/fs"
	"reflect"
	"strings"
	"testing"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestContentTypeLimitAndLegacyAccess(t *testing.T) {
	service, m, files, task, principal := attachmentUnit(t)
	ctx := t.Context()
	prefix, suffix := `text/plain; name="`, `"`
	limit := prefix + strings.Repeat("界", 676) + strings.Repeat("a", 2048-len(prefix)-len(suffix)-676*3) + suffix
	over := limit[:len(limit)-1] + "a" + suffix
	expected := attachmentItem(task, "keep", limit, 8)
	planAttachmentPut(m, principal, task, expected, true)
	original, created, err := service.Put(ctx, principal, task.ProjectID, task.ID, "keep", limit, strings.NewReader("original"))
	if err != nil || !created || original.ContentType != limit {
		t.Fatalf("boundary write: %+v %v %v", original, created, err)
	}
	for _, path := range []string{"keep", "new"} {
		_, _, err := service.Put(ctx, principal, task.ProjectID, task.ID, path, over, strings.NewReader("replacement"))
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "invalid_input" || fault.Message != "Attachment content type must not exceed 2048 bytes." {
			t.Fatalf("over limit %s: %v", path, err)
		}
	}
	planAttachmentOpen(m, principal, task, original)
	metadata, object, err := service.Open(ctx, principal, task.ProjectID, task.ID, "keep")
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || string(data) != "original" || !reflect.DeepEqual(metadata, original) {
		t.Fatalf("changed existing attachment: %+v %q %v %v", metadata, data, readErr, closeErr)
	}
	address, err := attachmentcore.NewAddress(task.ProjectID, task.ID, "new")
	if err != nil {
		t.Fatal(err)
	}
	if object, err := files.Open(ctx, attachmentcore.Bucket, address.StoragePath); err == nil {
		object.Body.Close()
		t.Fatal("rejected write created a file")
	} else if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("checking rejected file: %v", err)
	}
	m.read(principal, task)
	m.expect("list", task.ProjectID, task.ID, store.AttachmentQuery{Limit: 10}).result = store.AttachmentPage{Items: []model.Attachment{original}}
	page, err := service.List(ctx, principal, task.ProjectID, task.ID, model.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], original) {
		t.Fatalf("configured metadata was not forwarded: %+v %v", page, err)
	}

	address, err = attachmentcore.NewAddress(task.ProjectID, task.ID, "legacy")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := files.Put(ctx, attachmentcore.Bucket, address.StoragePath, strings.NewReader("legacy")); err != nil {
		t.Fatal(err)
	}
	legacy := attachmentItem(task, "legacy", over, 6)
	planAttachmentOpen(m, principal, task, legacy)
	metadata, object, err = service.Open(ctx, principal, task.ProjectID, task.ID, "legacy")
	if err != nil {
		t.Fatal(err)
	}
	data, readErr = io.ReadAll(object.Body)
	closeErr = object.Body.Close()
	if readErr != nil || closeErr != nil || string(data) != "legacy" || !reflect.DeepEqual(metadata, legacy) || metadata.ContentType != over {
		t.Fatalf("legacy read: %+v %q %v %v", metadata, data, readErr, closeErr)
	}
	m.read(principal, task)
	m.expect("list", task.ProjectID, task.ID, store.AttachmentQuery{Limit: 10}).result = store.AttachmentPage{Items: []model.Attachment{original, legacy}}
	page, err = service.List(ctx, principal, task.ProjectID, task.ID, model.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 2 || !reflect.DeepEqual(page.Items[1], legacy) {
		t.Fatalf("legacy list: %+v %v", page, err)
	}
	planAttachmentDelete(m, principal, task, legacy)
	if err := service.Delete(ctx, principal, task.ProjectID, task.ID, "legacy"); err != nil {
		t.Fatalf("legacy delete: %v", err)
	}
	m.read(principal, task)
	m.expect("metadata", task.ProjectID, task.ID, "legacy").err = model.ErrNotFound
	_, _, err = service.Open(ctx, principal, task.ProjectID, task.ID, "legacy")
	requireFault(t, err, "not_found")
}
