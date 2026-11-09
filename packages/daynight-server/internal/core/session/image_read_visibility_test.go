package session

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func (d *imageRuleDAO) SessionResourceReadableBy(_ context.Context, session, resource, actor string) (bool, error) {
	for ref := range d.references {
		if ref.SessionID != session || ref.ResourceID != resource {
			continue
		}
		if ref.Kind == "message" || ref.Kind == "archive" {
			return true, nil
		}
		if ref.Kind == "upload" {
			u := d.uploads[ref.ReferenceID]
			if u.ActorID == actor && u.Receipt.State == "complete" && u.Receipt.Resource != nil && u.Receipt.Resource.ResourceID == resource {
				return true, nil
			}
		}
	}
	return false, nil
}

func TestSavedResourceReadsKeepUnsentUploadsPrivate(t *testing.T) {
	for _, kind := range []string{"private", "operation", "unknown", "native_resume", "message", "archive"} {
		t.Run(kind, func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			f.prepare(t)
			if _, err := f.write(t, []byte("original"), 0); err != nil {
				t.Fatal(err)
			}
			u, err := f.complete(t)
			if err != nil {
				t.Fatal(err)
			}
			input := sp.ImageReadRequest{ResourceID: u.Resource.ResourceID, Offset: "0", Limit: 8}
			bindImageBoundary(f, f.d, true)
			if _, err = f.s.ReadResource(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, input); err != nil {
				t.Fatal("upload actor lost private read", err)
			}
			if kind != "private" {
				f.d.references[store.SessionResourceReference{SessionID: f.r.Snapshot.SessionID, ResourceID: input.ResourceID, Kind: kind, ReferenceID: "original"}] = true
			}
			other := model.Principal{UserID: uuid.NewString()}
			bindImageBoundary(f, f.d, false)
			_, err = f.s.ReadResource(t.Context(), other, "", "", f.r.Snapshot.SessionID, input)
			published := kind == "message" || kind == "archive"
			if published && err != nil {
				t.Fatal("project reader lost published image", err)
			}
			if !published && !errors.Is(err, model.ErrNotFound) {
				t.Fatal("project reader received an unpublished original", kind, err)
			}
			if !published {
				ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
				defer cancel()
				data, _, err := f.s.Resource(ctx, other, "", "", f.r.Snapshot.SessionID, input.ResourceID)
				if !errors.Is(err, model.ErrNotFound) || len(data) != 0 {
					t.Fatal("legacy resource route bypassed private refusal", err)
				}
			}
			if len(f.d.leases) != 0 {
				t.Fatal("resource read leaked lease")
			}
		})
	}
}

func TestLegacyResourceWithoutExternalBlobRetainsControllerReader(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	resource := uuid.NewString()
	f.d.resources[resource] = store.SessionResourceRecord{SessionID: f.r.Snapshot.SessionID, Resource: sp.Resource{ResourceID: resource, Status: "available"}}
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	_, _, err := f.s.Resource(ctx, f.p, "", "", f.r.Snapshot.SessionID, resource)
	if !errors.Is(err, context.DeadlineExceeded) || errors.Is(err, errPrivateSessionResource) {
		t.Fatal("legacy row could not reach its Controller reader", err)
	}
}

func TestCompleteUploadRetainsOriginalVerifyingIdentityAfterDecoderCancellation(t *testing.T) {
	raw := []byte("png")
	f := newImageRuleFixture(t, raw)
	f.prepare(t)
	if _, err := f.write(t, raw, 0); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "started")
	decode, err := NewImageDecoder(decoderFixture(t, "cat >/dev/null\nprintf ready > '"+strings.ReplaceAll(marker, "'", "'\\''")+"'\nwhile :; do :; done\n"))
	if err != nil {
		t.Fatal(err)
	}
	f.s.SetImageDecoder(decode)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := f.s.completeUpload(ctx, f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID, sp.ImageUploadComplete{SHA256: f.spec.SHA256, ByteLength: f.spec.ByteLength}, false)
		done <- err
	}()
	deadline := time.After(3 * time.Second)
	for {
		if _, err := os.Stat(marker); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatal("completion exited before decoder cancellation barrier", err)
		case <-deadline:
			t.Fatal("completion did not reach decoder cancellation barrier")
		case <-time.After(time.Millisecond):
		}
	}
	cancel()
	select {
	case err = <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("transport cancellation became an image rejection", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled completion did not join")
	}
	u, err := f.s.GetUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID)
	if err != nil || u.State != "verifying" || u.Error != nil || len(f.d.resources) != 0 || f.d.uploads[f.spec.UploadID].StorageReleased || len(f.d.chunks[f.spec.UploadID]) != 1 {
		t.Fatal("cancellation discarded recoverable original", u, err)
	}
	decode, err = NewImageDecoder(decoderFixture(t, decoderReply(t, f.spec.SHA256, "", "1")))
	if err != nil {
		t.Fatal(err)
	}
	f.s.SetImageDecoder(decode)
	u, err = f.complete(t)
	if err != nil || u.State != "complete" || u.UploadID != f.spec.UploadID || u.Resource == nil || u.Resource.ResourceID != f.d.uploads[f.spec.UploadID].BlobID {
		t.Fatal("original upload could not resume after cancellation", u, err)
	}
}
