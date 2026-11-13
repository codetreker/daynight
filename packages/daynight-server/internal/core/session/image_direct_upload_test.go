package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestDirectUploadPersistsAndReplaysOriginalFirstChunk(t *testing.T) {
	raw := bytes.Repeat([]byte("image"), 110000)
	f := newImageRuleFixture(t, raw)
	first := raw[:imageChunkBytes]
	input := sp.DirectImageContent{Spec: f.spec, Offset: "0", SHA256: imageBytesHash(first), Data: base64.StdEncoding.EncodeToString(first)}
	send := func(v sp.DirectImageContent) (sp.ImageUploadReceipt, bool, error) {
		return f.s.DirectUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, v)
	}
	bad := input
	bad.Data = ""
	if _, _, err := send(bad); err == nil || len(f.d.uploads) != 0 {
		t.Fatal("empty first chunk registered an identity", err)
	}
	bad = input
	bad.SHA256 = imageBytesHash([]byte("different"))
	if _, _, err := send(bad); err == nil || len(f.d.uploads) != 0 {
		t.Fatal("incorrect first digest registered an identity", err)
	}
	receipt, created, err := send(input)
	if err != nil || !created || receipt.AcceptedOffset != "524288" || len(f.d.chunks[f.spec.UploadID]) != 1 {
		t.Fatal("first durable prefix", receipt, created, err)
	}
	again, created, err := send(input)
	if err != nil || created || again.AcceptedOffset != receipt.AcceptedOffset || len(f.d.chunks[f.spec.UploadID]) != 1 {
		t.Fatal("replay changed the original", again, created, err)
	}
	verifying := f.d.uploads[f.spec.UploadID]
	verifying.Receipt.State = "verifying"
	f.d.uploads[f.spec.UploadID] = verifying
	again, _, err = send(input)
	if err != nil || again.State != "verifying" {
		t.Fatal("verifying replay lost the accepted prefix", again, err)
	}
	verifying.Receipt.State = "receiving"
	f.d.uploads[f.spec.UploadID] = verifying
	bad = input
	bad.Spec.Name = "changed.png"
	if _, _, err := send(bad); err == nil {
		t.Fatal("changed spec reused the identity")
	}
	if _, err := f.write(t, raw[imageChunkBytes:], imageChunkBytes); err != nil {
		t.Fatal(err)
	}
	completed, err := f.complete(t)
	if err != nil || completed.State != "complete" {
		t.Fatal("completion", completed, err)
	}
	again, created, err = send(input)
	if err != nil || created || again.State != "complete" || again.Resource == nil || again.Resource.ResourceID != completed.Resource.ResourceID {
		t.Fatal("completed replay did not use original bytes", again, created, err)
	}
}

func TestDirectUploadUnconfirmedFirstIntentRejectsChangedBytes(t *testing.T) {
	raw := []byte("original")
	f := newImageRuleFixture(t, raw)
	input := sp.DirectImageContent{Spec: f.spec, Offset: "0", SHA256: imageBytesHash(raw), Data: base64.StdEncoding.EncodeToString(raw)}
	ctx, cancel := context.WithCancel(t.Context())
	f.files.beforePut = func(string) { cancel() }
	if _, _, err := f.s.DirectUpload(ctx, f.p, "", "", f.r.Snapshot.SessionID, input); err == nil {
		t.Fatal("cancelled publication reported success")
	}
	if got := f.d.uploads[f.spec.UploadID].Receipt.AcceptedOffset; got != "0" || len(f.d.chunks[f.spec.UploadID]) != 1 {
		t.Fatal("first identity or unconfirmed prefix was lost", got)
	}
	f.files.beforePut = nil
	changed := []byte("changed!")
	other := input
	other.Data, other.SHA256 = base64.StdEncoding.EncodeToString(changed), imageBytesHash(changed)
	if _, _, err := f.s.DirectUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, other); err == nil {
		t.Fatal("a different first chunk took the original identity")
	}
	receipt, created, err := f.s.DirectUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, input)
	if err != nil || created || receipt.AcceptedOffset != "8" || len(f.d.chunks[f.spec.UploadID]) != 1 {
		t.Fatal("original first chunk could not resume", receipt, created, err)
	}
}

func TestDirectUploadPendingIntentResumesThroughLegacyChunkAndRechecksAccess(t *testing.T) {
	raw := []byte("original")
	f := newImageRuleFixture(t, raw)
	input := sp.DirectImageContent{Spec: f.spec, Offset: "0", SHA256: imageBytesHash(raw), Data: base64.StdEncoding.EncodeToString(raw)}
	ctx, cancel := context.WithCancel(t.Context())
	f.files.beforePut = func(string) { cancel() }
	if _, _, err := f.s.DirectUpload(ctx, f.p, "", "", f.r.Snapshot.SessionID, input); err == nil {
		t.Fatal("cancelled publication reported success")
	}
	f.files.beforePut = nil
	changed := []byte("changed!")
	if _, err := f.s.WriteUploadChunk(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID, sp.ImageChunkWrite{UploadID: f.spec.UploadID, Offset: "0", SHA256: imageBytesHash(changed), Data: base64.StdEncoding.EncodeToString(changed)}); err == nil {
		t.Fatal("legacy chunk overwrote the pending identity")
	}
	receipt, err := f.s.WriteUploadChunk(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec.UploadID, sp.ImageChunkWrite{UploadID: f.spec.UploadID, Offset: "0", SHA256: input.SHA256, Data: input.Data})
	if err != nil || receipt.AcceptedOffset != "8" || len(f.d.chunks[f.spec.UploadID]) != 1 {
		t.Fatal("legacy chunk did not resume the original intent", receipt, err)
	}
	originalBrowser := f.s.browserRun
	calls := 0
	f.s.browserRun = func(ctx context.Context, actor model.Principal, project, task, id string, purpose BrowserPurpose, fn func(*Access) error) error {
		calls++
		if calls == 3 {
			f.d.usage.Frozen = true
		}
		return originalBrowser(ctx, actor, project, task, id, purpose, fn)
	}
	if _, _, err := f.s.DirectUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, input); err == nil || calls != 3 {
		t.Fatal("replay ignored a freeze after reading original bytes", calls, err)
	}
}
