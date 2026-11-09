package session

import (
	"bytes"
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

var _ store.SessionSourceDAO = (*DAO)(nil)

func (tx *DAO) SessionSourceHash(ctx context.Context, h store.SessionSourceHash) ([]byte, error) {
	var digest []byte
	e := tx.tx.QueryRow(ctx, `SELECT digest FROM session_source_hashes WHERE session_id=$1 AND source_epoch=$2 AND kind=$3 AND identity=$4`, h.SessionID, h.SourceEpoch, h.Kind, h.Identity).Scan(&digest)
	return digest, mediaQueryError("read original source hash", e)
}
func (tx *DAO) SaveSessionSourceHash(ctx context.Context, h store.SessionSourceHash) error {
	if previous, e := tx.SessionSourceHash(ctx, h); e == nil {
		if !bytes.Equal(previous, h.Digest) {
			return &model.Fault{Code: "resource_conflict", Message: "The original source identity already has different content."}
		}
		return nil
	} else if !errors.Is(e, model.ErrNotFound) {
		return e
	}
	// Keep a bounded original-ACK window. Older retries are rejected explicitly;
	// their identity is never guessed from a sequence checkpoint. Fixed identity
	// and digest records are capped at 8192 rows (under 1 MiB logical metadata).
	// The authorized Session lock serializes pruning and admission.
	if _, e := tx.tx.Exec(ctx, `DELETE FROM session_source_hashes WHERE session_id=$1 AND (source_epoch<>$2 OR source_seq <= $3::bigint-2048)`, h.SessionID, h.SourceEpoch, h.Through); e != nil {
		return mediaQueryError("prune source acknowledgement window", e)
	}
	var count int
	if e := tx.tx.QueryRow(ctx, `SELECT count(*) FROM session_source_hashes WHERE session_id=$1`, h.SessionID).Scan(&count); e != nil {
		return mediaQueryError("read source ledger capacity", e)
	}
	if count >= 8192 {
		return &model.Fault{Code: "quota_exceeded", Message: "The original source acknowledgement ledger is full."}
	}
	tag, e := tx.tx.Exec(ctx, `INSERT INTO session_source_hashes(session_id,source_epoch,kind,identity,digest,source_seq) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(session_id,source_epoch,kind,identity) DO UPDATE SET digest=EXCLUDED.digest WHERE session_source_hashes.digest=EXCLUDED.digest`, h.SessionID, h.SourceEpoch, h.Kind, h.Identity, h.Digest, h.Through)
	if e != nil {
		return mediaQueryError("persist original source hash", e)
	}
	if tag.RowsAffected() != 1 {
		return &model.Fault{Code: "resource_conflict", Message: "The original source identity already has different content."}
	}
	return nil
}
