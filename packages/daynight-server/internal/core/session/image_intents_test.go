package session

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type imageIntentDAO struct {
	*imageRuleDAO
	session, id        string
	raw                []byte
	insertErr, readErr error
}

type imageBeginDAO struct {
	*imageIntentDAO
	operation store.SessionOperation
}

func (d *imageBeginDAO) SessionOperation(context.Context, string, string) (store.SessionOperation, error) {
	return d.operation, nil
}

func TestImageBeginReturnsEffectiveAuthorizationBoundToOriginalIntent(t *testing.T) {
	for _, kind := range []string{"image", "text", "stale", "shrunk"} {
		t.Run(kind, func(t *testing.T) {
			f, c, _ := imageIntentFixture(t)
			if kind == "text" {
				c.Payload = []byte(`{"content":[{"type":"text","text":"hello"}],"expectedTurnId":null}`)
			}
			f.r.Snapshot.Capabilities.Send = true
			f.r.Snapshot.Activity, f.r.Snapshot.InitialInputState = "idle", "not_required"
			f.s.authorizationRun = func(context.Context, *Operation, store.SessionScope, model.Principal, Authority) error { return nil }
			epoch := int64(1)
			d := &imageBeginDAO{imageIntentDAO: &imageIntentDAO{imageRuleDAO: f.d}, operation: store.SessionOperation{Command: c, Actor: f.p, Epoch: &epoch, Receipt: sp.Operation{State: "dispatching"}}}
			tx := &operationTx{dao: d, op: &Operation{live: map[string]*liveSession{c.SessionID: {Commands: map[string]sp.Command{c.OperationID: c}}}}}
			if kind == "stale" {
				f.r.Snapshot.Capabilities.Images.Revision = "3"
			}
			if kind == "shrunk" {
				f.r.Snapshot.Capabilities.Images.Geometry.MaxWidth = 1
			}
			before := imageCommandHash(c)
			out, err := f.s.begin(t.Context(), tx, f.r, task{}, c.OperationID)
			if kind == "stale" || kind == "shrunk" {
				if err == nil || out != nil {
					t.Fatalf("stale image authorized: %v %v", out, err)
				}
				return
			}
			if err != nil || out["operationId"] != c.OperationID || out["sessionId"] != c.SessionID || out["connectionEpoch"] != f.r.Snapshot.ConnectionEpoch {
				t.Fatalf("authorization binding: %v %v", out, err)
			}
			image, exists := out["imageAuthorization"]
			if exists != (kind == "image") || exists && !jsonEqual(encode(image), encode(f.r.Snapshot.Capabilities.Images)) {
				t.Fatalf("authorization snapshot: %v", out)
			}
			if !bytes.Equal(before, imageCommandHash(c)) {
				t.Fatal("authorization rewrote intent")
			}
		})
	}
}

func (d *imageIntentDAO) InsertSessionOperationIntent(_ context.Context, session, id string, raw []byte) error {
	if d.insertErr != nil {
		return d.insertErr
	}
	d.session, d.id, d.raw = session, id, bytes.Clone(raw)
	return nil
}
func (d *imageIntentDAO) SessionOperationIntent(_ context.Context, session, id string) ([]byte, error) {
	if d.readErr != nil {
		return nil, d.readErr
	}
	if session != d.session || id != d.id {
		return nil, model.ErrNotFound
	}
	return bytes.Clone(d.raw), nil
}
func imageIntentFixture(t *testing.T) (imageRuleFixture, sp.Command, sp.SendMessage) {
	t.Helper()
	raw := []byte("original")
	f := newImageRuleFixture(t, raw)
	f.prepare(t)
	if _, e := f.write(t, raw, 0); e != nil {
		t.Fatal(e)
	}
	receipt, e := f.complete(t)
	if e != nil {
		t.Fatal(e)
	}
	f.r.Snapshot.Capabilities.Images = supportedImageRuleCapabilities(f.r.Snapshot.Identity.NativeSessionID)
	input := sp.SendMessage{Content: []sp.TextPart{{Type: "text", Text: "Use this original."}, {Type: "image", ImageID: f.spec.ImageID, UploadID: f.spec.UploadID, ResourceID: receipt.Resource.ResourceID, SHA256: f.spec.SHA256, ByteLength: f.spec.ByteLength}}, Target: &f.spec.Target, DraftID: uuid.NewString(), DraftRevision: "1", ExpectedImageCapabilityRevision: "2"}
	return f, sp.Command{Fence: f.r.Snapshot.Fence, ContentRevision: 2, Protocol: sp.Protocol, RequestID: "one", OperationID: uuid.NewString(), Kind: "send_message", Payload: encode(input)}, input
}
func TestImageIntentRequiresCompletedOriginalAndCurrentProviderProfile(t *testing.T) {
	for _, kind := range []string{"valid", "target", "capability", "native", "unsupported", "steer", "missing upload", "unfinished", "actor", "image", "hash", "size", "descriptor"} {
		t.Run(kind, func(t *testing.T) {
			f, c, input := imageIntentFixture(t)
			u := f.d.uploads[f.spec.UploadID]
			switch kind {
			case "target":
				input.Target = nil
			case "capability":
				input.ExpectedImageCapabilityRevision = "1"
			case "native":
				different := "replacement"
				f.r.Snapshot.Capabilities.Images.ExpectedNativeSessionID = &different
			case "unsupported":
				f.r.Snapshot.Capabilities.Images.Send = "unsupported"
			case "steer":
				turn := "turn"
				input.ExpectedTurnID = &turn
			case "missing upload":
				delete(f.d.uploads, f.spec.UploadID)
			case "unfinished":
				u.Receipt.State = "verifying"
				f.d.uploads[f.spec.UploadID] = u
			case "actor":
				u.ActorID = uuid.NewString()
				f.d.uploads[f.spec.UploadID] = u
			case "image":
				input.Content[1].ImageID = uuid.NewString()
			case "hash":
				input.Content[1].SHA256 = imageBytesHash([]byte("replacement"))
			case "size":
				input.Content[1].ByteLength = "1"
			case "descriptor":
				resource := f.d.resources[input.Content[1].ResourceID]
				resource.Resource.Name = "replacement"
				f.d.resources[input.Content[1].ResourceID] = resource
			}
			c.Payload = encode(input)
			e := f.s.authorizeImages(t.Context(), &operationTx{dao: f.d, op: &Operation{}}, f.r, c)
			if kind == "valid" {
				if e != nil {
					t.Fatal(e)
				}
			} else if e == nil {
				t.Fatal("changed image intent accepted")
			}
		})
	}
}

func TestImageIntentEnforcesEffectiveProfileOnEveryOriginal(t *testing.T) {
	for _, kind := range []string{"boundary", "mime", "bytes", "message bytes", "message sum", "count", "width", "height", "pixels", "frames", "unknown geometry", "missing geometry", "second image"} {
		t.Run(kind, func(t *testing.T) {
			f, c, input := imageIntentFixture(t)
			caps := f.r.Snapshot.Capabilities.Images
			caps.MaxImageBytes, caps.MaxMessageImageBytes, caps.MaxImagesPerMessage = f.spec.ByteLength, f.spec.ByteLength, 1
			caps.Geometry = sp.ImageGeometry{Version: 1, Known: true, MaxWidth: 2, MaxHeight: 3, MaxPixels: 6, MaxFrames: 1}
			switch kind {
			case "mime":
				caps.InputMediaTypes = []string{"image/jpeg"}
			case "bytes":
				caps.MaxImageBytes = decimal(number(f.spec.ByteLength) - 1)
			case "message bytes":
				caps.MaxMessageImageBytes = decimal(number(f.spec.ByteLength) - 1)
			case "width":
				caps.Geometry.MaxWidth--
			case "height":
				caps.Geometry.MaxHeight--
			case "pixels":
				caps.Geometry.MaxPixels--
			case "frames":
				caps.Geometry.MaxFrames--
			case "unknown geometry":
				caps.Geometry.Known = false
			case "missing geometry":
				u := f.d.uploads[f.spec.UploadID]
				u.Receipt.Resource.Width = nil
				resource := f.d.resources[u.BlobID]
				resource.Resource.Width = nil
				f.d.resources[u.BlobID] = resource
			case "second image", "message sum", "count":
				other := f
				other.spec.UploadID, other.spec.ImageID = uuid.NewString(), uuid.NewString()
				other.prepare(t)
				if _, e := other.write(t, []byte("original"), 0); e != nil {
					t.Fatal(e)
				}
				if kind == "second image" {
					decode := f.s.imageDecoder
					f.s.SetImageDecoder(func(ctx context.Context, reader io.Reader, size int64, hash string) (sp.ValidatedImage, error) {
						image, e := decode(ctx, reader, size, hash)
						image.Width = 3
						return image, e
					})
				}
				receipt, e := other.complete(t)
				if e != nil {
					t.Fatal(e)
				}
				part := input.Content[1]
				part.UploadID, part.ImageID, part.ResourceID = other.spec.UploadID, other.spec.ImageID, receipt.Resource.ResourceID
				input.Content = append(input.Content, part)
				caps.MaxImagesPerMessage, caps.MaxMessageImageBytes = 2, decimal(2*number(f.spec.ByteLength))
				if kind == "count" {
					caps.MaxImagesPerMessage = 1
				}
				if kind == "message sum" {
					caps.MaxMessageImageBytes = decimal(2*number(f.spec.ByteLength) - 1)
				}
			}
			c.Payload = encode(input)
			err := f.s.authorizeImages(t.Context(), &operationTx{dao: f.d}, f.r, c)
			if (err == nil) != (kind == "boundary") {
				t.Fatalf("profile admission: %v", err)
			}
			if len(f.d.references) != len(f.d.resources) {
				t.Fatal("admission partially pinned the message")
			}
		})
	}
}

func TestNewImageIntentRejectsExpiredPreparationWithoutInvalidatingOriginalOperation(t *testing.T) {
	for _, kind := range []string{"unused", "operation", "unknown", "message", "archive", "native_resume", "original operation"} {
		t.Run(kind, func(t *testing.T) {
			f, command, _ := imageIntentFixture(t)
			upload := f.d.uploads[f.spec.UploadID]
			upload.ExpiresAt = time.Now().Add(-time.Hour)
			f.d.uploads[f.spec.UploadID] = upload
			if kind != "unused" {
				ref := store.SessionResourceReference{SessionID: command.SessionID, ResourceID: upload.BlobID, Kind: kind, ReferenceID: "other operation"}
				if kind == "original operation" {
					ref.Kind, ref.ReferenceID = "operation", command.OperationID
				}
				f.d.references[ref] = true
			}
			err := f.s.authorizeImages(t.Context(), &operationTx{dao: f.d, op: &Operation{}}, f.r, command)
			if kind != "original operation" {
				var refusal *model.Fault
				if !errors.As(err, &refusal) || refusal.Code != "upload_expired" {
					t.Fatal("new intent accepted an expired preparation", kind, err)
				}
			} else if err != nil {
				t.Fatal("expiry invalidated the original operation", err)
			}
			if len(f.d.resources) != 1 || f.d.uploads[f.spec.UploadID].Receipt.State != "complete" {
				t.Fatal("input admission retired storage without cleanup")
			}
		})
	}
}
func TestImageIntentPersistenceKeepsCanonicalIdentityAndResumePins(t *testing.T) {
	f, c, _ := imageIntentFixture(t)
	d := &imageIntentDAO{imageRuleDAO: f.d}
	tx := &operationTx{dao: d, op: &Operation{}}
	if e := persistIntent(t.Context(), tx, c); e != nil {
		t.Fatal(e)
	}
	original := bytes.Clone(d.raw)
	hash := imageCommandHash(c)
	c.RequestID = "retry"
	if changed, e := canonicalIntent(c); e != nil || !bytes.Equal(changed, original) || !bytes.Equal(imageCommandHash(c), hash) {
		t.Fatal("request correlation changed durable intent", e)
	}
	resource := f.d.uploads[f.spec.UploadID].Receipt.Resource.ResourceID
	for _, kind := range []string{"operation", "native_resume"} {
		if !d.references[store.SessionResourceReference{SessionID: c.SessionID, ResourceID: resource, Kind: kind, ReferenceID: c.OperationID}] {
			t.Fatal("intent lost durable image pin", kind)
		}
	}
	if _, e := f.s.ReleaseUpload(t.Context(), f.p, "", "", c.SessionID, f.spec.UploadID); e == nil {
		t.Fatal("uncertain native input lost its original image")
	}
	f.s.SetImageDecoder(nil)
	recovered, ok, e := persistedIntent(t.Context(), tx, c.SessionID, c.OperationID)
	if e != nil || !ok || recovered.RequestID != "recovered" || !bytes.Equal(imageCommandHash(recovered), hash) {
		t.Fatal("recovery reconstructed a different input", recovered, ok, e)
	}
	if _, ok, e = persistedIntent(t.Context(), tx, c.SessionID, uuid.NewString()); e != nil || ok {
		t.Fatal("missing intent invented a result", ok, e)
	}
	d.raw = []byte(`{}`)
	if _, _, e = persistedIntent(t.Context(), tx, c.SessionID, c.OperationID); e == nil {
		t.Fatal("corrupt intent accepted")
	}
	d.raw = original
	d.readErr = errors.New("read outcome unavailable")
	if _, _, e = persistedIntent(t.Context(), tx, c.SessionID, c.OperationID); !errors.Is(e, d.readErr) {
		t.Fatal("read failure hidden", e)
	}
	d.insertErr = errors.New("commit outcome unknown")
	if e = persistIntent(t.Context(), tx, c); !errors.Is(e, d.insertErr) {
		t.Fatal("unconfirmed insert hidden", e)
	}
	missing := &operationTx{dao: &mediaRateMissingDAO{}}
	if e = persistIntent(t.Context(), missing, c); e == nil {
		t.Fatal("old store accepted image intent")
	}
	text := c
	text.Payload = []byte(`{"content":[{"type":"text","text":"legacy"}],"expectedTurnId":null}`)
	if e = persistIntent(t.Context(), missing, text); e != nil {
		t.Fatal("legacy text required new intent store", e)
	}
	if _, ok, e = persistedIntent(t.Context(), missing, c.SessionID, c.OperationID); e != nil || ok {
		t.Fatal("old store fabricated recovery", ok, e)
	}
}
