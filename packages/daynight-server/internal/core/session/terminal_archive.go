package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

func terminalArchive(ctx context.Context, tx *operationTx, r *terminalRecord) (v2.ArchiveStatus, *v2.Receipt, string, error) {
	status, receipt, path, err := tx.dao.TerminalArchive(ctx, r.Envelope.SessionID)
	if errors.Is(err, model.ErrNotFound) {
		return v2.ArchiveStatus{State: "pending", FinalizationID: r.FinalizationID}, nil, "", nil
	}
	return status, receipt, path, err
}
func (s *Execution) TerminalReceipt(ctx context.Context, p model.Principal, project, taskID, id string) (v2.Message, error) {
	var out v2.Message
	err := s.terminalAccess(ctx, p, project, taskID, id, true, func(tx *operationTx, r *terminalRecord, _ task, _ bool) error {
		_, receipt, _, err := terminalArchive(ctx, tx, r)
		if err != nil {
			return err
		}
		if receipt == nil {
			return fault("archive_pending", "No immutable archive receipt is available.")
		}
		out = terminalEnvelope(r, "receipt", *receipt)
		return nil
	})
	return out, err
}
func terminalReceipt(r *terminalRecord, payload v2.Receipt) (v2.Message, error) {
	out := terminalEnvelope(r, "receipt", payload)
	digest, err := v2.ReceiptDigest(out)
	if err != nil {
		return out, err
	}
	payload.DispositionDigest = digest
	out.Payload = payload
	return out, nil
}
func storeTerminalReceipt(ctx context.Context, tx *operationTx, r *terminalRecord, receipt v2.Receipt, path *string) error {
	return tx.dao.SaveTerminalReceipt(ctx, r.Envelope.SessionID, receipt, path)
}
func archiveRecordFromTerminal(r *terminalRecord) *terminalArchiveRecord {
	return &terminalArchiveRecord{Envelope: r.Envelope, Owner: r.Owner, Runs: r.Runs, Recording: r.Recording, FinalizationID: r.FinalizationID}
}
func closedRecording(r *terminalRecord, generation string) (terminalRecording, error) {
	return historyClosedRecording(archiveRecordFromTerminal(r), generation)
}
func verifyTerminalArchive(r *terminalRecord, doc v2.Archive) error {
	return verifyTerminalArchiveRecord(archiveRecordFromTerminal(r), doc)
}

// PutTerminalArchive reads the stored object back before publishing its immutable
// receipt; forwarding or a successful upload alone does not establish integrity.
func (s *Execution) PutTerminalArchive(ctx context.Context, p model.Principal, project, taskID, id string, data []byte) (out v2.Message, err error) {
	op, err := s.BeginArchive(ctx, p, project, taskID, id, ArchiveV2Upload)
	if err != nil {
		return out, err
	}
	defer func() { err = errors.Join(err, op.Close()) }()
	return op.PutTerminalArchive(ctx, data)
}

func (s *Execution) putTerminalArchive(ctx context.Context, op *ArchiveOperation, data []byte) (v2.Message, error) {
	p, project, taskID, id := op.principal, op.project, op.task, op.id
	var out v2.Message
	doc, err := v2.DecodeArchive(data)
	if err != nil {
		return out, fault("source_corrupt", "Invalid terminal archive.")
	}
	hash, size := v2.HashBytes(data), strconv.Itoa(len(data))
	err = s.terminalAccess(ctx, p, project, taskID, id, true, func(tx *operationTx, r *terminalRecord, _ task, _ bool) error {
		if r.Owner.OwnerUserID != op.owner {
			return conflict()
		}
		if err := terminalOwner(p, r); err != nil {
			return err
		}
		if err := verifyTerminalArchive(r, doc); err != nil {
			return err
		}
		status, receipt, _, err := terminalArchive(ctx, tx, r)
		if err != nil {
			return err
		}
		if receipt != nil {
			if receipt.Disposition != "ready" || receipt.SHA256 == nil || *receipt.SHA256 != hash || receipt.ByteLength == nil || *receipt.ByteLength != size {
				return conflict()
			}
			out = terminalEnvelope(r, "receipt", *receipt)
			return nil
		}
		if status.State == "failed" {
			return fault("source_corrupt", "A failed recording cannot become a successful archive.")
		}
		if s.files == nil {
			return fault("archive_pending", "Archive file storage is unavailable.")
		}
		path, err := archiveObjectPath(r.Owner.ProjectID, r.Owner.OwnerUserID, id, hash)
		if err != nil {
			return err
		}
		info, err := s.files.Put(ctx, archiveBucket, path, bytes.NewReader(data))
		if err != nil {
			return err
		}
		if info.Size != int64(len(data)) {
			return fault("source_corrupt", "Archive storage length mismatch.")
		}
		stored, err := s.readTerminalObject(ctx, op, path, hash, size)
		if err != nil {
			return err
		}
		if _, err = v2.DecodeArchive(stored); err != nil {
			return err
		}
		receiptValue := v2.Receipt{FinalizationID: *r.FinalizationID, Disposition: "ready", SHA256: &hash, ByteLength: &size, Completeness: &doc.Completeness}
		out, err = terminalReceipt(r, receiptValue)
		if err != nil {
			return err
		}
		return storeTerminalReceipt(ctx, tx, r, out.Payload.(v2.Receipt), &path)
	})
	return out, err
}
func (s *Execution) UpdateTerminalArchive(ctx context.Context, p model.Principal, project, taskID, id string, m v2.Message) (v2.Message, error) {
	var out v2.Message
	if m.Type != "archive_status" && m.Type != "receipt" {
		return out, fault("invalid_payload", "Expected archive status or unavailable receipt.")
	}
	raw, err := json.Marshal(m)
	if err != nil {
		return out, fault("invalid_payload", "Invalid terminal message.")
	}
	m, err = v2.DecodeMessage(raw)
	if err != nil {
		return out, fault("invalid_payload", "Invalid terminal message.")
	}
	err = s.terminalAccess(ctx, p, project, taskID, id, true, func(tx *operationTx, r *terminalRecord, _ task, _ bool) error {
		if err := terminalOwner(p, r); err != nil {
			return err
		}
		if err := terminalFence(r, m.Envelope); err != nil {
			return err
		}
		status, receipt, _, err := terminalArchive(ctx, tx, r)
		if err != nil {
			return err
		}
		if m.Type == "archive_status" {
			in := m.Payload.(v2.ArchiveStatus)
			if in.State != "pending" && in.State != "failed" {
				return fault("invalid_payload", "Ready and unavailable require verified immutable receipts.")
			}
			if !reflect.DeepEqual(in.FinalizationID, r.FinalizationID) {
				return conflict()
			}
			if receipt != nil || status.State == "failed" {
				out = terminalEnvelope(r, "archive_status", status)
				return nil
			}
			err = tx.dao.SaveTerminalArchiveStatus(ctx, id, in)
			out = terminalEnvelope(r, "archive_status", in)
			return err
		}
		in := m.Payload.(v2.Receipt)
		if in.Disposition != "unavailable" || r.FinalizationID == nil || in.FinalizationID != *r.FinalizationID {
			return conflict()
		}
		enabled := false
		for _, run := range r.Runs {
			rec, e := closedRecording(r, run.ExecutionGeneration)
			if e != nil {
				return e
			}
			if rec.ObservedContent || rec.Evidence.SelectedFrameCount != "0" || rec.Evidence.RegisteredFrameCount != "0" || rec.Evidence.CaptureError != nil || rec.Evidence.SourceSHA256 != v2.EmptySourceDigest() {
				return fault("source_corrupt", "Unavailable cannot discard content or capture failures.")
			}
			enabled = enabled || rec.Responsibility.RecordingEnabled
		}
		evidence := v2.NoRecordingEvidence{RecordingEnabled: enabled, SelectedFrameCount: "0", RegisteredFrameCount: "0"}
		reason := "recording_not_enabled"
		if enabled {
			reason = "ended_before_first_sample"
		}
		if in.Evidence == nil || !reflect.DeepEqual(*in.Evidence, evidence) || in.Reason == nil || *in.Reason != reason {
			return conflict()
		}
		expected, e := terminalReceipt(r, v2.Receipt{FinalizationID: *r.FinalizationID, Disposition: "unavailable", Reason: &reason, Evidence: &evidence})
		if e != nil {
			return e
		}
		if !reflect.DeepEqual(in, expected.Payload.(v2.Receipt)) {
			return conflict()
		}
		if receipt != nil {
			if !reflect.DeepEqual(*receipt, in) {
				return conflict()
			}
			out = terminalEnvelope(r, "receipt", *receipt)
			return nil
		}
		if status.State == "failed" {
			return fault("source_corrupt", "A failed recording cannot become unavailable.")
		}
		if err = storeTerminalReceipt(ctx, tx, r, in, nil); err != nil {
			return err
		}
		out = expected
		return nil
	})
	return out, err
}
