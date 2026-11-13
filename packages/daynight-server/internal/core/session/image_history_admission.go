package session

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// Captures may settle the image occurrences of an already complete metadata
// checkpoint. New input requires its full sealable resource closure as well.
func requireImageHistoryLedger(ctx context.Context, tx *operationTx, r *record, capture bool) error {
	dao, e := archiveDAO(tx)
	if e != nil {
		return e
	}
	bundle, e := dao.SessionArchiveBundle(ctx, r.Snapshot.SessionID)
	if errors.Is(e, model.ErrNotFound) {
		return fault("component_unsupported", "Complete Session history must be synchronized before image admission.")
	}
	if e != nil {
		return e
	}
	if !capture {
		if !imageHistoryCurrent(bundle, r) {
			return fault("capability_changed", "Complete Session history must be synchronized before image admission.")
		}
		return nil
	}
	var ledger archiveLedger
	if bundle.Phase != "active" || bundle.HistoryID == "" || json.Unmarshal(bundle.Ledger, &ledger) != nil || ledger.HistoryEpoch != r.Snapshot.HistoryEpoch || ledger.SourceThrough != decimal(r.SourceSeq) || ledger.HistoryID != bundle.HistoryID || ledger.TargetSourceEpoch != "" || ledger.SourceEpoch != "" && ledger.SourceEpoch != sourceEpoch(r) {
		return fault("capability_changed", "The complete source metadata checkpoint must precede image capture.")
	}
	return nil
}
