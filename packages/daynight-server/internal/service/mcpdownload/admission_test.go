package mcpdownload

import (
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

func TestOpenAdmitsOnlyNewContentAndPreservesBinding(t *testing.T) {
	f := newAdmissionFixture(t)
	in := f.openInput()
	busy := errors.New("content busy")
	f.expect(missingAdmissionRecord(in.TransferID), admissionStep{name: "admit", cause: busy})
	if result, err := f.service.ReadAdmitted(f.ctx, f.actor, in, f.admit); !errors.Is(err, busy) || result != nil {
		t.Fatalf("new content admission: %#v %v", result, err)
	}

	record, hash := f.readable(in, "content")
	touch, saved := f.touch(in, record)
	f.expect(committedAdmissionScope(admissionGet(record), f.authorize(in)), touch)
	repeated, err := f.service.ReadAdmitted(f.ctx, f.actor, in, f.admit)
	if err != nil || repeated["sha256"] != hash || repeated["state"] != "readable" ||
		repeated["transferId"] != in.TransferID || repeated["expiresAt"] != saved.ExpiresAt ||
		repeated["totalBytes"] != "7" || repeated["nextOffset"] != "0" {
		t.Fatalf("repeated open: %#v %v", repeated, err)
	}

	in.Path = "other"
	f.expect(committedAdmissionScope(admissionGet(saved), f.authorize(in)))
	if result, err := f.service.ReadAdmitted(f.ctx, f.actor, in, f.admit); !errors.Is(err, mcptransfer.ErrConflict) || result != nil {
		t.Fatalf("binding: %#v %v", result, err)
	}
}

func TestExistingOpenRejectsExpiredTransferWithoutContentAdmission(t *testing.T) {
	f := newAdmissionFixture(t)
	in := f.openInput()
	record, _ := f.readable(in, "content")
	record.CreatedAt = f.now.Add(-2 * time.Hour)
	record.UpdatedAt = record.CreatedAt
	record.ExpiresAt = f.now.Add(-time.Hour)
	record.HardExpiresAt = record.CreatedAt.Add(24 * time.Hour)
	f.expect(
		committedAdmissionScope(admissionGet(record), f.authorize(in)),
		failedAdmissionScope(mcptransfer.ErrState, admissionGet(record), f.authorize(in)),
	)
	if result, err := f.service.ReadAdmitted(f.ctx, f.actor, in, f.admit); !errors.Is(err, mcptransfer.ErrState) || result != nil {
		t.Fatalf("expired transfer: %#v %v", result, err)
	}
}
