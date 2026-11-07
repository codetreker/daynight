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
)

func TestContentTypeLimitAndLegacyAccess(t *testing.T) {
	service, tasks, database, files, task, principal := attachmentService(t)
	ctx := t.Context()
	prefix, suffix := `text/plain; name="`, `"`
	limit := prefix + strings.Repeat("界", 676) + strings.Repeat("a", 2048-len(prefix)-len(suffix)-676*3) + suffix
	over := limit[:len(limit)-1] + "a" + suffix
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
	page, err := service.List(ctx, principal, task.ProjectID, task.ID, model.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], original) {
		t.Fatalf("rejected write changed metadata: %+v %v", page, err)
	}
	assertTaskUnchanged(t, tasks, principal, task)

	address, err = attachmentcore.NewAddress(task.ProjectID, task.ID, "legacy")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := files.Put(ctx, attachmentcore.Bucket, address.StoragePath, strings.NewReader("legacy")); err != nil {
		t.Fatal(err)
	}
	legacy, _, err := database.PutAttachment(ctx, model.Attachment{ProjectID: task.ProjectID, TaskID: task.ID, Path: "legacy", ContentType: over, SizeBytes: 6})
	if err != nil {
		t.Fatal(err)
	}
	metadata, object, err = service.Open(ctx, principal, task.ProjectID, task.ID, "legacy")
	if err != nil {
		t.Fatal(err)
	}
	data, readErr = io.ReadAll(object.Body)
	closeErr = object.Body.Close()
	if readErr != nil || closeErr != nil || string(data) != "legacy" || !reflect.DeepEqual(metadata, legacy) || metadata.ContentType != over {
		t.Fatalf("legacy read: %+v %q %v %v", metadata, data, readErr, closeErr)
	}
	page, err = service.List(ctx, principal, task.ProjectID, task.ID, model.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 2 || !reflect.DeepEqual(page.Items[1], legacy) {
		t.Fatalf("legacy list: %+v %v", page, err)
	}
	if err := service.Delete(ctx, principal, task.ProjectID, task.ID, "legacy"); err != nil {
		t.Fatalf("legacy delete: %v", err)
	}
	_, _, err = service.Open(ctx, principal, task.ProjectID, task.ID, "legacy")
	requireFault(t, err, "not_found")
	assertTaskUnchanged(t, tasks, principal, task)
}
