package session

import (
	"context"
	"encoding/json"
	"time"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pginternal "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

func (tx *DAO) TerminalArchive(ctx context.Context, id string) (v2.ArchiveStatus, *v2.Receipt, string, error) {
	var status v2.ArchiveStatus
	var raw []byte
	var path *string
	err := tx.tx.QueryRow(ctx, `SELECT state,sha256,byte_length::text,completeness,error_code,finalization_id::text,receipt,object_path FROM session_archives WHERE session_id=$1 AND schema_version=2`, id).Scan(&status.State, &status.SHA256, &status.ByteLength, &status.Completeness, &status.ErrorCode, &status.FinalizationID, &raw, &path)
	if err != nil {
		return status, nil, "", pginternal.QueryError("read terminal archive", err)
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
func (tx *DAO) CurrentTerminalSession(ctx context.Context, project, task, claim string) (string, error) {
	var id string
	err := tx.tx.QueryRow(ctx, `SELECT id::text FROM task_sessions WHERE project_id=$1 AND task_id=$2 AND claim_id=$3 AND backend='herdr'`, project, task, claim).Scan(&id)
	if err != nil {
		return "", pginternal.QueryError("read current terminal session", err)
	}
	return id, nil
}
func (tx *DAO) TerminalHistory(ctx context.Context, project, task string, before *time.Time, beforeID *string, limit int) ([]store.TerminalHistoryRow, error) {
	rows, err := tx.tx.Query(ctx, `SELECT s.id::text,s.claim_id::text,s.backend,s.created_at,s.snapshot,s.terminal_state,a.state,a.sha256,a.byte_length::text,a.completeness FROM task_sessions s LEFT JOIN session_archives a ON a.session_id=s.id WHERE s.project_id=$1 AND s.task_id=$2 AND s.scope='task' AND ($3::timestamptz IS NULL OR (s.created_at,s.id)<($3,$4::uuid)) ORDER BY s.created_at DESC,s.id DESC LIMIT $5`, project, task, before, beforeID, limit)
	if err != nil {
		return nil, pginternal.QueryError("read terminal history", err)
	}
	defer rows.Close()
	var result []store.TerminalHistoryRow
	for rows.Next() {
		var row store.TerminalHistoryRow
		if err = rows.Scan(&row.ID, &row.Claim, &row.Backend, &row.Created, &row.Snapshot, &row.Terminal, &row.State, &row.Hash, &row.Size, &row.Completeness); err != nil {
			return nil, pginternal.QueryError("read terminal history", err)
		}
		result = append(result, row)
	}
	if err = rows.Err(); err != nil {
		return nil, pginternal.QueryError("read terminal history", err)
	}
	return result, nil
}
