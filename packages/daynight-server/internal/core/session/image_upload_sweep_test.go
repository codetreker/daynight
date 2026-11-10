package session

import (
	"errors"
	"io/fs"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"github.com/google/uuid"
)

func TestUploadReclamationSweepsPublishedChunksWithoutMetadata(t *testing.T) {
	for _, expiry := range []bool{false, true} {
		t.Run(map[bool]string{false: "release", true: "expiry"}[expiry], func(t *testing.T) {
			f := newImageRuleFixture(t, []byte("original"))
			f.prepare(t)
			f.d.failChunk = true
			if _, err := f.write(t, []byte("original"), 0); err == nil || len(f.d.chunks[f.spec.UploadID]) != 0 {
				t.Fatal("fixture did not leave an uncommitted publication", err)
			}
			n, _ := sessionresource.NewNamespace("", f.p.UserID, f.r.Snapshot.SessionID)
			path, _ := n.ChunkPath(f.spec.UploadID, 0)
			other, _ := n.ChunkPath(uuid.NewString(), 0)
			if _, err := f.files.Put(t.Context(), sessionresource.Bucket, other, strings.NewReader("keep")); err != nil {
				t.Fatal(err)
			}
			if expiry {
				u := f.d.uploads[f.spec.UploadID]
				f.s.now = func() time.Time { return u.ExpiresAt }
				if _, err := f.s.GetUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); err != nil {
					t.Fatal(err)
				}
			} else if _, err := f.s.ReleaseUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID); err != nil {
				t.Fatal(err)
			}
			if !f.d.uploads[f.spec.UploadID].StorageReleased {
				t.Fatal("confirmed sweep did not settle storage")
			}
			if o, err := f.files.Open(t.Context(), sessionresource.Bucket, path); !errors.Is(err, fs.ErrNotExist) {
				if err == nil {
					_ = o.Body.Close()
				}
				t.Fatal("rowless chunk survived quota return", err)
			}
			o, err := f.files.Open(t.Context(), sessionresource.Bucket, other)
			if err != nil {
				t.Fatal("unrelated upload was removed", err)
			}
			_ = o.Body.Close()
		})
	}
}
