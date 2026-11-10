package session

import (
	"context"
	"encoding/base64"
	"io"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestImageCaptureJobsJoinOriginalCopyAndReleaseRejectedStaging(t *testing.T) {
	for _, rejected := range []bool{false, true} {
		name := "complete"
		if rejected {
			name = "rejected"
		}
		t.Run(name, func(t *testing.T) {
			raw := []byte("original")
			f := newImageRuleFixture(t, raw)
			c := registerOccurrenceFixture(t, f)
			v := sp.ValidatedImage{MediaType: "image/png", ByteLength: decimal(int64(len(raw))), SHA256: imageBytesHash(raw), Width: 2, Height: 3, FrameCount: 1}
			c.Validated = &v
			c.Receipt.State = "copying"
			f.d.captures[c.Request.CaptureID] = c
			entered, proceed, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
			var once sync.Once
			f.s.SetImageDecoder(func(ctx context.Context, input io.Reader, _ int64, _ string) (sp.ValidatedImage, error) {
				if _, e := io.ReadAll(input); e != nil {
					return v, e
				}
				close(entered)
				select {
				case <-proceed:
				case <-ctx.Done():
					return v, ctx.Err()
				}
				if rejected {
					return v, fault("invalid_image", "Rejected complete original.")
				}
				return v, nil
			})
			f.d.respond = func(row store.SessionMediaRequest) store.SessionMediaRequest {
				row.Complete = true
				row.Result = encode(sp.PreparedImageChunk{PreparationID: c.Receipt.AttemptID, ByteLength: v.ByteLength, SHA256: v.SHA256, Offset: "0", Data: base64.StdEncoding.EncodeToString(raw), EOF: true})
				return row
			}
			f.s.controllerRun = func(ctx context.Context, fence sp.ControllerFence, work func(*Access) error) error {
				if fence != f.r.Snapshot.ControllerFence {
					t.Error("capture used another controller fence")
				}
				e := work(&Access{tx: &operationTx{dao: f.d, op: &Operation{}}, record: f.r, write: true})
				current := f.d.captures[c.Request.CaptureID]
				if current.Receipt.State == "committed" || current.Receipt.State == "failed" && f.d.uploads[c.Receipt.AttemptID].StorageReleased {
					once.Do(func() { close(finished) })
				}
				return e
			}
			schedule := func() {
				tx := &operationTx{dao: f.d, op: &Operation{}}
				f.s.scheduleCapture(tx, f.r, c)
				tx.op.Finish(store.TransactionCommitted)
			}
			schedule()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("capture never reached complete decoder")
			}
			schedule()
			close(proceed)
			select {
			case <-finished:
			case <-time.After(5 * time.Second):
				t.Fatal("capture failed to publish or release original staging")
			}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			if e := f.s.Stop(ctx); e != nil {
				t.Fatal("capture background work failed to join", e)
			}
			current := f.d.captures[c.Request.CaptureID]
			if len(f.d.leases) != 0 || len(f.d.media) != 1 {
				t.Fatal("duplicate job or live lease remained", f.d.leases, len(f.d.media))
			}
			if rejected {
				if current.Receipt.State != "failed" || current.Receipt.ResourceID != nil || current.Receipt.Error == nil || len(f.d.resources) != 0 || !f.d.uploads[c.Receipt.AttemptID].StorageReleased {
					t.Fatal("rejected copy published or retained quota", current)
				}
				for _, chunk := range f.d.chunks[c.Receipt.AttemptID] {
					if file, e := f.files.Open(t.Context(), sessionresource.Bucket, chunk.Path); e == nil {
						file.Body.Close()
						t.Fatal("failed original chunk remained")
					}
				}
			} else if current.Receipt.State != "committed" || current.Receipt.Resource == nil || len(f.d.resources) != 1 {
				t.Fatal("original capture did not commit", current)
			}
		})
	}
}
