package mcptransfer

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func downloadPut(t *testing.T, proposed model.PrivateTransfer, version int64, returned model.PrivateTransfer, updatesTime bool) daoStep {
	t.Helper()
	expected := cloneTransfer(proposed)
	return daoStep{method: "Put", result: cloneTransfer(returned), check: func(args []any) {
		actual := cloneTransfer(args[0].(model.PrivateTransfer))
		if updatesTime {
			if actual.UpdatedAt.Before(expected.UpdatedAt) || actual.UpdatedAt.After(time.Now()) {
				t.Errorf("download update timestamp %s outside operation", actual.UpdatedAt)
			}
			actual.UpdatedAt = expected.UpdatedAt
		}
		if args[1] != version || !reflect.DeepEqual(actual, expected) {
			t.Errorf("download proposed update: %+v version=%v, want %+v version=%d", actual, args[1], expected, version)
		}
	}}
}

func downloadTimes(r model.PrivateTransfer) model.PrivateTransfer {
	r.ExpiresAt = time.Now().UTC().Add(10 * time.Second)
	r.HardExpiresAt = time.Now().UTC().Add(30 * time.Second)
	return r
}

func downloadPermit(t *testing.T, f lifecycleFixture, current model.PrivateTransfer) (*Permit, model.PrivateTransfer) {
	t.Helper()
	proposed := cloneTransfer(current)
	proposed.ExpiresAt = current.HardExpiresAt
	renewed := cloneTransfer(proposed)
	renewed.Version++
	f.expect(get(current), auth(f.actor, current, nil), get(current), downloadPut(t, proposed, current.Version, renewed, false))
	p, err := f.lifecycle.AcquirePermit(t.Context(), f.actor, current.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := p.Close(); err != nil {
			t.Error(err)
		}
	})
	return p, renewed
}

func TestAuthorizeWithoutTransfer(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	r := f.record()
	f.expect(auth(f.actor, r, nil))
	if err := f.lifecycle.Authorize(ctx, f.actor, f.binding.ProjectID, f.binding.TaskID); err != nil {
		t.Fatalf("authorized task: %v", err)
	}
	if err := f.lifecycle.Authorize(ctx, Actor{}, f.binding.ProjectID, f.binding.TaskID); err == nil {
		t.Fatal("invalid actor accepted")
	}
	for _, ids := range [][2]string{{"bad", f.binding.TaskID}, {f.binding.ProjectID, "bad"}} {
		if err := f.lifecycle.Authorize(ctx, f.actor, ids[0], ids[1]); err == nil {
			t.Fatalf("invalid task accepted: %v", ids)
		}
	}
	inaccessible := cloneTransfer(r)
	inaccessible.ProjectID = uuid.NewString()
	f.expect(auth(f.actor, inaccessible, model.ErrNotFound))
	if err := f.lifecycle.Authorize(ctx, f.actor, inaccessible.ProjectID, inaccessible.TaskID); err == nil {
		t.Fatal("inaccessible task accepted")
	}
	f.expect(auth(f.actor, r, model.ErrNotFound))
	if err := f.lifecycle.Authorize(ctx, f.actor, r.ProjectID, r.TaskID); err == nil {
		t.Fatal("revoked credential accepted")
	}
}

func TestTouchChecksAuthorityExpiryAndTerminalStates(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.binding.Direction = "download"
	r := downloadTimes(f.record())
	if _, err := f.lifecycle.Touch(ctx, Actor{}, r.ID); err == nil {
		t.Fatal("invalid actor accepted")
	}
	if _, err := f.lifecycle.Touch(ctx, f.actor, "bad"); !errors.Is(err, ErrConflict) {
		t.Fatalf("invalid ID: %v", err)
	}
	missing := uuid.NewString()
	f.expect(getMissing(missing))
	if _, err := f.lifecycle.Touch(ctx, f.actor, missing); err == nil {
		t.Fatal("unknown transfer accepted")
	}
	other := f.actor
	other.Principal.UserID = uuid.NewString()
	f.expect(get(r))
	if _, err := f.lifecycle.Touch(ctx, other, r.ID); err == nil {
		t.Fatal("different owner accepted")
	}
	proposed := cloneTransfer(r)
	proposed.ExpiresAt = r.HardExpiresAt
	touchedFact := cloneTransfer(proposed)
	touchedFact.Version++
	f.expect(get(r), auth(f.actor, r, nil), get(r), downloadPut(t, proposed, r.Version, touchedFact, true))
	touched, err := f.lifecycle.Touch(ctx, f.actor, r.ID)
	if err != nil || touched.Version <= r.Version || !touched.ExpiresAt.Equal(touched.HardExpiresAt) {
		t.Fatalf("hard expiry or version: %+v %v", touched, err)
	}
	expired := cloneTransfer(touchedFact)
	expired.ExpiresAt = time.Now().UTC().Add(-time.Second)
	f.expect(get(expired), auth(f.actor, expired, nil))
	if _, err := f.lifecycle.Touch(ctx, f.actor, r.ID); !errors.Is(err, ErrState) {
		t.Fatalf("expired transfer revived: %v", err)
	}
	for _, state := range []string{"cleanup_pending", "closed", "failed"} {
		terminal := cloneTransfer(expired)
		terminal.State = state
		f.expect(get(terminal), auth(f.actor, terminal, nil))
		observed, err := f.lifecycle.Touch(ctx, f.actor, terminal.ID)
		if err != nil || !reflect.DeepEqual(observed, terminal) {
			t.Fatalf("terminal %s changed: %+v %v", state, observed, err)
		}
	}
}

func TestPublishDownloadRequiresLiveBoundPermitAndAccountsReceipt(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	f.binding.Direction = "download"
	r := downloadTimes(f.record())
	data := json.RawMessage(`{"size":8}`)
	if _, err := f.lifecycle.PublishDownload(ctx, nil, f.actor, r.ID, data, 8); !errors.Is(err, ErrState) {
		t.Fatalf("nil permit: %v", err)
	}
	permit, renewed := downloadPermit(t, f, r)
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
	reserved := cloneTransfer(renewed)
	reserved.Version++
	reserved.ReservedBytes, reserved.OutstandingBytes = 8, 8
	f.expect(get(renewed), auth(f.actor, renewed, nil), method("LockLedger", nil, nil), method("OutstandingTotal", int64(0), nil), get(renewed), method("LockLedger", nil, nil), method("ReservedTotal", int64(0), nil), method("AddReservation", reserved, nil, r.ID, int64(8)))
	if got, err := f.lifecycle.Reserve(ctx, f.actor, r.ID, 8); err != nil || !reflect.DeepEqual(got, reserved) {
		t.Fatalf("reservation: %+v %v", got, err)
	}
	// Status renewal advances the configured current row before publication.
	touched := cloneTransfer(reserved)
	touched.Version++
	f.expect(get(reserved), auth(f.actor, reserved, nil), get(reserved), downloadPut(t, reserved, reserved.Version, touched, true))
	if _, err := f.lifecycle.Touch(ctx, f.actor, r.ID); err != nil {
		t.Fatal(err)
	}
	consumed := cloneTransfer(touched)
	consumed.Version++
	consumed.OutstandingBytes = 0
	proposed := cloneTransfer(consumed)
	proposed.State, proposed.Data = "readable", append(json.RawMessage(nil), data...)
	publishedFact := cloneTransfer(proposed)
	publishedFact.Version++
	f.expect(get(touched), auth(f.actor, touched, nil), get(touched), method("LockLedger", nil, nil), method("SubtractOutstanding", consumed, nil, r.ID, int64(8)), get(consumed), downloadPut(t, proposed, consumed.Version, publishedFact, true))
	published, err := f.lifecycle.PublishDownload(ctx, permit, f.actor, r.ID, data, 8)
	if err != nil || !reflect.DeepEqual(published, publishedFact) {
		t.Fatalf("publication receipt: %+v %v", published, err)
	}
	var receipt struct {
		Size int `json:"size"`
	}
	if json.Unmarshal(published.Data, &receipt) != nil || published.State != "readable" || published.OutstandingBytes != 0 || published.ReservedBytes != 8 || receipt.Size != 8 {
		t.Fatalf("publication accounting: %+v", published)
	}
	f.expect(get(publishedFact), auth(f.actor, publishedFact, nil))
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
	upload := downloadTimes(f.record())
	p, renewedUpload := downloadPermit(t, f, upload)
	f.expect(get(renewedUpload), auth(f.actor, renewedUpload, nil))
	if _, err := f.lifecycle.PublishDownload(ctx, p, f.actor, upload.ID, json.RawMessage(`{}`), 0); !errors.Is(err, ErrState) {
		t.Fatalf("upload accepted: %v", err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	f.binding.ID = uuid.NewString()
	f.binding.Direction = "download"
	download := downloadTimes(f.record())
	p, renewed := downloadPermit(t, f, download)
	expired := cloneTransfer(renewed)
	expired.ExpiresAt = time.Now().UTC().Add(-time.Second)
	f.expect(get(expired), auth(f.actor, expired, nil))
	if _, err := f.lifecycle.PublishDownload(ctx, p, f.actor, download.ID, json.RawMessage(`{}`), 0); !errors.Is(err, ErrState) {
		t.Fatalf("expired accepted: %v", err)
	}
}
