package mcpdownload

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/storage/azblob/container"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/azure"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

type azureCleanupFailure struct {
	*azure.Storage
	failure error
}

func (s *azureCleanupFailure) DeleteTransferNamespace(ctx context.Context, n filestorage.TransferNamespace) error {
	if s.failure != nil {
		return s.failure
	}
	return s.Storage.DeleteTransferNamespace(ctx, n)
}

func newAzureAcceptanceStorage(t *testing.T) *azureCleanupFailure {
	t.Helper()
	connection := os.Getenv("DAYNIGHT_TEST_AZURITE_CONNECTION_STRING")
	if connection == "" {
		t.Skip("DAYNIGHT_TEST_AZURITE_CONNECTION_STRING is unset")
	}
	name := "daynight-download-" + strings.ReplaceAll(uuid.NewString(), "-", "")
	client, err := container.NewClientFromConnectionString(connection, name, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = client.Create(t.Context(), nil); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := client.Delete(ctx, nil); err != nil {
			t.Error(err)
		}
	})
	gates, err := local.NewStandaloneGates(name)
	if err != nil {
		t.Fatal(err)
	}
	storage, err := azure.New(client, gates, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return &azureCleanupFailure{Storage: storage}
}

func TestAzureAttachmentDownloadSnapshotAndCleanup(t *testing.T) {
	storage := newAzureAcceptanceStorage(t)
	original := []byte("a界b\x00tail")
	f := newAcceptanceFixtureWithStorage(t, storage, int64(len(original)))
	f.put(t, original)
	open := f.input
	open.Action, open.TransferID = "open", uuid.NewString()
	if _, err := f.service.Read(t.Context(), f.actor, open); err != nil {
		t.Fatal(err)
	}
	// An incomplete or oversized source must not replace the existing target.
	if _, _, err := f.attachments.Put(t.Context(), f.actor.Principal, f.input.ProjectID, f.input.TaskID, f.input.Path, "application/octet-stream", bytes.NewReader(bytes.Repeat([]byte("x"), int(attachmentcore.MaxFileBytes)+1))); err == nil {
		t.Fatal("oversized attachment accepted")
	}
	metadata, object, err := f.attachments.Open(t.Context(), f.actor.Principal, f.input.ProjectID, f.input.TaskID, f.input.Path)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(object.Body)
	closeErr := object.Body.Close()
	if err != nil || closeErr != nil || !bytes.Equal(body, original) || metadata.SizeBytes != int64(len(original)) {
		t.Fatalf("failed overwrite changed target: %q %+v %v %v", body, metadata, err, closeErr)
	}
	f.put(t, []byte("replacement"))
	chunk := open
	chunk.Action, chunk.Offset, chunk.Format, chunk.MaxBytes = "chunk", "1", "base64", 4
	part, err := f.service.Read(t.Context(), f.actor, chunk)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := base64.StdEncoding.DecodeString(part["contentBase64"].(string))
	if err != nil || !bytes.Equal(decoded, original[1:5]) || part["nextOffset"] != "5" || part["eof"] != false {
		t.Fatalf("snapshot range: %#v %v", part, err)
	}
	chunk.Offset = fmt.Sprint(len(original))
	eof, err := f.service.Read(t.Context(), f.actor, chunk)
	if err != nil || eof["readBytes"] != "0" || eof["eof"] != true {
		t.Fatalf("snapshot EOF: %#v %v", eof, err)
	}
	chunk.Offset = fmt.Sprint(len(original) + 1)
	if _, err := f.service.Read(t.Context(), f.actor, chunk); err == nil {
		t.Fatal("past EOF accepted")
	}

	// The PG budget continues to account for the original snapshot, regardless
	// of remote storage capacity.
	second := open
	second.TransferID = uuid.NewString()
	if _, err := f.service.Read(t.Context(), f.actor, second); err == nil {
		t.Fatal("budget accepted another snapshot")
	} else {
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "capacity_unavailable" {
			t.Fatalf("budget refusal: %v", err)
		}
	}
	closeInput := open
	closeInput.Action = "close"
	if _, err := f.service.Read(t.Context(), f.actor, closeInput); err != nil {
		t.Fatal(err)
	}
	failure := errors.New("injected Azure cleanup failure")
	storage.failure = failure
	if err := f.lifecycle.Maintain(t.Context()); !errors.Is(err, failure) {
		t.Fatalf("cleanup failure: %v", err)
	}
	pending, err := f.lifecycle.LookupBound(t.Context(), f.actor, open.TransferID)
	if err != nil || pending.State != "cleanup_pending" || pending.ReservedBytes != int64(len(original)) {
		t.Fatalf("cleanup released responsibility or budget: %+v %v", pending, err)
	}
	ns, _ := filestorage.NewTransferNamespace(open.TransferID)
	private, err := storage.OpenTransfer(t.Context(), ns, open.TransferID)
	if err != nil {
		t.Fatal(err)
	}
	if err := private.Body.Close(); err != nil {
		t.Fatal(err)
	}
	storage.failure = nil
	if err := f.lifecycle.Maintain(t.Context()); err != nil {
		t.Fatal(err)
	}
	closed, err := f.lifecycle.LookupBound(t.Context(), f.actor, open.TransferID)
	if err != nil || closed.State != "closed" || closed.ReservedBytes != 0 {
		t.Fatalf("successful cleanup: %+v %v", closed, err)
	}
}
