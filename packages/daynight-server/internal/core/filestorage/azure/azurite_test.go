package azure

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"
	"testing"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
)

type testGates struct{}

func (testGates) TryAcquireResidency(context.Context, string) (io.Closer, error) {
	return io.NopCloser(strings.NewReader("")), nil
}
func (testGates) AcquireGate(context.Context, filestorage.GateDomain, string) (io.Closer, error) {
	return io.NopCloser(strings.NewReader("")), nil
}
func (testGates) TryAcquireArchive(context.Context, string, string, int, bool) (io.Closer, error) {
	return io.NopCloser(strings.NewReader("")), nil
}

const owner = "11111111-1111-4111-8111-111111111111"
const task = "22222222-2222-4222-8222-222222222222"
const other = "33333333-3333-4333-8333-333333333333"
const objID = "44444444-4444-4444-8444-444444444444"
const testContainer = "daynight-object-contract"

func azurite(t *testing.T, create bool) (*Storage, *container.Client) {
	t.Helper()
	connection := os.Getenv("DAYNIGHT_TEST_AZURITE_CONNECTION_STRING")
	if connection == "" {
		t.Skip("DAYNIGHT_TEST_AZURITE_CONNECTION_STRING is unset")
	}
	c, err := container.NewClientFromConnectionString(connection, testContainer, nil)
	if err != nil {
		t.Fatal(err)
	}
	if create {
		if _, err = c.Create(t.Context(), nil); err != nil {
			t.Fatal(err)
		}
	}
	s, err := New(c, testGates{}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	page := int32(2)
	s.pageSize = &page
	return s, c
}
func put(t *testing.T, s *Storage, b, p, v string) {
	t.Helper()
	info, err := s.Put(t.Context(), b, p, strings.NewReader(v))
	if err != nil || info.Size != int64(len(v)) {
		t.Fatalf("put: %+v %v", info, err)
	}
}
func read(t *testing.T, o filestorage.Object) string {
	t.Helper()
	b, err := io.ReadAll(o.Body)
	if e := o.Body.Close(); err != nil || e != nil {
		t.Fatalf("read: %v close: %v", err, e)
	}
	return string(b)
}
func TestAzurite(t *testing.T) {
	s, c := azurite(t, true)
	if os.Getenv("DAYNIGHT_TEST_AZURITE_PRESERVE") != "1" {
		t.Cleanup(func() {
			_, err := c.Delete(context.Background(), nil)
			if err != nil {
				t.Error(err)
			}
		})
	}
	p := owner + "/22/" + task + "/" + strings.Repeat("長名/", 300) + "é.txt"
	key, err := BlobName("task-attachments", p)
	if err != nil || len(key) > 200 {
		t.Fatalf("key %q %v", key, err)
	}
	put(t, s, "task-attachments", p, "before-overwrite")
	old, err := s.Open(t.Context(), "task-attachments", p)
	if err != nil {
		t.Fatal(err)
	}
	head := make([]byte, 2)
	if _, err = io.ReadFull(old.Body, head); err != nil {
		t.Fatal(err)
	}
	put(t, s, "task-attachments", p, "new-content")
	if got := string(head) + read(t, old); got != "before-overwrite" {
		t.Fatalf("old view %q", got)
	}
	current, err := s.Open(t.Context(), "task-attachments", p)
	if err != nil || read(t, current) != "new-content" {
		t.Fatalf("current: %v", err)
	}
	n, _ := filestorage.NewTransferNamespace(task)
	target, _ := filestorage.NewTransferAttachmentTarget(owner, task, "published.txt")
	if _, err = s.PutTransfer(t.Context(), n, objID, strings.NewReader("abcdefgh")); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		offset, length int64
		want           string
	}{{2, 3, "cde"}, {8, 10, ""}, {20, 1, ""}, {0, 0, ""}, {6, 20, "gh"}} {
		o, e := s.OpenTransferRange(t.Context(), n, objID, tc.offset, tc.length)
		if e != nil || o.Info.Size != 8 {
			t.Fatalf("range: %+v %v", tc, e)
		}
		if got := read(t, o); got != tc.want {
			t.Fatalf("range: %q", got)
		}
	}
	if err = s.PublishTransferAttachment(t.Context(), n, objID, target); err != nil {
		t.Fatal(err)
	}
	got, err := s.Open(t.Context(), "task-attachments", target.Path())
	if err != nil || read(t, got) != "abcdefgh" {
		t.Fatalf("published: %v", err)
	}
	sibling, _ := filestorage.NewTransferNamespace(other)
	if _, err = s.PutTransfer(t.Context(), sibling, objID, strings.NewReader("neighbor")); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		put(t, s, transferBucket, n.Directory()+fmt.Sprintf("/orphan-%d", i), "orphan")
	}
	if err = s.DeleteTransferNamespace(t.Context(), n); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if _, err = s.Open(t.Context(), transferBucket, n.Directory()+fmt.Sprintf("/orphan-%d", i)); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("sweep %d: %v", i, err)
		}
	}
	neighbor, err := s.OpenTransfer(t.Context(), sibling, objID)
	if err != nil || read(t, neighbor) != "neighbor" {
		t.Fatalf("neighbor: %v", err)
	}
	archive, _ := sessionarchive.NewNamespace(sessionarchive.Projects, owner, task)
	resource, _ := sessionresource.NewNamespace(owner, "", task)
	upload, _ := resource.UploadPath(objID)
	adjacentArchive, _ := sessionarchive.NewNamespace(sessionarchive.Projects, owner, other)
	adjacentResource, _ := sessionresource.NewNamespace(owner, "", other)
	adjacentUpload, _ := resource.UploadPath(other)
	put(t, s, sessionarchive.Bucket, adjacentArchive.Directory()+"/keep", "keep")
	put(t, s, sessionresource.Bucket, adjacentResource.Directory()+"/keep", "keep")
	put(t, s, sessionresource.Bucket, adjacentUpload+"/0", "keep")
	for i := 0; i < 5; i++ {
		put(t, s, sessionresource.Bucket, upload+fmt.Sprintf("/%d", i), "part")
		put(t, s, sessionarchive.Bucket, archive.Directory()+fmt.Sprintf("/orphan-%d", i), "archive")
	}
	put(t, s, sessionresource.Bucket, resource.Directory()+"/other", "keep")
	if err = s.DeleteSessionUpload(t.Context(), resource, objID); err != nil {
		t.Fatal(err)
	}
	if err = s.DeleteSessionArchives(t.Context(), archive); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if _, err = s.Open(t.Context(), sessionresource.Bucket, upload+fmt.Sprintf("/%d", i)); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("upload part %d: %v", i, err)
		}
		if _, err = s.Open(t.Context(), sessionarchive.Bucket, archive.Directory()+fmt.Sprintf("/orphan-%d", i)); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("archive %d: %v", i, err)
		}
	}
	for _, pair := range [][2]string{{sessionarchive.Bucket, adjacentArchive.Directory() + "/keep"}, {sessionresource.Bucket, adjacentResource.Directory() + "/keep"}, {sessionresource.Bucket, adjacentUpload + "/0"}} {
		neighbor, err = s.Open(t.Context(), pair[0], pair[1])
		if err != nil || read(t, neighbor) != "keep" {
			t.Fatalf("adjacent: %v", err)
		}
	}
	neighbor, err = s.Open(t.Context(), sessionresource.Bucket, resource.Directory()+"/other")
	if err != nil || read(t, neighbor) != "keep" {
		t.Fatalf("resource neighbor: %v", err)
	}
	if err = s.DeleteSessionResources(t.Context(), resource); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Open(t.Context(), sessionresource.Bucket, adjacentUpload+"/0"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("resource upload sweep: %v", err)
	}
	if _, err = s.Open(t.Context(), sessionresource.Bucket, resource.Directory()+"/other"); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("resource sweep: %v", err)
	}
	if err = s.Delete(t.Context(), "task-attachments", target.Path()); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Open(t.Context(), "task-attachments", target.Path()); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("deleted: %v", err)
	}
	// Preserved for a separate process after the Azurite restart.
	put(t, s, "session-archives", "restart-confirmed", "persisted")
}
func TestAzuriteReopen(t *testing.T) {
	if os.Getenv("DAYNIGHT_TEST_AZURITE_REOPEN") != "1" {
		t.Skip("restart verification disabled")
	}
	s, c := azurite(t, false)
	defer func() {
		if _, err := c.Delete(context.Background(), nil); err != nil {
			t.Error(err)
		}
	}()
	o, err := s.Open(t.Context(), "session-archives", "restart-confirmed")
	if err != nil || read(t, o) != "persisted" {
		t.Fatalf("restart: %v", err)
	}
}
