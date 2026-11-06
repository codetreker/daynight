package mcptransfer

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Create checks the limit after inserting and locking the shared ledger. This
// preserves duplicate-ID behavior and serializes counts across instances.
func Create(ctx context.Context, d store.PrivateTransferDAO, t model.PrivateTransfer) (model.PrivateTransfer, bool, error) {
	if !InitialValid(t) {
		return model.PrivateTransfer{}, false, &model.Fault{Code: "invalid_input", Message: "Invalid initial transfer state."}
	}
	result, created, err := d.Insert(ctx, t)
	if err != nil || !created {
		return result, created, err
	}
	if err = d.LockLedger(ctx); err != nil {
		return model.PrivateTransfer{}, false, err
	}
	active, err := d.CountActive(ctx, t.UserID, "closed")
	if err != nil {
		return model.PrivateTransfer{}, false, err
	}
	if ActiveLimitExceeded(active) {
		return model.PrivateTransfer{}, false, &model.Fault{Code: "capacity_unavailable", Message: "The active transfer limit was reached."}
	}
	return result, true, nil
}

func Reserve(ctx context.Context, d store.PrivateTransferDAO, id string, additional, budget int64) (model.PrivateTransfer, error) {
	if additional < 0 || budget < 0 {
		return model.PrivateTransfer{}, &model.Fault{Code: "invalid_input", Message: "Invalid transfer reservation."}
	}
	t, err := d.Get(ctx, id)
	if err != nil {
		return t, err
	}
	if !ReservationStateValid(t) {
		return model.PrivateTransfer{}, &model.Fault{Code: "transfer_conflict", Message: "Transfer is being cleaned up."}
	}
	if err = d.LockLedger(ctx); err != nil {
		return model.PrivateTransfer{}, err
	}
	total, err := d.ReservedTotal(ctx)
	if err != nil {
		return model.PrivateTransfer{}, err
	}
	if !ReservationValid(t, additional, budget, total) {
		return model.PrivateTransfer{}, &model.Fault{Code: "capacity_unavailable", Message: "Temporary content capacity is unavailable."}
	}
	if additional == 0 {
		return t, nil
	}
	return d.AddReservation(ctx, id, additional)
}

// ConsumeReservation shares the receipt transaction after file publication. It
// deducts only unmaterialized bytes; all reserved bytes remain charged until
// namespace cleanup succeeds.
func ConsumeReservation(ctx context.Context, d store.PrivateTransferDAO, id string, amount, expected int64) (model.PrivateTransfer, error) {
	if amount < 0 {
		return model.PrivateTransfer{}, &model.Fault{Code: "invalid_input", Message: "Invalid transfer materialization."}
	}
	original, err := d.Get(ctx, id)
	if err != nil {
		return model.PrivateTransfer{}, err
	}
	if !ConsumptionValid(original, expected, amount) {
		return model.PrivateTransfer{}, model.ErrNotFound
	}
	if amount == 0 {
		return original, nil
	}
	if err = d.LockLedger(ctx); err != nil {
		return model.PrivateTransfer{}, err
	}
	return d.SubtractOutstanding(ctx, id, amount)
}

func Update(ctx context.Context, d store.PrivateTransferDAO, t model.PrivateTransfer, expected int64) (model.PrivateTransfer, error) {
	if !UpdateStateValid(t) {
		return model.PrivateTransfer{}, &model.Fault{Code: "invalid_input", Message: "Close requires completed cleanup."}
	}
	original, err := d.Get(ctx, t.ID)
	if err != nil {
		return model.PrivateTransfer{}, err
	}
	if original.Version != expected || !ReservationStateValid(original) {
		return model.PrivateTransfer{}, model.ErrNotFound
	}
	t.CleanupFromState = original.CleanupFromState
	if t.State == "cleanup_pending" {
		previous := original.State
		t.CleanupFromState = &previous
	}
	return d.Put(ctx, t, expected)
}

func UpdatePending(ctx context.Context, d store.PrivateTransferDAO, t model.PrivateTransfer, expected int64) (model.PrivateTransfer, error) {
	if !PendingOutcomeValid(t) {
		return model.PrivateTransfer{}, &model.Fault{Code: "invalid_input", Message: "Missing cleanup outcome."}
	}
	original, err := d.Get(ctx, t.ID)
	if err != nil {
		return model.PrivateTransfer{}, err
	}
	if original.Version != expected || original.State != "cleanup_pending" {
		return model.PrivateTransfer{}, model.ErrNotFound
	}
	original.CleanupFromState, original.Data = t.CleanupFromState, t.Data
	return d.Put(ctx, original, expected)
}

// Close is called only after deleting the namespace while holding its gate.
func Close(ctx context.Context, d store.PrivateTransferDAO, id string, expected int64, retainUntil time.Time) (model.PrivateTransfer, error) {
	original, err := d.Get(ctx, id)
	if err != nil {
		return model.PrivateTransfer{}, err
	}
	if !CloseValid(original, expected) {
		return model.PrivateTransfer{}, model.ErrNotFound
	}
	if err = d.LockLedger(ctx); err != nil {
		return model.PrivateTransfer{}, err
	}
	return d.Release(ctx, original, expected, retainUntil, "closed")
}

func Due(ctx context.Context, d store.PrivateTransferDAO, now time.Time, limit int) ([]model.PrivateTransfer, error) {
	if limit < 1 || limit > 100 {
		return nil, &model.Fault{Code: "invalid_input", Message: "Invalid maintenance batch size."}
	}
	return d.Due(ctx, now, limit, store.PrivateTransferDueStates{Closed: "closed", Pending: "cleanup_pending", Committing: "committing"})
}
func Prune(ctx context.Context, d store.PrivateTransferDAO, now time.Time, limit int) (int64, error) {
	if limit < 1 || limit > 100 {
		return 0, &model.Fault{Code: "invalid_input", Message: "Invalid maintenance batch size."}
	}
	return d.Prune(ctx, now, limit, "closed")
}
func Stats(ctx context.Context, d store.PrivateTransferDAO) (store.PrivateTransferStats, error) {
	return d.Stats(ctx, "cleanup_pending")
}
