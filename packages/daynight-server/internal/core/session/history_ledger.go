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

type historySourceIdentity struct {
	SourceEpoch string `json:"sourceEpoch"`
}

func sourceEpoch(r *record) string {
	if r.SourceEpoch == nil {
		return ""
	}
	return *r.SourceEpoch
}

// The reset itself supplies the durable proof linking source epochs. Keep the
// accepted checkpoint's epoch and advance only the authorized target.
func handoffHistorySource(ctx context.Context, tx *operationTx, r *record, previous, next string) error {
	dao, ok := tx.dao.(store.SessionArchiveDAO)
	if !ok {
		return nil
	}
	bundle, err := dao.SessionArchiveBundle(ctx, r.Snapshot.SessionID)
	if errors.Is(err, model.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if bundle.Phase != "active" {
		return nil
	}
	var ledger archiveLedger
	if json.Unmarshal(bundle.Ledger, &ledger) != nil {
		return archiveConflict()
	}
	if ledger.SourceEpoch == "" {
		ledger.SourceEpoch = previous
	}
	current := ledger.SourceEpoch
	if ledger.TargetSourceEpoch != "" {
		current = ledger.TargetSourceEpoch
	}
	if current != previous {
		return archiveConflict()
	}
	// Retire only old history rounds. Other media operations do not block source
	// reset; any in-flight history writer rechecks this state and epoch under the
	// same Session lock before its final publication.
	files, err := dao.SessionArchiveFiles(ctx, bundle.SessionID)
	if err != nil {
		return err
	}
	for _, file := range files {
		if file.Purpose == "history" && file.State == "receiving" {
			file.State = "failed"
			if err = dao.SaveSessionArchiveFile(ctx, file); err != nil {
				return err
			}
		}
	}
	ledger.TargetSourceEpoch = next
	bundle.Ledger = encode(ledger)
	return dao.SaveSessionArchiveBundle(ctx, bundle)
}

// retireActiveHistory runs only after the caller proves the old generation has
// stopped. Durable leases still prevent retirement while server IO is running.
// Failed rounds retain their original file identity and acknowledged chunks.
func retireActiveHistory(ctx context.Context, tx *operationTx, dao store.SessionArchiveDAO, bundle store.ArchiveBundle) error {
	media, err := archiveMediaDAO(tx)
	if err != nil {
		return err
	}
	leases, err := media.SessionResourceLeaseCount(ctx, bundle.SessionID)
	if err != nil {
		return err
	}
	if leases != 0 {
		return archiveConflict()
	}
	files, err := dao.SessionArchiveFiles(ctx, bundle.SessionID)
	if err != nil {
		return err
	}
	for _, file := range files {
		if file.State != "receiving" {
			continue
		}
		if file.Purpose != "history" {
			return archiveConflict()
		}
		file.State = "failed"
		if err = dao.SaveSessionArchiveFile(ctx, file); err != nil {
			return err
		}
	}
	return nil
}

func settleActiveHistory(ctx context.Context, tx *operationTx, dao store.SessionArchiveDAO, bundle *store.ArchiveBundle, r *record) error {
	if bundle.TimelineID != "" || bundle.ManifestHash != "" || bundle.ManifestPath != "" {
		return archiveConflict()
	}
	var ledger archiveLedger
	if json.Unmarshal(bundle.Ledger, &ledger) != nil || ledger.latestHistoryEpoch() != r.Snapshot.HistoryEpoch {
		return archiveConflict()
	}
	if err := retireActiveHistory(ctx, tx, dao, *bundle); err != nil {
		return err
	}
	// Retain the last complete ledger until final history commits. Its source
	// checkpoint is distinct from the final barrier, which tail replay may advance.
	ledger.FinalSourceThrough = decimal(r.SourceSeq)
	bundle.Phase = "settling"
	bundle.Revision++
	bundle.HistoryID = ""
	bundle.Ledger = encode(ledger)
	return dao.SaveSessionArchiveBundle(ctx, *bundle)
}

// Connect calls this in the same transaction that consumes the validated grant
// and saves the new connection. Only the latest verified connection can advance
// the target epoch; the acknowledged ledger and file receipts remain unchanged.
func handoffConnectedHistory(ctx context.Context, tx *operationTx, r *record, nextEpoch string) error {
	dao, capable := tx.dao.(store.SessionArchiveDAO)
	if !capable {
		return nil
	}
	bundle, err := dao.SessionArchiveBundle(ctx, r.Snapshot.SessionID)
	if errors.Is(err, model.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	identity := sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID}
	var ledger archiveLedger
	if bundle.Phase != "active" || !jsonEqual(bundle.Identity, encode(identity)) || bundle.TimelineID != "" || bundle.ManifestHash != "" || bundle.ManifestPath != "" || json.Unmarshal(bundle.Ledger, &ledger) != nil || ledger.latestHistoryEpoch() != r.Snapshot.HistoryEpoch {
		return archiveConflict()
	}
	ledger.FinalHistoryEpoch = nextEpoch
	bundle.Ledger = encode(ledger)
	return dao.SaveSessionArchiveBundle(ctx, bundle)
}

// The grant caller has validated the exact previous generation and stop proof.
// Handoff shares that transaction so a grant cannot leave the ledger attached to
// a former writer, even when several generations recover before the next sync.
func handoffActiveHistory(ctx context.Context, tx *operationTx, r *record, grant sp.Grant) error {
	dao, capable := tx.dao.(store.SessionArchiveDAO)
	if !capable {
		return nil
	}
	bundle, err := dao.SessionArchiveBundle(ctx, r.Snapshot.SessionID)
	if errors.Is(err, model.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	identity := sp.ArchivePrepareRequest{Fence: r.Snapshot.Fence, ControllerID: r.Snapshot.Identity.ControllerID, ControllerInstanceID: r.Snapshot.Identity.ControllerInstanceID}
	if bundle.Phase != "active" || !jsonEqual(bundle.Identity, encode(identity)) {
		return archiveConflict()
	}
	rebind, capable := tx.dao.(store.SessionArchiveHandoffDAO)
	if !capable {
		return archiveConflict()
	}
	if err = retireActiveHistory(ctx, tx, dao, bundle); err != nil {
		return err
	}
	identity.Fence.ExecutionGeneration = grant.ExecutionGeneration
	identity.ControllerInstanceID = grant.ControllerInstanceID
	return rebind.RebindSessionArchiveBundle(ctx, bundle.SessionID, bundle.Identity, encode(identity))
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
		bundle = store.ArchiveBundle{SessionID: op.id, PrepareID: r.Snapshot.Identity.ControllerInstanceID, Phase: "active", Revision: 1, Identity: encode(identity), Resources: json.RawMessage(`[]`), Ledger: encode(archiveLedger{HistoryEpoch: r.Snapshot.HistoryEpoch, SourceEpoch: sourceEpoch(r), SourceThrough: "0", Entries: []archiveLedgerEntry{}, Resources: []sp.Resource{}})}
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
	return bundle.Phase == "active" && bundle.HistoryID != "" && json.Unmarshal(bundle.Ledger, &ledger) == nil && ledger.HistoryID == bundle.HistoryID && ledger.Sealable && ledger.HistoryEpoch == r.Snapshot.HistoryEpoch && ledger.SourceThrough == decimal(r.SourceSeq) && ledger.TargetSourceEpoch == "" && (ledger.SourceEpoch == "" || ledger.SourceEpoch == sourceEpoch(r))
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
