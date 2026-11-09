package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestUploadChunkReceiptsAtomicWithReservationAndState(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	r := transferRecord(uuid.NewString(), time.Now().UTC())
	_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r, _, e = transfer.Create(ctx, d, r)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r, e = transfer.Reserve(ctx, d, r.ID, 10, 100)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	chunk := model.UploadChunk{TransferID: r.ID, ChunkID: uuid.NewString(), ObjectID: uuid.NewString(), Offset: 0, Size: 10, SHA256: strings.Repeat("a", 64)}
	rollback := errors.New("force receipt rollback")
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		if e := d.InsertUploadChunk(ctx, chunk); e != nil {
			return e
		}
		if _, e := transfer.ConsumeReservation(ctx, d, r.ID, chunk.Size, r.Version); e != nil {
			return e
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatalf("rollback: %v (cause: %v; database: %v)", err, errors.Unwrap(err), errors.Unwrap(errors.Unwrap(err)))
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		current, e := d.Get(ctx, r.ID)
		if e != nil {
			return e
		}
		if current.Version != r.Version || current.OutstandingBytes != 10 {
			t.Fatalf("reservation changed after rollback: %+v", current)
		}
		if _, e = d.UploadChunk(ctx, r.ID, chunk.ChunkID); !errors.Is(e, model.ErrNotFound) {
			t.Fatalf("receipt survived rollback: %v", e)
		}
		if e = d.InsertUploadChunk(ctx, chunk); e != nil {
			return e
		}
		current, e = transfer.ConsumeReservation(ctx, d, r.ID, chunk.Size, current.Version)
		if e != nil {
			return e
		}
		current.Data = []byte(`{"nextOffset":"10"}`)
		r, e = transfer.Update(ctx, d, current, current.Version)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.OutstandingBytes != 0 || r.ReservedBytes != 10 {
		t.Fatalf("wrong accounting: %+v", r)
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		current, e := d.Get(ctx, r.ID)
		if e != nil {
			return e
		}
		var progress struct {
			NextOffset string `json:"nextOffset"`
		}
		if err := json.Unmarshal(current.Data, &progress); err != nil {
			return err
		}
		if progress.NextOffset != "10" || current.Version != r.Version || current.ReservedBytes != 10 || current.OutstandingBytes != 0 {
			t.Fatalf("persisted chunk progress: %+v", current)
		}
		byID, e := d.UploadChunk(ctx, r.ID, chunk.ChunkID)
		if e != nil || byID != chunk {
			t.Fatalf("receipt by ID: %+v, %v", byID, e)
		}
		byOffset, e := d.UploadChunkAt(ctx, r.ID, 0)
		if e != nil || byOffset != chunk {
			t.Fatalf("receipt by offset: %+v, %v", byOffset, e)
		}
		_, e = d.UploadChunkAt(ctx, r.ID, 10)
		if !errors.Is(e, model.ErrNotFound) {
			t.Fatalf("unexpected next receipt: %v", e)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, duplicate := range []model.UploadChunk{
		chunk,
		{TransferID: r.ID, ChunkID: uuid.NewString(), ObjectID: uuid.NewString(), Offset: 0, Size: 10, SHA256: chunk.SHA256},
		{TransferID: r.ID, ChunkID: uuid.NewString(), ObjectID: chunk.ObjectID, Offset: 10, Size: 10, SHA256: chunk.SHA256},
	} {
		_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error { return d.InsertUploadChunk(ctx, duplicate) })
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "transfer_conflict" {
			t.Fatalf("duplicate receipt: %v", err)
		}
	}
	for _, bad := range []model.UploadChunk{
		{TransferID: r.ID, ChunkID: uuid.NewString(), ObjectID: uuid.NewString(), Size: 0, SHA256: chunk.SHA256},
		{TransferID: r.ID, ChunkID: uuid.NewString(), ObjectID: uuid.NewString(), Offset: math.MaxInt64, Size: 1, SHA256: chunk.SHA256},
		{TransferID: r.ID, ChunkID: uuid.NewString(), ObjectID: uuid.NewString(), Size: 1, SHA256: strings.Repeat("A", 64)},
	} {
		_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error { return d.InsertUploadChunk(ctx, bad) })
		if err == nil {
			t.Fatalf("database accepted invalid receipt: %+v", bad)
		}
	}
	retainUntil := time.Now().UTC().Add(time.Hour)
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		current, e := d.Get(ctx, r.ID)
		if e != nil {
			return e
		}
		current.State = "cleanup_pending"
		current, e = transfer.Update(ctx, d, current, current.Version)
		if e != nil {
			return e
		}
		_, e = transfer.Close(ctx, d, r.ID, current.Version, retainUntil)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		if _, e := d.UploadChunk(ctx, r.ID, chunk.ChunkID); e != nil {
			return e
		}
		pruned, e := transfer.Prune(ctx, d, retainUntil.Add(time.Second), 100)
		if e != nil || pruned != 1 {
			t.Fatalf("prune: %d, %v", pruned, e)
		}
		if _, e = d.UploadChunk(ctx, r.ID, chunk.ChunkID); !errors.Is(e, model.ErrNotFound) {
			t.Fatalf("receipt survived pruning: %v", e)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
