package mcptransfer

import (
	"context"
	"encoding/json"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// admittedUpload performs short internal operations for the holder of the
// original private gate. External requests still enter through LookupBound and
// AcquirePermit, which revalidate the current credential and task permission.
func (s *Lifecycle) admittedUpload(ctx context.Context, p *Permit, fn func(store.PrivateTransferDAO, model.PrivateTransfer) error) error {
	if p == nil || p.owner != s {
		return ErrState
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return ErrState
	}
	return s.transaction(ctx, func(d store.PrivateTransferDAO) error {
		r, e := d.Get(ctx, p.id)
		if e != nil {
			return e
		}
		if r.UserID != p.actor.Principal.UserID || r.AuthorityKind != p.actor.AuthorityKind || r.AuthorityID != p.actor.AuthorityID || r.Direction != "upload" {
			return ErrConflict
		}
		return fn(d, r)
	})
}

func (s *Lifecycle) uploadChunkAt(ctx context.Context, p *Permit, offset int64) (model.UploadChunk, error) {
	var result model.UploadChunk
	err := s.admittedUpload(ctx, p, func(d store.PrivateTransferDAO, r model.PrivateTransfer) error {
		if r.State != "receiving" && r.State != "committing" {
			return ErrState
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
		if additional < 0 || r.State != "receiving" || !live(r, time.Now()) {
			return ErrState
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
			return ErrCapacity
		}
		result, e = d.Reserve(ctx, r.ID, additional, s.budget)
		return e
	})
	return result, err
}

func (s *Lifecycle) startAdmittedCommit(ctx context.Context, p *Permit, data json.RawMessage) (model.PrivateTransfer, error) {
	var result model.PrivateTransfer
	err := s.admittedUpload(ctx, p, func(d store.PrivateTransferDAO, r model.PrivateTransfer) error {
		now := time.Now().UTC()
		if r.State != "receiving" || !live(r, now) || !canonical(operationID(data)) {
			return ErrState
		}
		r.State = "committing"
		r.Data = data
		lease := now.Add(time.Minute)
		r.LeaseUntil = &lease
		r.ExpiresAt = now.Add(IdleLifetime)
		if r.ExpiresAt.After(r.HardExpiresAt) {
			r.ExpiresAt = r.HardExpiresAt
		}
		var e error
		result, e = d.Update(ctx, r, r.Version)
		return e
	})
	return result, err
}

// keepAdmittedUpload extends only the holder's live operation. It never revives
// an expired commit lease or a namespace whose cleanup barrier is established.
func (s *Lifecycle) keepAdmittedUpload(ctx context.Context, p *Permit, opID string) error {
	return s.admittedUpload(ctx, p, func(d store.PrivateTransferDAO, r model.PrivateTransfer) error {
		now := time.Now().UTC()
		if !live(r, now) {
			return ErrState
		}
		switch r.State {
		case "receiving":
		case "committing":
			if operationID(r.Data) != opID || r.LeaseUntil == nil || !now.Before(*r.LeaseUntil) {
				return ErrState
			}
			lease := now.Add(time.Minute)
			r.LeaseUntil = &lease
		default:
			return ErrState
		}
		r.ExpiresAt = now.Add(IdleLifetime)
		if r.ExpiresAt.After(r.HardExpiresAt) {
			r.ExpiresAt = r.HardExpiresAt
		}
		_, e := d.Update(ctx, r, r.Version)
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
		if r.State != "committing" || operationID(r.Data) != opID {
			return ErrState
		}
		r.State = "unknown"
		r.LeaseUntil = nil
		r.Data = data
		_, e := d.Update(ctx, r, r.Version)
		return e
	})
}

// requestAdmittedCleanup records a terminal operation's cleanup barrier while
// its original permit still prevents physical removal. A later sweep reclaims it.
func (s *Lifecycle) requestAdmittedCleanup(ctx context.Context, p *Permit, opID string) error {
	return s.admittedUpload(ctx, p, func(d store.PrivateTransferDAO, r model.PrivateTransfer) error {
		if (r.State != "committed" && r.State != "failed") || operationID(r.Data) != opID {
			return ErrState
		}
		r.State = "cleanup_pending"
		r.LeaseUntil = nil
		_, e := d.Update(ctx, r, r.Version)
		return e
	})
}
