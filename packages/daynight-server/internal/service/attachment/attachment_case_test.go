package attachment

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
import (
	"context"
	"errors"
	"io"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

func TestAttachmentCaseDistinctPaths(t *testing.T) {
	attachments, _, _, _, task, principal := attachmentService(t)
	putAttachment(t, attachments, principal, task, "Case", "upper")
	_, _, err := attachments.Put(t.Context(), principal, task.ProjectID, task.ID, "case", "text/plain", strings.NewReader("lower"))
	if errors.Is(err, filestorage.ErrPathConflict) && runtime.GOOS == "darwin" {
		t.Skip("Case-distinct attachments require Linux or an explicit case-sensitive macOS volume")
	}
	if err != nil {
		t.Fatal(err)
	}
	for name, expected := range map[string]string{"Case": "upper", "case": "lower"} {
		_, object, err := attachments.Open(t.Context(), principal, task.ProjectID, task.ID, name)
		if err != nil {
			t.Fatal(err)
		}
		content, readErr := io.ReadAll(object.Body)
		if err := errors.Join(readErr, object.Body.Close()); err != nil || string(content) != expected {
			t.Fatalf("independent attachment %s: %q, %v", name, content, err)
		}
	}
}

func TestAttachmentFilesystemNameConflictPreservesMetadataAndBytes(t *testing.T) {
	attachments, _, database, files, task, principal := attachmentService(t)
	original := putAttachment(t, attachments, principal, task, "Case", "original")
	failed := NewAttachments(database, attachmentFaultStorage{Storage: files, put: errors.Join(filestorage.ErrPathConflict)})
	_, created, err := failed.Put(context.Background(), principal, task.ProjectID, task.ID, "case", "text/plain", strings.NewReader("rejected"))
	requireFault(t, err, "path_conflict")
	if created || !errors.Is(err, filestorage.ErrPathConflict) {
		t.Fatalf("conflict identity lost: created=%v err=%v", created, err)
	}
	page, err := attachments.List(t.Context(), principal, task.ProjectID, task.ID, model.PageRequest{Limit: 50})
	if err != nil || len(page.Items) != 1 || !reflect.DeepEqual(page.Items[0], original) {
		t.Fatalf("refused write changed metadata: %#v, %v", page, err)
	}
	_, object, err := attachments.Open(t.Context(), principal, task.ProjectID, task.ID, "Case")
	if err != nil {
		t.Fatal(err)
	}
	content, readErr := io.ReadAll(object.Body)
	if err := errors.Join(readErr, object.Body.Close()); err != nil || string(content) != "original" {
		t.Fatalf("refused write changed bytes: %q, %v", content, err)
	}
}
