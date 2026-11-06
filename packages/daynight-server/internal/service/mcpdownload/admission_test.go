package mcpdownload

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/google/uuid"
)

func TestOpenAdmitsOnlyNewContentAndPreservesBinding(t *testing.T) {
	f := newFixture(t)
	f.put(t, []byte("content"))
	in := f.input
	in.Action = "open"
	in.TransferID = uuid.NewString()
	busy := errors.New("content busy")
	calls := 0
	admit := func(context.Context) error { calls++; return busy }
	if result, err := f.service.ReadAdmitted(t.Context(), f.actor, in, admit); !errors.Is(err, busy) || result != nil || calls != 1 {
		t.Fatalf("new content admission: %#v %v %d", result, err, calls)
	}
	var count int
	if err := f.db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM private_transfers`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("busy created record: %d %v", count, err)
	}
	first := f.read(t, in)
	calls = 0
	repeated, err := f.service.ReadAdmitted(t.Context(), f.actor, in, admit)
	if err != nil || calls != 0 || repeated["sha256"] != first["sha256"] {
		t.Fatalf("repeated open: %#v %v %d", repeated, err, calls)
	}
	in.Path = "other"
	if _, err = f.service.ReadAdmitted(t.Context(), f.actor, in, admit); !errors.Is(err, mcptransfer.ErrConflict) || calls != 0 {
		t.Fatalf("binding: %v %d", err, calls)
	}
}

func TestExistingOpenRejectsExpiredTransferWithoutContentAdmission(t *testing.T) {
	f := newFixture(t)
	f.put(t, []byte("content"))
	in := f.input
	in.Action, in.TransferID = "open", uuid.NewString()
	f.read(t, in)
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE private_transfers SET expires_at=now()-interval '1 second' WHERE id=$1`, in.TransferID); err != nil {
		t.Fatal(err)
	}
	admitted := false
	_, err := f.service.ReadAdmitted(t.Context(), f.actor, in, func(context.Context) error { admitted = true; return nil })
	if !errors.Is(err, mcptransfer.ErrState) || admitted {
		t.Fatalf("expired transfer: %v admitted=%v", err, admitted)
	}
}
