package session

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

type refusingUploadGate struct {
	filestorage.Storage
	err error
}

func (s refusingUploadGate) AcquireGate(context.Context, filestorage.GateDomain, string) (io.Closer, error) {
	return nil, s.err
}

func TestDirectUploadAdmissionPreservesIdentityOnRefusal(t *testing.T) {
	for _, kind := range []string{"body limit", "missing storage", "gate", "frozen", "wrong target", "duplicate image", "rate limit"} {
		t.Run(kind, func(t *testing.T) {
			raw := []byte("original")
			f := newImageRuleFixture(t, raw)
			input := sp.DirectImageContent{Spec: f.spec, Offset: "0", SHA256: imageBytesHash(raw), Data: base64.StdEncoding.EncodeToString(raw)}
			gateErr := errors.New("upload gate unavailable")
			switch kind {
			case "body limit":
				input.Data = strings.Repeat("a", 1<<20)
			case "missing storage":
				f.s.files = nil
			case "gate":
				f.s.files = refusingUploadGate{Storage: f.files, err: gateErr}
			case "frozen":
				f.d.usage.Frozen = true
			case "wrong target":
				input.Spec.Target.Fence.ExecutionGeneration = "2"
			case "duplicate image":
				f.prepare(t)
				input.Spec.UploadID = "00000000-0000-4000-8000-000000000001"
			case "rate limit":
				f.d.rateDeny = "prepare"
			}
			before := len(f.d.uploads)
			_, _, err := f.s.DirectUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, input)
			if err == nil || kind == "gate" && !errors.Is(err, gateErr) {
				t.Fatalf("%s admission unexpectedly succeeded: %v", kind, err)
			}
			if len(f.d.uploads) != before || len(f.d.chunks[input.Spec.UploadID]) != 0 {
				t.Fatal("refusal created a new upload or first intent")
			}
		})
	}
}

func TestDirectUploadResumesOriginalPendingFile(t *testing.T) {
	for _, stored := range []string{"original", "changed!"} {
		t.Run(stored, func(t *testing.T) {
			raw := []byte("original")
			f := newImageRuleFixture(t, raw)
			input := sp.DirectImageContent{Spec: f.spec, Offset: "0", SHA256: imageBytesHash(raw), Data: base64.StdEncoding.EncodeToString(raw)}
			receipt, created, err := f.s.prepareUploadIdentityWithFirst(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec, true, &input)
			if err != nil || !created || receipt.AcceptedOffset != "0" || len(f.d.chunks[f.spec.UploadID]) != 1 {
				t.Fatal("first identity and intent", receipt, created, err)
			}
			path := f.d.chunks[f.spec.UploadID][0].Path
			if _, err = f.files.Put(t.Context(), sessionresource.Bucket, path, strings.NewReader(stored)); err != nil {
				t.Fatal(err)
			}
			got, created, err := f.s.DirectUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, input)
			if stored != "original" {
				if err == nil || f.d.uploads[f.spec.UploadID].Receipt.AcceptedOffset != "0" {
					t.Fatal("different pending bytes were accepted", got, err)
				}
				return
			}
			if err != nil || created || got.AcceptedOffset != "8" || len(f.d.chunks[f.spec.UploadID]) != 1 {
				t.Fatal("existing identical original was not resumed", got, created, err)
			}
		})
	}
}

func TestDirectUploadBindsFirstChunkToExistingLegacyIdentity(t *testing.T) {
	raw := []byte("original")
	f := newImageRuleFixture(t, raw)
	old := f.prepare(t)
	input := sp.DirectImageContent{Spec: f.spec, Offset: "0", SHA256: imageBytesHash(raw), Data: base64.StdEncoding.EncodeToString(raw)}
	receipt, created, err := f.s.DirectUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, input)
	if err != nil || created || receipt.AcceptedOffset != "8" || receipt.ExpiresAt != old.ExpiresAt || len(f.d.chunks[f.spec.UploadID]) != 1 {
		t.Fatal("existing legacy identity was not bound to the real first chunk", receipt, created, err)
	}
}

func TestDirectUploadNeverWritesFailedFirstIntent(t *testing.T) {
	raw := []byte("original")
	f := newImageRuleFixture(t, raw)
	input := sp.DirectImageContent{Spec: f.spec, Offset: "0", SHA256: imageBytesHash(raw), Data: base64.StdEncoding.EncodeToString(raw)}
	if _, _, err := f.s.prepareUploadIdentityWithFirst(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, f.spec, true, &input); err != nil {
		t.Fatal(err)
	}
	row := f.d.uploads[f.spec.UploadID]
	row.Receipt.State = "failed"
	row.Receipt.Error = &sp.ImageError{Code: "storage_unavailable", Message: "Original storage failed."}
	f.d.uploads[f.spec.UploadID] = row
	writes := 0
	f.files.beforePut = func(string) { writes++ }
	if _, _, err := f.s.DirectUpload(t.Context(), f.p, "", "", f.r.Snapshot.SessionID, input); err == nil {
		t.Fatal("failed first intent accepted a replay")
	}
	if writes != 0 || f.d.uploads[f.spec.UploadID].Receipt.State != "failed" || f.d.uploads[f.spec.UploadID].Receipt.AcceptedOffset != "0" || len(f.d.chunks[f.spec.UploadID]) != 1 {
		t.Fatal("failed first intent changed or published bytes")
	}
}

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
