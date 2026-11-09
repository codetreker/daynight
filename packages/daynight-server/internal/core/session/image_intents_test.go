package session

import (
	"bytes"
	"context"
	"errors"
	"testing"

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
	f.r.Snapshot.Capabilities.Images = &sp.ImageCapabilities{Revision: "2", ExpectedNativeSessionID: f.r.Snapshot.Identity.NativeSessionID, Send: "supported", Steer: "unsupported"}
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
