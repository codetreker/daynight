package attachment_test

import (
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestAttachmentHTTPUsesActualFilesystemNameCapabilities(t *testing.T) {
	root := t.TempDir()
	probe := filepath.Join(root, "case-probe")
	if err := os.WriteFile(probe, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	_, probeErr := os.Stat(filepath.Join(root, "CASE-PROBE"))
	if probeErr != nil && !errors.Is(probeErr, fs.ErrNotExist) {
		t.Fatal(probeErr)
	}
	sensitive := errors.Is(probeErr, fs.ErrNotExist)
	if !sensitive && runtime.GOOS != "darwin" {
		t.Fatal("Linux acceptance requires a case-sensitive storage root")
	}
	if err := os.Remove(probe); err != nil {
		t.Fatal(err)
	}
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	f := newAttachmentFixture(t, files, io.Discard)
	handler, task := f.handler, f.task
	canonical := attachmentFilePath(task, "Docs/File.txt")
	alias := attachmentFilePath(task, "docs/file.txt")
	item := f.item(task, "Docs/File.txt", "text/plain", 8)
	f.expectPut(task, item.Path, item.ContentType, item.SizeBytes, item, true)
	original := decodeResponse[api.Attachment](t, attachmentRequest(handler, http.MethodPut, canonical, "text/plain", []byte("original")), http.StatusCreated)
	f.verify()
	aliasItem := f.item(task, "docs/file.txt", "text/plain", 9)
	if sensitive {
		f.expectPut(task, aliasItem.Path, aliasItem.ContentType, aliasItem.SizeBytes, aliasItem, true)
	} else {
		f.expectAdmission(task, aliasItem.Path)
	}
	response := attachmentRequest(handler, http.MethodPut, alias, "text/plain", []byte("different"))
	f.verify()
	if sensitive {
		decodeResponse[api.Attachment](t, response, http.StatusCreated)
		f.expectRead(task, aliasItem.Path, aliasItem, nil)
		if got := attachmentRequest(handler, http.MethodGet, alias, "", nil); got.Code != http.StatusOK || got.Body.String() != "different" {
			t.Fatalf("case-distinct read: %d %s", got.Code, got.Body)
		}
		f.verify()
	} else {
		assertProjectError(t, response, http.StatusConflict, "path_conflict")
		f.expectList(task, store.AttachmentQuery{Limit: 50}, store.AttachmentPage{Items: []model.Attachment{item}}, nil)
		page := decodeResponse[api.AttachmentPage](t, attachmentRequest(handler, http.MethodGet, taskPath(task)+"/attachments", "", nil), http.StatusOK)
		f.verify()
		if len(page.Items) != 1 || page.Items[0] != original {
			t.Fatalf("case conflict changed attachment metadata: %#v", page)
		}
		for _, method := range []string{http.MethodGet, http.MethodDelete} {
			if method == http.MethodGet {
				f.expectRead(task, aliasItem.Path, model.Attachment{}, model.ErrNotFound)
			} else {
				f.expectDeleteMissing(task, aliasItem.Path)
			}
			assertProjectError(t, attachmentRequest(handler, method, alias, "", nil), http.StatusNotFound, "not_found")
			f.verify()
		}
	}
	f.expectRead(task, item.Path, item, nil)
	if got := attachmentRequest(handler, http.MethodGet, canonical, "", nil); got.Code != http.StatusOK || got.Body.String() != "original" {
		t.Fatalf("different spelling changed existing bytes: %d %s", got.Code, got.Body)
	}
	f.verify()
}
