package session

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type ActiveHistoryWriter struct {
	Fence      sp.ControllerFence
	Credential string
}

func (op *ArchiveOperation) validateHistoryWriter(r *record, t task) error {
	if op.historyWriter == nil {
		return archiveConflict()
	}
	hash := sha256.Sum256([]byte(op.historyWriter.Credential))
	if op.principal.Kind != model.PATCredential || op.principal.UserID != r.Owner || !r.Consumed || !bytes.Equal(hash[:], r.GrantHash) || op.historyWriter.Fence != r.Snapshot.ControllerFence || r.Snapshot.ContentRevision != sp.ContentRevision || !active(t, r) || r.Snapshot.Lifecycle != "active" || r.Live == nil || r.ConnectionExpiry == nil || !op.execution.now().Before(*r.ConnectionExpiry) {
		return conflict()
	}
	return nil
}

func (op *ArchiveOperation) prepareHistoryLedger(ctx context.Context, writer ActiveHistoryWriter) (err error) {
	op.mu.Lock()
	defer op.mu.Unlock()
	if err = op.check(ArchiveV1Upload); err != nil {
		return err
	}
	op.historyWriter = &writer
	err = op.execution.archiveAccess(ctx, op.principal, op.project, op.task, op.id, true, func(tx *operationTx, r *record, t task) error {
		if err := op.validateHistoryWriter(r, t); err != nil {
			return err
		}
		dao, err := archiveDAO(tx)
		if err != nil {
			return err
		}
		bundle, err := dao.SessionArchiveBundle(ctx, op.id)
		if err == nil {
			identity := sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID}
			if bundle.Phase != "active" || !jsonEqual(bundle.Identity, encode(identity)) {
				return archiveConflict()
			}
			return nil
		}
		if !errors.Is(err, model.ErrNotFound) {
			return err
		}
		identity := sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID}
		bundle = store.ArchiveBundle{SessionID: op.id, PrepareID: r.Snapshot.Identity.ControllerInstanceID, Phase: "active", Revision: 1, Identity: encode(identity), Resources: json.RawMessage(`[]`), Ledger: encode(archiveLedger{HistoryEpoch: r.Snapshot.HistoryEpoch, SourceThrough: "0", Entries: []archiveLedgerEntry{}, Resources: []sp.Resource{}})}
		return dao.SaveSessionArchiveBundle(ctx, bundle)
	})
	op.markCommit(err)
	return err
}
func (op *ArchiveOperation) PutHistoryLedger(ctx context.Context, writer ActiveHistoryWriter, fileID string, offset, length int64, digest, chunk string, data []byte) (sp.ArchiveFileReceipt, error) {
	if err := op.prepareHistoryLedger(ctx, writer); err != nil {
		return sp.ArchiveFileReceipt{}, err
	}
	return op.putArchiveFile(ctx, "history", fileID, offset, length, digest, chunk, data, nil)
}
func (op *ArchiveOperation) HistoryLedgerStatus(ctx context.Context, writer ActiveHistoryWriter, fileID string) (out sp.ArchiveFileReceipt, err error) {
	op.mu.Lock()
	defer op.mu.Unlock()
	if err = op.check(ArchiveV1Upload); err != nil {
		return out, err
	}
	op.historyWriter = &writer
	err = op.bundleAccess(ctx, func(_ *operationTx, _ *record, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
		if bundle.Phase != "active" {
			return archiveConflict()
		}
		file, e := dao.SessionArchiveFile(ctx, op.id, fileID)
		if e != nil {
			return e
		}
		if file.Purpose != "history" {
			return archiveConflict()
		}
		out = fileReceipt(file)
		return nil
	})
	return
}

func imageHistoryCurrent(bundle store.ArchiveBundle, r *record) bool {
	var ledger archiveLedger
	return bundle.Phase == "active" && bundle.HistoryID != "" && json.Unmarshal(bundle.Ledger, &ledger) == nil && ledger.HistoryID == bundle.HistoryID && ledger.Sealable && ledger.HistoryEpoch == r.Snapshot.HistoryEpoch && ledger.SourceThrough == decimal(r.SourceSeq)
}

// ActiveHistoryPrincipal validates the existing connection delegation inside its
// authorized controller scope; no owner credential material is returned.
func (a *Access) ActiveHistoryPrincipal(project, taskID, id string, writer ActiveHistoryWriter) (model.Principal, error) {
	r := a.record
	hash := sha256.Sum256([]byte(writer.Credential))
	if r.Snapshot.SessionID != id || r.Snapshot.Identity.ProjectID != project || r.Snapshot.Identity.TaskID != taskID || !r.Consumed || writer.Fence != r.Snapshot.ControllerFence || !bytes.Equal(hash[:], r.GrantHash) || r.ConnectionParent == "" || !active(a.task, r) {
		return model.Principal{}, denied()
	}
	return model.Principal{Kind: model.PATCredential, UserID: r.Owner, CredentialID: r.ConnectionParent}, nil
}
