package store

import (
	"context"
	"encoding/json"
	"time"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

type TerminalHistoryRow struct {
	ID, Claim, Backend              string
	Created                         time.Time
	Snapshot, Terminal              []byte
	State, Hash, Size, Completeness *string
}

type TerminalArchiveHistoryDAO interface {
	TerminalArchive(context.Context, string) (v2.ArchiveStatus, *v2.Receipt, string, error)
	SaveTerminalReceipt(context.Context, string, v2.Receipt, *string) error
	SaveTerminalArchiveStatus(context.Context, string, v2.ArchiveStatus) error
	CurrentTerminalSession(context.Context, string, string, string) (string, error)
	TerminalHistory(context.Context, string, string, *time.Time, *string, int) ([]TerminalHistoryRow, error)
	TerminalRecordingEvidence(context.Context, string, int64, string) (string, string, error)
	TerminalAutomationAllowed(context.Context, string) (bool, error)
	TerminalInputPending(context.Context, string) (bool, error)
}

func (tx *sessionTx) TerminalArchive(ctx context.Context, id string) (v2.ArchiveStatus, *v2.Receipt, string, error) {
	var status v2.ArchiveStatus
	var raw []byte
	var path *string
	err := tx.tx.QueryRow(ctx, `SELECT state,sha256,byte_length::text,completeness,error_code,finalization_id::text,receipt,object_path FROM session_archives WHERE session_id=$1 AND schema_version=2`, id).Scan(&status.State, &status.SHA256, &status.ByteLength, &status.Completeness, &status.ErrorCode, &status.FinalizationID, &raw, &path)
	if err != nil {
		return status, nil, "", queryError("read terminal archive", err)
	}
	var receipt *v2.Receipt
	if len(raw) > 0 {
		receipt = &v2.Receipt{}
		if err = json.Unmarshal(raw, receipt); err != nil {
			return status, nil, "", err
		}
	}
	if path != nil {
		return status, receipt, *path, nil
	}
	return status, receipt, "", nil
}
func (tx *sessionTx) SaveTerminalReceipt(ctx context.Context, id string, receipt v2.Receipt, path *string) error {
	raw, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	_, err = tx.tx.Exec(ctx, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path,error_code,schema_version,completeness,finalization_id,receipt) VALUES($1,$2,$3,$4,$5,$6,2,$7,$8,$9) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state,sha256=excluded.sha256,byte_length=excluded.byte_length,object_path=excluded.object_path,error_code=excluded.error_code,schema_version=2,completeness=excluded.completeness,finalization_id=excluded.finalization_id,receipt=excluded.receipt,updated_at=now()`, id, receipt.Disposition, receipt.SHA256, receipt.ByteLength, path, receipt.Reason, receipt.Completeness, receipt.FinalizationID, raw)
	if err != nil {
		return queryError("save terminal receipt", err)
	}
	return nil
}
func (tx *sessionTx) SaveTerminalArchiveStatus(ctx context.Context, id string, status v2.ArchiveStatus) error {
	_, err := tx.tx.Exec(ctx, `INSERT INTO session_archives(session_id,state,error_code,schema_version,finalization_id) VALUES($1,$2,$3,2,$4) ON CONFLICT(session_id) DO UPDATE SET state=excluded.state,error_code=excluded.error_code,finalization_id=excluded.finalization_id,updated_at=now()`, id, status.State, status.ErrorCode, status.FinalizationID)
	if err != nil {
		return queryError("save terminal archive status", err)
	}
	return nil
}
func (tx *sessionTx) CurrentTerminalSession(ctx context.Context, project, task, claim string) (string, error) {
	var id string
	err := tx.tx.QueryRow(ctx, `SELECT id::text FROM task_sessions WHERE project_id=$1 AND task_id=$2 AND claim_id=$3 AND backend='herdr'`, project, task, claim).Scan(&id)
	if err != nil {
		return "", queryError("read current terminal session", err)
	}
	return id, nil
}
func (tx *sessionTx) TerminalHistory(ctx context.Context, project, task string, before *time.Time, beforeID *string, limit int) ([]TerminalHistoryRow, error) {
	rows, err := tx.tx.Query(ctx, `SELECT s.id::text,s.claim_id::text,s.backend,s.created_at,s.snapshot,s.terminal_state,a.state,a.sha256,a.byte_length::text,a.completeness FROM task_sessions s LEFT JOIN session_archives a ON a.session_id=s.id WHERE s.project_id=$1 AND s.task_id=$2 AND s.scope='task' AND ($3::timestamptz IS NULL OR (s.created_at,s.id)<($3,$4::uuid)) ORDER BY s.created_at DESC,s.id DESC LIMIT $5`, project, task, before, beforeID, limit)
	if err != nil {
		return nil, queryError("read terminal history", err)
	}
	defer rows.Close()
	var result []TerminalHistoryRow
	for rows.Next() {
		var row TerminalHistoryRow
		if err = rows.Scan(&row.ID, &row.Claim, &row.Backend, &row.Created, &row.Snapshot, &row.Terminal, &row.State, &row.Hash, &row.Size, &row.Completeness); err != nil {
			return nil, queryError("read terminal history", err)
		}
		result = append(result, row)
	}
	if err = rows.Err(); err != nil {
		return nil, queryError("read terminal history", err)
	}
	return result, nil
}
func (tx *sessionTx) TerminalRecordingEvidence(ctx context.Context, id string, generation int64, evidenceID string) (string, string, error) {
	var hash, revision string
	err := tx.tx.QueryRow(ctx, `SELECT body_hash,revision::text FROM session_recording_evidence WHERE session_id=$1 AND execution_generation=$2 AND evidence_id=$3`, id, generation, evidenceID).Scan(&hash, &revision)
	if err != nil {
		return "", "", queryError("read terminal recording evidence", err)
	}
	return hash, revision, nil
}
func (tx *sessionTx) TerminalAutomationAllowed(ctx context.Context, taskID string) (bool, error) {
	var allowed bool
	err := tx.tx.QueryRow(ctx, `SELECT allow_agents AND NOT EXISTS(SELECT 1 FROM task_properties WHERE task_id=tasks.id AND name='paused' AND value::jsonb='true'::jsonb) FROM tasks WHERE id=$1 AND deleted_at IS NULL`, taskID).Scan(&allowed)
	if err != nil {
		return false, queryError("read terminal automation permission", err)
	}
	return allowed, nil
}
func (tx *sessionTx) TerminalInputPending(ctx context.Context, id string) (bool, error) {
	var pending bool
	err := tx.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM session_operations WHERE session_id=$1 AND receipt->>'state' IN ('queued','dispatching'))`, id).Scan(&pending)
	if err != nil {
		return false, queryError("read pending terminal input", err)
	}
	return pending, nil
}
