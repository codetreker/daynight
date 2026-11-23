package session

import (
	"errors"
	"io/fs"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestContentRefusalSettlesPublishedImageAndRetainsUnknown(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(map[bool]string{false: "capacity refusal", true: "unknown database result"}[unknown], func(t *testing.T) {
			raw := []byte("image")
			f := newImageRuleFixture(t, raw)
			if !unknown {
				ledger := archiveLedger{HistoryID: "saved", Entries: []archiveLedgerEntry{{ByteLength: int(MaxSessionContentBytes)}}, Occurrences: []archiveLedgerOccurrence{}}
				f.d.bundle.Ledger = encode(ledger)
			}
			f.prepare(t)
			if _, err := f.write(t, raw, 0); err != nil {
				t.Fatal(err)
			}
			upload := f.d.uploads[f.spec.UploadID]
			path, err := BlobAddress("", f.r.Owner, f.r.Snapshot.SessionID, upload.BlobID)
			if err != nil {
				t.Fatal(err)
			}
			if unknown {
				f.files.beforePut = func(string) { f.d.failSave = true }
			}
			_, err = f.complete(t)
			if err == nil {
				t.Fatal("failed publication returned success")
			}
			object, openErr := f.files.Open(t.Context(), sessionresource.Bucket, path)
			if openErr != nil {
				t.Fatalf("published original missing: %v", openErr)
			}
			if closeErr := object.Body.Close(); closeErr != nil {
				t.Fatal(closeErr)
			}
			row := f.d.uploads[f.spec.UploadID]
			if unknown {
				if row.Receipt.State != "verifying" || row.StorageReleased {
					t.Fatal("unknown outcome was finalized or cleaned", row)
				}
				return
			}
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "quota_exceeded" || row.Receipt.State != "failed" || row.Receipt.Error == nil || row.Receipt.Error.Code != "quota_exceeded" || len(f.d.resources) != 0 {
				t.Fatal("capacity refusal changed availability or lost receipt", row, err)
			}
			if err = f.s.cleanupUploadFiles(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); err != nil {
				t.Fatal(err)
			}
			if _, err = f.files.Open(t.Context(), sessionresource.Bucket, path); !errors.Is(err, fs.ErrNotExist) {
				t.Fatalf("rejected original remained after cleanup: %v", err)
			}
			if !f.d.uploads[f.spec.UploadID].StorageReleased {
				t.Fatal("cleanup completion was not recorded")
			}
		})
	}
}

func TestContentRefusalAtResourceCollectionLimit(t *testing.T) {
	raw := []byte("image")
	f := newImageRuleFixture(t, raw)
	length := "1"
	for i := 0; i < sp.MaxSessionResources; i++ {
		id := uuid.NewString()
		f.d.resources[id] = store.SessionResourceRecord{SessionID: f.r.Snapshot.SessionID, Resource: sp.Resource{ResourceID: id, Status: "available", Name: "existing", ByteLength: &length}}
	}
	f.prepare(t)
	if _, err := f.write(t, raw, 0); err != nil {
		t.Fatal(err)
	}
	upload := f.d.uploads[f.spec.UploadID]
	path, err := BlobAddress("", f.r.Owner, f.r.Snapshot.SessionID, upload.BlobID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.complete(t)
	var fault *model.Fault
	row := f.d.uploads[f.spec.UploadID]
	if !errors.As(err, &fault) || fault.Code != "quota_exceeded" || row.Receipt.State != "failed" || row.Receipt.Resource != nil || len(f.d.resources) != sp.MaxSessionResources {
		t.Fatalf("resource collection refusal: %+v resources=%d error=%v", row.Receipt, len(f.d.resources), err)
	}
	if _, exists := f.d.resources[upload.BlobID]; exists {
		t.Fatal("refused original became available")
	}
	if err = f.s.cleanupUploadFiles(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); err != nil {
		t.Fatal(err)
	}
	if _, err = f.files.Open(t.Context(), sessionresource.Bucket, path); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("rejected original remained after cleanup: %v", err)
	}
	if !f.d.uploads[f.spec.UploadID].StorageReleased {
		t.Fatal("cleanup completion was not recorded")
	}
}
