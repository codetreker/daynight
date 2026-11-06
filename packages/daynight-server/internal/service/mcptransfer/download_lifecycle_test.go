package mcptransfer

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
)

func TestAuthorizeWithoutTransfer(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	if err := f.lifecycle.Authorize(ctx, f.actor, f.binding.ProjectID, f.binding.TaskID); err != nil {
		t.Fatalf("authorized task: %v", err)
	}
	if err := f.lifecycle.Authorize(ctx, Actor{}, f.binding.ProjectID, f.binding.TaskID); err == nil {
		t.Fatal("invalid actor accepted")
	}
	for _, ids := range [][2]string{{"bad", f.binding.TaskID}, {f.binding.ProjectID, "bad"}, {uuid.NewString(), f.binding.TaskID}} {
		if err := f.lifecycle.Authorize(ctx, f.actor, ids[0], ids[1]); err == nil {
			t.Fatalf("invalid or inaccessible task accepted: %v", ids)
		}
	}
	if _, err := f.db.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.actor.Principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	if err := f.lifecycle.Authorize(ctx, f.actor, f.binding.ProjectID, f.binding.TaskID); err == nil {
		t.Fatal("revoked credential accepted")
	}
}

func TestTouchChecksAuthorityExpiryAndTerminalStates(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.binding.Direction = "download"
	r := openRecord(t, f)
	if _, err := f.lifecycle.Touch(ctx, Actor{}, r.ID); err == nil {
		t.Fatal("invalid actor accepted")
	}
	if _, err := f.lifecycle.Touch(ctx, f.actor, "bad"); !errors.Is(err, ErrConflict) {
		t.Fatalf("invalid ID: %v", err)
	}
	if _, err := f.lifecycle.Touch(ctx, f.actor, uuid.NewString()); err == nil {
		t.Fatal("unknown transfer accepted")
	}
	other := f.actor
	other.Principal.UserID = uuid.NewString()
	if _, err := f.lifecycle.Touch(ctx, other, r.ID); err == nil {
		t.Fatal("different owner accepted")
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE private_transfers SET expires_at=now()+interval '10 seconds', hard_expires_at=now()+interval '30 seconds' WHERE id=$1`, r.ID); err != nil {
		t.Fatal(err)
	}
	touched, err := f.lifecycle.Touch(ctx, f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	if touched.Version <= r.Version || !touched.ExpiresAt.Equal(touched.HardExpiresAt) {
		t.Fatalf("hard expiry or version: %+v", touched)
	}
	if _, err := f.db.Pool.Exec(ctx, `UPDATE private_transfers SET expires_at=now()-interval '1 second' WHERE id=$1`, r.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.Touch(ctx, f.actor, r.ID); !errors.Is(err, ErrState) {
		t.Fatalf("expired transfer revived: %v", err)
	}
	pending, err := f.lifecycle.RequestCleanup(ctx, f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	pendingAgain, err := f.lifecycle.Touch(ctx, f.actor, r.ID)
	if err != nil || pendingAgain.State != "cleanup_pending" || pendingAgain.Version != pending.Version {
		t.Fatalf("pending: %+v %v", pendingAgain, err)
	}
	if err := f.lifecycle.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	closed, err := f.lifecycle.Touch(ctx, f.actor, r.ID)
	if err != nil || closed.State != "closed" {
		t.Fatalf("closed: %+v %v", closed, err)
	}
	f.binding.ID = uuid.NewString()
	failed := openRecord(t, f)
	failed, err = f.lifecycle.Transition(ctx, f.actor, failed.ID, failed.Version, "failed", json.RawMessage(`{}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	observed, err := f.lifecycle.Touch(ctx, f.actor, failed.ID)
	if err != nil || observed.State != "failed" || observed.Version != failed.Version {
		t.Fatalf("failed: %+v %v", observed, err)
	}
}

func TestPublishDownloadRequiresLiveBoundPermitAndAccountsReceipt(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.binding.Direction = "download"
	r := openRecord(t, f)
	data := json.RawMessage(`{"size":8}`)
	if _, err := f.lifecycle.PublishDownload(ctx, nil, f.actor, r.ID, data, 8); !errors.Is(err, ErrState) {
		t.Fatalf("nil permit: %v", err)
	}
	permit, err := f.lifecycle.AcquirePermit(ctx, f.actor, r.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	other := f.actor
	other.Principal.UserID = uuid.NewString()
	for _, tc := range []struct {
		actor Actor
		id    string
		size  int64
	}{{other, r.ID, 8}, {f.actor, uuid.NewString(), 8}, {f.actor, r.ID, -1}} {
		if _, err := f.lifecycle.PublishDownload(ctx, permit, tc.actor, tc.id, data, tc.size); !errors.Is(err, ErrState) {
			t.Fatalf("invalid permit binding: %v", err)
		}
	}
	if _, err := f.lifecycle.Transition(ctx, f.actor, r.ID, 0, "readable", data, nil); !errors.Is(err, ErrState) {
		t.Fatalf("unfenced transition: %v", err)
	}
	if _, err := f.lifecycle.TransitionPublished(ctx, permit, f.actor, r.ID, 0, "readable", data, nil, 8); !errors.Is(err, ErrState) {
		t.Fatalf("unfenced publication: %v", err)
	}
	if _, err := f.lifecycle.Reserve(ctx, f.actor, r.ID, 8); err != nil {
		t.Fatal(err)
	}
	// A concurrent status renewal advances the row version before publication.
	if _, err := f.lifecycle.Touch(ctx, f.actor, r.ID); err != nil {
		t.Fatal(err)
	}
	published, err := f.lifecycle.PublishDownload(ctx, permit, f.actor, r.ID, data, 8)
	if err != nil {
		t.Fatal(err)
	}
	var receipt struct {
		Size int `json:"size"`
	}
	if json.Unmarshal(published.Data, &receipt) != nil || published.State != "readable" || published.OutstandingBytes != 0 || published.ReservedBytes != 8 || receipt.Size != 8 {
		t.Fatalf("publication receipt: %+v", published)
	}
	if _, err := f.lifecycle.PublishDownload(ctx, permit, f.actor, r.ID, data, 0); !errors.Is(err, ErrState) {
		t.Fatalf("second publication: %v", err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.PublishDownload(ctx, permit, f.actor, r.ID, data, 0); !errors.Is(err, ErrState) {
		t.Fatalf("closed permit: %v", err)
	}
}

func TestPublishDownloadRejectsExpiredAndUpload(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	upload := openRecord(t, f)
	p, err := f.lifecycle.AcquirePermit(ctx, f.actor, upload.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.PublishDownload(ctx, p, f.actor, upload.ID, json.RawMessage(`{}`), 0); !errors.Is(err, ErrState) {
		t.Fatalf("upload accepted: %v", err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	f.binding.ID = uuid.NewString()
	f.binding.Direction = "download"
	download := openRecord(t, f)
	p, err = f.lifecycle.AcquirePermit(ctx, f.actor, download.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	if _, err := f.db.Pool.Exec(ctx, `UPDATE private_transfers SET expires_at=now()-interval '1 second' WHERE id=$1`, download.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.lifecycle.PublishDownload(ctx, p, f.actor, download.ID, json.RawMessage(`{}`), 0); !errors.Is(err, ErrState) {
		t.Fatalf("expired accepted: %v", err)
	}
}
