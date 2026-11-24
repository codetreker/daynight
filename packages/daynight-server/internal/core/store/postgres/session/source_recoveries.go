package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

var _ store.SessionSourceRecoveryDAO = (*DAO)(nil)

func (tx *DAO) SessionSourceRecovery(ctx context.Context, session, id string) (store.SessionSourceRecovery, error) {
	out := store.SessionSourceRecovery{SessionID: session, RecoveryID: id}
	err := tx.tx.QueryRow(ctx, `SELECT digest, verified_through FROM session_source_recoveries WHERE session_id=$1 AND recovery_id=$2`, session, id).Scan(&out.Digest, &out.VerifiedThrough)
	return out, mediaQueryError("read source recovery", err)
}
func (tx *DAO) SessionSourceRecoveryCount(ctx context.Context, session string) (int, error) {
	var expected, actual int
	err := tx.tx.QueryRow(ctx, `SELECT source_recovery_count, (SELECT count(*) FROM session_source_recoveries WHERE session_id=$1) FROM task_sessions WHERE id=$1`, session).Scan(&expected, &actual)
	if err != nil {
		return 0, mediaQueryError("read source recovery inventory", err)
	}
	if expected != actual || expected < 0 || expected > 4096 {
		return 0, &model.Fault{Code: "source_corrupt", Message: "The source recovery inventory is incomplete."}
	}
	return expected, nil
}
func (tx *DAO) SaveSessionSourceRecovery(ctx context.Context, h store.SessionSourceRecovery) error {
	tag, err := tx.tx.Exec(ctx, `UPDATE task_sessions SET source_recovery_count=source_recovery_count+1 WHERE id=$1 AND source_recovery_count<4096`, h.SessionID)
	if err != nil {
		return mediaQueryError("reserve source recovery", err)
	}
	if tag.RowsAffected() != 1 {
		return &model.Fault{Code: "quota_exceeded", Message: "The source recovery ledger is full."}
	}
	_, err = tx.tx.Exec(ctx, `INSERT INTO session_source_recoveries(session_id,recovery_id,digest,verified_through) VALUES($1,$2,$3,$4)`, h.SessionID, h.RecoveryID, h.Digest, h.VerifiedThrough)
	return mediaQueryError("persist source recovery", err)
}
