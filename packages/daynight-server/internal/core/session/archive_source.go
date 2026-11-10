package session

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

// AppendArchiveSourceTail transports only already persisted source events under
// the original stopped writer. It creates no controller grant or native work.
func (op *ArchiveOperation) AppendArchiveSourceTail(ctx context.Context, in sp.ArchiveSourceTailRequest) (out sp.ArchiveSourceTailReceipt, err error) {
	op.mu.Lock()
	defer op.mu.Unlock()
	if err = op.check(ArchiveV1Upload); err != nil {
		return out, err
	}
	if _, err = sp.DecodeArchiveSourceTail(encode(in)); err != nil {
		return out, fault("invalid_input", "Invalid archive source tail.")
	}
	err = op.execution.archiveAccess(ctx, op.principal, op.project, op.task, op.id, true, func(tx *operationTx, r *record, t task) error {
		if r.Owner != op.owner {
			return conflict()
		}
		if e := archiveWriter(op.principal, r, in.Fence, in.ControllerID, in.ControllerInstanceID); e != nil {
			return e
		}
		if e := archiveStopped(r, t); e != nil {
			return e
		}
		dao, e := archiveDAO(tx)
		if e != nil {
			return e
		}
		bundle, e := dao.SessionArchiveBundle(ctx, op.id)
		exists := e == nil
		if e != nil && !errors.Is(e, model.ErrNotFound) {
			return e
		}
		if exists && bundle.Phase == "active" {
			identity := sp.ArchivePrepareRequest{Fence: in.Fence, ControllerID: in.ControllerID, ControllerInstanceID: in.ControllerInstanceID}
			if !jsonEqual(bundle.Identity, encode(identity)) {
				return archiveConflict()
			}
			if e = settleActiveHistory(ctx, tx, dao, &bundle, r); e != nil {
				return e
			}
		}
		if exists && (bundle.Phase != "settling" || bundle.HistoryID != "" || bundle.TimelineID != "" || bundle.ManifestHash != "") {
			return archiveConflict()
		}
		out, e = op.execution.applyStoppedSourceTail(ctx, tx, r, in)
		if e != nil {
			return e
		}
		if exists {
			var ledger archiveLedger
			if json.Unmarshal(bundle.Ledger, &ledger) != nil {
				return archiveConflict()
			}
			if ledger.FinalSourceThrough != "" {
				ledger.FinalSourceThrough = out.LastAckedSourceSeq
			} else {
				ledger.SourceThrough = out.LastAckedSourceSeq
			}
			bundle.Ledger = encode(ledger)
			return dao.SaveSessionArchiveBundle(ctx, bundle)
		}
		return nil
	})
	op.markCommit(err)
	return
}
