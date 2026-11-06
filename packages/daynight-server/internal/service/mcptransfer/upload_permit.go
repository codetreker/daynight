package mcptransfer

import (
	"context"
	"encoding/json"
	"time"

	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// admittedUpload performs short internal operations for the holder of the
// original private gate. External requests still enter through LookupBound and
// AcquirePermit, which revalidate the current credential and task permission.
func (s *Lifecycle) admittedUpload(ctx context.Context, p *Permit, fn func(store.PrivateTransferDAO, model.PrivateTransfer) error) error {
	if p == nil || p.owner != s {
		return transfer.ErrState
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return transfer.ErrState
	}
	return s.transaction(ctx, func(d store.PrivateTransferDAO) error {
		r, e := d.Get(ctx, p.id)
		if e != nil {
			return e
		}
		if e = transfer.UploadAdmitted(r, p.actor); e != nil {
			return e
		}
		return fn(d, r)
	})
}

func (s *Lifecycle) uploadChunkAt(ctx context.Context, p *Permit, offset int64) (model.UploadChunk, error) {
	var result model.UploadChunk
	err := s.admittedUpload(ctx, p, func(d store.PrivateTransferDAO, r model.PrivateTransfer) error {
		if e := transfer.UploadChunkReadable(r); e != nil {
			return e
		}
		var e error
		result, e = d.UploadChunkAt(ctx, r.ID, offset)
		return e
	})
	return result, err
}

func (s *Lifecycle) reserveAdmittedUpload(ctx context.Context, p *Permit, additional int64) (model.PrivateTransfer, error) {
	var result model.PrivateTransfer
	err := s.admittedUpload(ctx, p, func(d store.PrivateTransferDAO, r model.PrivateTransfer) error {
		if e := transfer.UploadReservationAllowed(r, additional, time.Now()); e != nil {
			return e
		}
		if e := d.LockLedger(ctx); e != nil {
			return e
		}
		free, e := s.private.AvailableTransferBytes(ctx)
		if e != nil {
			return e
		}
		total, e := d.OutstandingTotal(ctx)
		if e != nil {
			return e
		}
		if free < s.reservedFree || total > free-s.reservedFree || additional > free-s.reservedFree-total {
			return transfer.ErrCapacity
		}
		result, e = transfer.Reserve(ctx, d, r.ID, additional, s.budget)
		return e
	})
	return result, err
}

func (s *Lifecycle) startAdmittedCommit(ctx context.Context, p *Permit, data json.RawMessage) (model.PrivateTransfer, error) {
	var result model.PrivateTransfer
	err := s.admittedUpload(ctx, p, func(d store.PrivateTransferDAO, r model.PrivateTransfer) error {
		next, e := transfer.UploadStartCommit(r, data, time.Now().UTC())
		if e != nil {
			return e
		}
		result, e = transfer.Update(ctx, d, next, r.Version)
		return e
	})
	return result, err
}

// keepAdmittedUpload extends only the holder's live operation. It never revives
// an expired commit lease or a namespace whose cleanup barrier is established.
func (s *Lifecycle) keepAdmittedUpload(ctx context.Context, p *Permit, opID string) error {
	return s.admittedUpload(ctx, p, func(d store.PrivateTransferDAO, r model.PrivateTransfer) error {
		next, e := transfer.UploadRenew(r, opID, time.Now().UTC())
		if e != nil {
			return e
		}
		_, e = transfer.Update(ctx, d, next, r.Version)
		return e
	})
}

func (s *Lifecycle) admittedUploadRecord(ctx context.Context, p *Permit) (model.PrivateTransfer, error) {
	var result model.PrivateTransfer
	err := s.admittedUpload(ctx, p, func(_ store.PrivateTransferDAO, r model.PrivateTransfer) error { result = r; return nil })
	return result, err
}

func (s *Lifecycle) markAdmittedUnknown(ctx context.Context, p *Permit, opID string, data json.RawMessage) error {
	return s.admittedUpload(ctx, p, func(d store.PrivateTransferDAO, r model.PrivateTransfer) error {
		next, e := transfer.UploadMarkUnknown(r, opID, data)
		if e != nil {
			return e
		}
		_, e = transfer.Update(ctx, d, next, r.Version)
		return e
	})
}

// requestAdmittedCleanup records a terminal operation's cleanup barrier while
// its original permit still prevents physical removal. A later sweep reclaims it.
func (s *Lifecycle) requestAdmittedCleanup(ctx context.Context, p *Permit, opID string) error {
	return s.admittedUpload(ctx, p, func(d store.PrivateTransferDAO, r model.PrivateTransfer) error {
		next, e := transfer.UploadRequestCleanup(r, opID)
		if e != nil {
			return e
		}
		_, e = transfer.Update(ctx, d, next, r.Version)
		return e
	})
}
