package session

import (
	"context"
	"encoding/json"
	"io"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestInputLimitEnforcementDoesNotEnableProductionProfiles(t *testing.T) {
	f := newImageRuleFixture(t, []byte("original"))
	var provider sp.ProviderImageCapabilities
	if err := json.Unmarshal(encode(f.r.Snapshot.Capabilities.Images), &provider); err != nil {
		t.Fatal(err)
	}
	if err := f.s.refreshImageState(t.Context(), &operationTx{dao: f.d}, f.r, &provider); err != nil {
		t.Fatal(err)
	}
	if caps := f.r.Snapshot.Capabilities.Images; caps.Send != "unsupported" || caps.Steer != "unsupported" || caps.ProviderRevision != provider.Revision {
		t.Fatalf("unqualified profile became available: %+v", caps)
	}
}

func TestUploadCompletionUsesCurrentInputProfileWithoutRestrictingDisplay(t *testing.T) {
	for _, kind := range []string{"boundary", "mime", "bytes", "message bytes", "count", "width", "height", "pixels", "frames", "unknown", "changed before publication", "display"} {
		t.Run(kind, func(t *testing.T) {
			raw := []byte("original")
			f := newImageRuleFixture(t, raw)
			f.prepare(t)
			if _, err := f.write(t, raw, 0); err != nil {
				t.Fatal(err)
			}
			caps := f.r.Snapshot.Capabilities.Images
			frames := 1
			caps.MaxImageBytes, caps.MaxMessageImageBytes, caps.MaxImagesPerMessage = f.spec.ByteLength, f.spec.ByteLength, 1
			caps.Geometry = sp.ImageGeometry{Version: 1, Known: true, MaxWidth: 2, MaxHeight: 3, MaxPixels: 6, MaxFrames: 1}
			switch kind {
			case "mime":
				caps.InputMediaTypes = []string{"image/jpeg"}
			case "bytes":
				caps.MaxImageBytes = "7"
			case "message bytes":
				caps.MaxMessageImageBytes = "7"
			case "count":
				caps.MaxImagesPerMessage = 0
			case "width":
				caps.Geometry.MaxWidth--
			case "height":
				caps.Geometry.MaxHeight--
			case "pixels":
				caps.Geometry.MaxPixels--
			case "frames":
				frames = 2
				decode := f.s.imageDecoder
				f.s.SetImageDecoder(func(ctx context.Context, reader io.Reader, size int64, hash string) (sp.ValidatedImage, error) {
					image, err := decode(ctx, reader, size, hash)
					image.FrameCount = frames
					return image, err
				})
			case "unknown", "display":
				f.r.Snapshot.Capabilities.Images = nil
			case "changed before publication":
				f.files.beforePut = func(string) { caps.Geometry.MaxWidth = 1 }
			}
			f.d.respond = func(row store.SessionMediaRequest) store.SessionMediaRequest {
				row.Complete = true
				state := "receiving"
				var image *sp.ValidatedImage
				if row.Action == "complete" {
					state = "validated"
					image = &sp.ValidatedImage{MediaType: f.spec.MediaType, ByteLength: f.spec.ByteLength, SHA256: f.spec.SHA256, Width: 2, Height: 3, FrameCount: frames}
				}
				if row.Action == "release" {
					state = "released"
				}
				row.Result = encode(sp.LocalImagePreparation{UploadID: f.spec.UploadID, ImageID: f.spec.ImageID, Target: f.spec.Target, State: state, AcceptedOffset: f.spec.ByteLength, Validated: image})
				return row
			}
			receipt, err := f.s.completeUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID, sp.ImageUploadComplete{SHA256: f.spec.SHA256, ByteLength: f.spec.ByteLength}, kind != "display")
			if kind == "boundary" || kind == "display" {
				if err != nil || receipt.State != "complete" || len(f.d.resources) != 1 {
					t.Fatalf("original not published: %+v %v", receipt, err)
				}
			} else if err == nil || len(f.d.resources) != 0 || f.d.uploads[f.spec.UploadID].Receipt.Resource != nil {
				t.Fatalf("out-of-profile original published: %+v %v", receipt, err)
			}
		})
	}
}
