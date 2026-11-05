package sessionrelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol/v2"
	"github.com/jackc/pgx/v5"
)

func terminalArchive(ctx context.Context, tx pgx.Tx, r *terminalRecord) (v2.ArchiveStatus, *v2.Receipt, string, error) {
	out := v2.ArchiveStatus{State: "pending", FinalizationID: r.FinalizationID}
	var raw []byte
	var path *string
	err := tx.QueryRow(ctx, `SELECT state,sha256,byte_length::text,completeness,error_code,finalization_id::text,receipt,object_path FROM session_archives WHERE session_id=$1 AND schema_version=2`, r.Envelope.SessionID).Scan(&out.State, &out.SHA256, &out.ByteLength, &out.Completeness, &out.ErrorCode, &out.FinalizationID, &raw, &path)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, nil, "", nil
	}
	if err != nil {
		return out, nil, "", err
	}
	var receipt *v2.Receipt
	if len(raw) > 0 {
		receipt = &v2.Receipt{}
		if err = json.Unmarshal(raw, receipt); err != nil {
			return out, nil, "", err
		}
	}
	object := ""
	if path != nil {
		object = *path
	}
	if out.State == "ready" {
		if out.SHA256 == nil || path == nil {
			return out, receipt, "", fault("source_corrupt", "Ready terminal archive metadata is incomplete.")
		}
		if err := validateArchiveObjectPath(r.Owner.ProjectID, r.Owner.OwnerUserID, r.Envelope.SessionID, *out.SHA256, object); err != nil {
			return out, receipt, "", err
		}
	}
	return out, receipt, object, nil
}
func (s *Service) TerminalArchiveStatus(ctx context.Context, p core.Principal, project, taskID, id string) (v2.Message, error) {
	var out v2.Message
	err := s.terminalAccess(ctx, p, project, taskID, id, true, func(tx pgx.Tx, r *terminalRecord, _ task, _ bool) error {
		status, _, _, err := terminalArchive(ctx, tx, r)
		out = terminalEnvelope(r, "archive_status", status)
		return err
	})
	return out, err
}
func (s *Service) TerminalReceipt(ctx context.Context, p core.Principal, project, taskID, id string) (v2.Message, error) {
	var out v2.Message
	err := s.terminalAccess(ctx, p, project, taskID, id, true, func(tx pgx.Tx, r *terminalRecord, _ task, _ bool) error {
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
func storeTerminalReceipt(ctx context.Context, tx pgx.Tx, r *terminalRecord, receipt v2.Receipt, path *string) error {
	_, err := tx.Exec(ctx, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path,error_code,schema_version,completeness,finalization_id,receipt) VALUES($1,$2,$3,$4,$5,$6,2,$7,$8,$9) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state,sha256=excluded.sha256,byte_length=excluded.byte_length,object_path=excluded.object_path,error_code=excluded.error_code,schema_version=2,completeness=excluded.completeness,finalization_id=excluded.finalization_id,receipt=excluded.receipt,updated_at=now()`, r.Envelope.SessionID, receipt.Disposition, receipt.SHA256, receipt.ByteLength, path, receipt.Reason, receipt.Completeness, receipt.FinalizationID, encode(receipt))
	return err
}
func closedRecording(r *terminalRecord, generation string) (terminalRecording, error) {
	rec := r.Recording[generation]
	if rec.Responsibility == nil || rec.Evidence == nil || !rec.Evidence.Closed {
		return rec, fault("source_corrupt", "The recording responsibility lacks immutable closed evidence.")
	}
	return rec, nil
}
func verifyTerminalArchive(r *terminalRecord, doc v2.Archive) error {
	if r.FinalizationID == nil || doc.FinalizationID != *r.FinalizationID || doc.SessionID != r.Envelope.SessionID || doc.ClaimID != r.Envelope.ClaimID || doc.ExecutionGeneration != r.Envelope.ExecutionGeneration || doc.Owner != r.Owner || !reflect.DeepEqual(doc.Runs, r.Runs) {
		return conflict()
	}
	for _, run := range r.Runs {
		rec, err := closedRecording(r, run.ExecutionGeneration)
		if err != nil {
			return err
		}
		count := 0
		for _, file := range doc.Files {
			for _, segment := range run.SegmentIDs {
				if file.SegmentID == segment {
					count++
					break
				}
			}
		}
		amount := strconv.Itoa(count)
		if rec.Evidence.SelectedFrameCount != amount || rec.Evidence.RegisteredFrameCount != amount {
			return fault("source_corrupt", "The archive omits registered or selected recording content.")
		}
		digest, err := v2.SourceDigest(doc, run.ExecutionGeneration)
		if err != nil {
			return err
		}
		if digest != rec.Evidence.SourceSHA256 {
			return fault("source_corrupt", "The archive differs from the closed recording source.")
		}
		if rec.Evidence.CaptureError != nil {
			covered := false
			if *rec.Evidence.CaptureError == "recording_limit" && count > 0 && doc.Completeness == "partial" {
				for _, gap := range doc.Gaps {
					if gap.Interval == nil || gap.Interval.Reason != "recording_limit" {
						continue
					}
					for _, segment := range run.SegmentIDs {
						if gap.Interval.SegmentID == segment {
							covered = true
						}
					}
				}
			}
			if !covered {
				return fault("source_corrupt", "The run's capture failure lacks a matching recording-limit gap.")
			}
		}
		if count == 0 {
			found := false
			for _, zero := range doc.UnavailableRuns {
				if zero.ExecutionGeneration == run.ExecutionGeneration {
					found = true
					if zero.Evidence.RecordingEnabled != rec.Responsibility.RecordingEnabled || zero.Evidence.CaptureError != nil {
						return conflict()
					}
				}
			}
			if !found {
				return conflict()
			}
		} else if !rec.Responsibility.RecordingEnabled {
			return conflict()
		}
	}
	return nil
}
func (s *Service) readTerminalObject(ctx context.Context, path string, hash string, size string) ([]byte, error) {
	if s.files == nil {
		return nil, fault("archive_pending", "Archive file storage is unavailable.")
	}
	obj, err := s.files.Open(ctx, archiveBucket, path)
	if err != nil {
		return nil, err
	}
	defer obj.Body.Close()
	data, err := io.ReadAll(io.LimitReader(obj.Body, v2.MaxArchiveBytes+1))
	if err != nil {
		return nil, err
	}
	if strconv.Itoa(len(data)) != size || obj.Info.Size != int64(len(data)) || v2.HashBytes(data) != hash {
		return nil, fault("source_corrupt", "Session archive storage integrity failed.")
	}
	return data, nil
}

// PutTerminalArchive reads the stored object back before publishing its immutable
// receipt; forwarding or a successful upload alone does not establish integrity.
func (s *Service) PutTerminalArchive(ctx context.Context, p core.Principal, project, taskID, id string, data []byte) (v2.Message, error) {
	var out v2.Message
	doc, err := v2.DecodeArchive(data)
	if err != nil {
		return out, fault("source_corrupt", "Invalid terminal archive.")
	}
	hash, size := v2.HashBytes(data), strconv.Itoa(len(data))
	err = s.terminalAccess(ctx, p, project, taskID, id, true, func(tx pgx.Tx, r *terminalRecord, _ task, _ bool) error {
		if err := terminalOwner(p, r); err != nil {
			return err
		}
		if err := verifyTerminalArchive(r, doc); err != nil {
			return err
		}
		status, receipt, storedPath, err := terminalArchive(ctx, tx, r)
		if err != nil {
			return err
		}
		if receipt != nil {
			if receipt.Disposition != "ready" || receipt.SHA256 == nil || *receipt.SHA256 != hash || receipt.ByteLength == nil || *receipt.ByteLength != size {
				return conflict()
			}
			if _, err := s.readTerminalObject(ctx, storedPath, *receipt.SHA256, *receipt.ByteLength); err != nil {
				return err
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
		stored, err := s.readTerminalObject(ctx, path, hash, size)
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
func (s *Service) UpdateTerminalArchive(ctx context.Context, p core.Principal, project, taskID, id string, m v2.Message) (v2.Message, error) {
	var out v2.Message
	if m.Type != "archive_status" && m.Type != "receipt" {
		return out, fault("invalid_payload", "Expected archive status or unavailable receipt.")
	}
	if err := validTerminalMessage(m, m.Type); err != nil {
		return out, err
	}
	err := s.terminalAccess(ctx, p, project, taskID, id, true, func(tx pgx.Tx, r *terminalRecord, _ task, _ bool) error {
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
			_, err = tx.Exec(ctx, `INSERT INTO session_archives(session_id,state,error_code,schema_version,finalization_id) VALUES($1,$2,$3,2,$4) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state,error_code=excluded.error_code,finalization_id=excluded.finalization_id,updated_at=now()`, id, in.State, in.ErrorCode, in.FinalizationID)
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
func (s *Service) TerminalArchiveContent(ctx context.Context, p core.Principal, project, taskID, id string) (json.RawMessage, error) {
	var out json.RawMessage
	err := s.terminalAccess(ctx, p, project, taskID, id, false, func(tx pgx.Tx, r *terminalRecord, _ task, _ bool) error {
		status, receipt, path, err := terminalArchive(ctx, tx, r)
		if err != nil {
			return err
		}
		if status.State != "ready" || receipt == nil || status.SHA256 == nil || status.ByteLength == nil {
			return fault("archive_pending", "No terminal archive is ready.")
		}
		data, err := s.readTerminalObject(ctx, path, *status.SHA256, *status.ByteLength)
		if err != nil {
			return err
		}
		doc, err := v2.DecodeArchive(data)
		if err != nil {
			return err
		}
		if err = verifyTerminalArchive(r, doc); err != nil {
			return err
		}
		if status.Completeness == nil || doc.Completeness != *status.Completeness {
			return conflict()
		}
		out = data
		return nil
	})
	return out, err
}
