package mcptransfer

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

const (
	uploadUser      = "c1e49170-3c36-4f66-bc0b-f2703c23c837"
	uploadToken     = "ee9314b5-c679-40a9-a73a-57d7428e532b"
	uploadOperation = "cba72609-745d-43e0-8d0d-f701e70313c9"
)

func uploadRecord(now time.Time) model.PrivateTransfer {
	return model.PrivateTransfer{UserID: uploadUser, AuthorityKind: "pat", AuthorityID: uploadToken, Direction: "upload", State: "receiving", Version: 3, ExpiresAt: now.Add(time.Hour), HardExpiresAt: now.Add(24 * time.Hour)}
}

func TestUploadAdmissionAndReservationRules(t *testing.T) {
	now := time.Date(2026, 11, 6, 0, 0, 0, 0, time.UTC)
	r := uploadRecord(now)
	a := Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: uploadUser, CredentialID: uploadToken}, AuthorityKind: "pat", AuthorityID: uploadToken}
	if err := UploadAdmitted(r, a); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*model.PrivateTransfer){
		func(v *model.PrivateTransfer) { v.UserID = uploadToken },
		func(v *model.PrivateTransfer) { v.AuthorityID = uploadUser },
		func(v *model.PrivateTransfer) { v.AuthorityKind = "oauth" },
		func(v *model.PrivateTransfer) { v.Direction = "download" },
	} {
		v := r
		change(&v)
		if UploadAdmitted(v, a) != ErrConflict {
			t.Fatalf("binding admitted: %+v", v)
		}
	}
	for _, state := range []string{"receiving", "committing", "unknown", "cleanup_pending", "closed"} {
		v := r
		v.State = state
		wantReadable := state == "receiving" || state == "committing"
		if (UploadChunkReadable(v) == nil) != wantReadable {
			t.Errorf("readable state %s", state)
		}
		if (UploadReservationAllowed(v, 1, now) == nil) != (state == "receiving") {
			t.Errorf("reservation state %s", state)
		}
	}
	if UploadReservationAllowed(r, -1, now) != ErrState || UploadReservationAllowed(r, 1, r.ExpiresAt) != ErrState {
		t.Fatal("invalid or expired reservation accepted")
	}
	if UploadReservationAllowed(r, 0, now) != nil {
		t.Fatal("zero reservation refused")
	}
}

func TestUploadCommitLeaseAndCleanupRules(t *testing.T) {
	now := time.Date(2026, 11, 6, 0, 0, 0, 0, time.UTC)
	r := uploadRecord(now)
	data := json.RawMessage(`{"operationId":"` + uploadOperation + `"}`)
	if _, err := UploadStartCommit(r, []byte(`{}`), now); err != ErrState {
		t.Fatal("missing operation accepted")
	}
	if _, err := UploadStartCommit(r, data, r.ExpiresAt); err != ErrState {
		t.Fatal("expired transfer accepted")
	}
	got, err := UploadStartCommit(r, data, now)
	if err != nil || got.State != "committing" || got.LeaseUntil == nil || !got.LeaseUntil.Equal(now.Add(time.Minute)) || OperationID(got.Data) != uploadOperation {
		t.Fatalf("start: %+v %v", got, err)
	}
	if _, err := UploadStartCommit(got, data, now); err != ErrState {
		t.Fatal("commit replay accepted")
	}
	if _, err := UploadRenew(got, uploadToken, now); err != ErrState {
		t.Fatal("foreign renewal")
	}
	withoutLease := got
	withoutLease.LeaseUntil = nil
	if _, err := UploadRenew(withoutLease, uploadOperation, now); err != ErrState {
		t.Fatal("missing lease renewed")
	}
	if _, err := UploadRenew(got, uploadOperation, *got.LeaseUntil); err != ErrState {
		t.Fatal("expired lease revived")
	}
	later := now.Add(20 * time.Second)
	renewed, err := UploadRenew(got, uploadOperation, later)
	if err != nil || renewed.LeaseUntil == nil || !renewed.LeaseUntil.Equal(later.Add(time.Minute)) {
		t.Fatalf("renewal: %+v %v", renewed, err)
	}
	receiving, err := UploadRenew(r, "", later)
	if err != nil || !receiving.ExpiresAt.Equal(later.Add(IdleLifetime)) {
		t.Fatalf("receiving renewal: %+v %v", receiving, err)
	}
	closed := r
	closed.State = "cleanup_pending"
	if _, err := UploadRenew(closed, uploadOperation, now); err != ErrState {
		t.Fatal("cleanup barrier renewed")
	}
	closed.State = "unknown"
	if _, err := UploadRenew(closed, uploadOperation, now); err != ErrState {
		t.Fatal("unknown renewed")
	}
	if _, err := UploadMarkUnknown(got, uploadToken, data); err != ErrState {
		t.Fatal("foreign unknown receipt")
	}
	if _, err := UploadMarkUnknown(got, uploadOperation, json.RawMessage(`{"operationId":"`+uploadToken+`"}`)); err != ErrState {
		t.Fatal("unknown receipt changed operation identity")
	}
	corrupt := got
	corrupt.Data = json.RawMessage(`{}`)
	if _, err := UploadMarkUnknown(corrupt, "", corrupt.Data); err != ErrState {
		t.Fatal("invalid unknown operation identity accepted")
	}
	unknown, err := UploadMarkUnknown(got, uploadOperation, data)
	if err != nil || unknown.State != "unknown" || unknown.LeaseUntil != nil || OperationID(unknown.Data) != uploadOperation {
		t.Fatalf("unknown: %+v %v", unknown, err)
	}
	if _, err := UploadMarkUnknown(unknown, uploadOperation, data); err != ErrState {
		t.Fatal("unknown repeated")
	}
	if _, err := UploadRequestCleanup(unknown, uploadOperation); err != ErrState {
		t.Fatal("unknown terminal cleanup accepted")
	}
	committed := got
	committed.State = "committed"
	invalid := committed
	invalid.Data = json.RawMessage(`{}`)
	if _, err := UploadRequestCleanup(invalid, ""); err != ErrState {
		t.Fatal("invalid cleanup operation identity accepted")
	}
	if _, err := UploadRequestCleanup(committed, uploadToken); err != ErrState {
		t.Fatal("foreign cleanup")
	}
	pending, err := UploadRequestCleanup(committed, uploadOperation)
	if err != nil || pending.State != "cleanup_pending" || pending.LeaseUntil != nil || OperationID(pending.Data) != uploadOperation {
		t.Fatalf("cleanup: %+v %v", pending, err)
	}
	failed := committed
	failed.State = "failed"
	if _, err := UploadRequestCleanup(failed, uploadOperation); err != nil {
		t.Fatalf("failed cleanup: %v", err)
	}
}

func TestValidateUploadChunk(t *testing.T) {
	valid := model.UploadChunk{TransferID: uploadUser, ChunkID: uploadToken, ObjectID: uploadOperation, Offset: 0, Size: 524288, SHA256: strings.Repeat("a", 64)}
	if err := ValidateUploadChunk(valid); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*model.UploadChunk){
		func(c *model.UploadChunk) { c.TransferID = "bad" },
		func(c *model.UploadChunk) { c.ChunkID = "00000000-0000-0000-0000-000000000000" },
		func(c *model.UploadChunk) { c.ObjectID = strings.ToUpper(uploadOperation) },
		func(c *model.UploadChunk) { c.Offset = -1 },
		func(c *model.UploadChunk) { c.Size = 0 },
		func(c *model.UploadChunk) { c.Size = 524289 },
		func(c *model.UploadChunk) { c.Offset = math.MaxInt64 },
		func(c *model.UploadChunk) { c.SHA256 = strings.Repeat("a", 63) },
		func(c *model.UploadChunk) { c.SHA256 = strings.Repeat("A", 64) },
		func(c *model.UploadChunk) { c.SHA256 = strings.Repeat("z", 64) },
	} {
		v := valid
		change(&v)
		if ValidateUploadChunk(v) == nil {
			t.Errorf("invalid receipt accepted: %+v", v)
		}
	}
}

func TestAcceptUploadChunkAdvancesOnlyContiguousLiveReceipts(t *testing.T) {
	now := time.Date(2026, 11, 6, 0, 0, 0, 0, time.UTC)
	r := uploadRecord(now)
	r.ID = uploadUser
	r.HardExpiresAt = now.Add(30 * time.Minute)
	r.Data = EncodeUploadData(UploadData{NextOffset: 3})
	c := model.UploadChunk{TransferID: uploadUser, ChunkID: uploadToken, ObjectID: uploadOperation, Offset: 3, Size: 5, SHA256: strings.Repeat("a", 64)}
	got, err := AcceptUploadChunk(r, c, now)
	data, decodeErr := DecodeUploadData(got)
	if err != nil || decodeErr != nil || data.NextOffset != 8 || !got.ExpiresAt.Equal(r.HardExpiresAt) || got.State != "receiving" {
		t.Fatalf("accept: %+v %+v %v %v", got, data, err, decodeErr)
	}
	wrong := c
	wrong.Offset = 4
	if _, err := AcceptUploadChunk(r, wrong, now); err != ErrState {
		t.Fatal("gap accepted")
	}
	wrong = c
	wrong.TransferID = uploadToken
	if _, err := AcceptUploadChunk(r, wrong, now); err != ErrConflict {
		t.Fatal("different transfer accepted")
	}
	wrong = c
	wrong.Size = 0
	if _, err := AcceptUploadChunk(r, wrong, now); err == nil {
		t.Fatal("invalid chunk accepted")
	}
	expired := r
	expired.ExpiresAt = now
	if _, err := AcceptUploadChunk(expired, c, now); err != ErrState {
		t.Fatal("expired transfer accepted")
	}
	closed := r
	closed.State = "cleanup_pending"
	if _, err := AcceptUploadChunk(closed, c, now); err != ErrState {
		t.Fatal("cleanup barrier accepted")
	}
	corrupt := r
	corrupt.Data = []byte(`{`)
	if _, err := AcceptUploadChunk(corrupt, c, now); err == nil {
		t.Fatal("corrupt data accepted")
	}
}
