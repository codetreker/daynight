package session

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

var _ store.SessionSourceDAO = (*DAO)(nil)

func (tx *DAO) SessionSourceHash(ctx context.Context, h store.SessionSourceHash) ([]byte, error) {
	var digest []byte
	e := tx.tx.QueryRow(ctx, `SELECT digest FROM session_source_hashes WHERE session_id=$1 AND source_epoch=$2 AND kind=$3 AND identity=$4`, h.SessionID, h.SourceEpoch, h.Kind, h.Identity).Scan(&digest)
	return digest, mediaQueryError("read original source hash", e)
}
func (tx *DAO) PruneSessionSourceHashes(ctx context.Context, session, epoch string, throughCutoff int64) error {
	_, err := tx.tx.Exec(ctx, `DELETE FROM session_source_hashes WHERE session_id=$1 AND (source_epoch<>$2 OR source_seq <= $3)`, session, epoch, throughCutoff)
	return mediaQueryError("prune source acknowledgement window", err)
}
func (tx *DAO) SessionSourceHashCount(ctx context.Context, session string) (int, error) {
	var count int
	err := tx.tx.QueryRow(ctx, `SELECT count(*) FROM session_source_hashes WHERE session_id=$1`, session).Scan(&count)
	return count, mediaQueryError("read source ledger capacity", err)
}
func (tx *DAO) SaveSessionSourceHash(ctx context.Context, h store.SessionSourceHash) error {
	tag, e := tx.tx.Exec(ctx, `INSERT INTO session_source_hashes(session_id,source_epoch,kind,identity,digest,source_seq) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,source_epoch,kind,identity) DO UPDATE SET digest=EXCLUDED.digest WHERE session_source_hashes.digest=EXCLUDED.digest`, h.SessionID, h.SourceEpoch, h.Kind, h.Identity, h.Digest, h.Through)
	if e != nil {
		return mediaQueryError("persist original source hash", e)
	}
	if tag.RowsAffected() != 1 {
		return &model.Fault{Code: "resource_conflict", Message: "The original source identity already has different content."}
	}
	return nil
}
