package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type privateTransferDAO struct {
	tx                         pgx.Tx
	ledgerLocked               bool
	authorized                 bool
	authorityKind, authorityID string
	credentialExpiry           *time.Time
}

func (s *Store) WritePrivateTransfer(ctx context.Context, operation func(store.PrivateTransferDAO) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin private transfer", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		dao := &privateTransferDAO{tx: tx}
		if err := operation(dao); err != nil {
			return err
		}
		return dao.recheckAuthority(ctx)
	})
	if err == nil {
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	var failure *store.TransactionError
	outcome := store.TransactionUnknown
	if errors.As(err, &failure) {
		outcome = failure.Outcome
	}
	return store.Completion{Outcome: outcome}, err
}

// Fixed state predicates in these queries match the partial indexes in migration 041,
// including when PostgreSQL selects a generic prepared plan.
func (d *privateTransferDAO) Stats(ctx context.Context) (store.PrivateTransferStats, error) {
	var stats store.PrivateTransferStats
	err := d.tx.QueryRow(ctx, `SELECT l.reserved_bytes, count(t.id), min(t.created_at) FROM private_transfer_ledger l LEFT JOIN private_transfers t ON t.state='cleanup_pending' WHERE l.singleton GROUP BY l.reserved_bytes`).Scan(&stats.ReservedBytes, &stats.CleanupPending, &stats.OldestPendingCreatedAt)
	if err != nil {
		return store.PrivateTransferStats{}, pg.QueryError("read private transfer statistics", err)
	}
	return stats, nil
}

func (d *privateTransferDAO) Authorize(ctx context.Context, principal model.Principal, kind, authorityID, projectID, taskID string) error {
	if model.RequirePrincipal(principal) != nil || (kind != "pat" && kind != "oauth") || string(principal.Kind) != kind || (kind == "pat" && principal.CredentialID != authorityID) {
		return model.Unauthenticated(nil)
	}
	presence, err := pg.TaskPresence(ctx, d.tx, projectID, taskID, " FOR SHARE")
	if err != nil {
		return err
	}
	if kind == "oauth" {
		// The grant precedes the access lock, matching RevokeFamily's lock order.
		var id string
		err = d.tx.QueryRow(ctx, `SELECT id::text FROM oauth_grants WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL FOR SHARE`, authorityID, principal.UserID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return model.Unauthenticated(err)
		}
		if err != nil {
			return pg.QueryError("lock transfer grant", err)
		}
	}
	var expiry *time.Time
	if kind == "oauth" {
		err = d.tx.QueryRow(ctx, `SELECT expires_at FROM oauth_access_tokens WHERE id=$1 AND user_id=$2 AND grant_id=$3 FOR SHARE`, principal.CredentialID, principal.UserID, authorityID).Scan(&expiry)
	} else {
		err = d.tx.QueryRow(ctx, `SELECT expires_at FROM personal_access_tokens WHERE id=$1 AND user_id=$2 FOR SHARE`, principal.CredentialID, principal.UserID).Scan(&expiry)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Unauthenticated(err)
	}
	if err != nil {
		return pg.QueryError("lock transfer credential", err)
	}
	if _, err = pg.LockProjectAuthorization(ctx, d.tx, principal.UserID, projectID); err != nil {
		return err
	}
	if !presence.Found || presence.DeletedAt != nil {
		return model.ErrNotFound
	}
	d.authorized = true
	d.authorityKind, d.authorityID, d.credentialExpiry = kind, authorityID, expiry
	return d.recheckAuthority(ctx)
}

// Recheck after the callback as ledger and filesystem-capacity waits can outlast
// the credential even though the locked authority rows did not change.
func (d *privateTransferDAO) recheckAuthority(ctx context.Context) error {
	if !d.authorized {
		return nil
	}
	var valid bool
	var err error
	if d.authorityKind == "oauth" {
		err = d.tx.QueryRow(ctx, `SELECT $1::timestamptz>clock_timestamp() AND expires_at>clock_timestamp() AND revoked_at IS NULL FROM oauth_grants WHERE id=$2`, d.credentialExpiry, d.authorityID).Scan(&valid)
	} else {
		err = d.tx.QueryRow(ctx, `SELECT $1::timestamptz IS NULL OR $1::timestamptz>clock_timestamp()`, d.credentialExpiry).Scan(&valid)
	}
	if err != nil {
		return pg.QueryError("recheck transfer credential", err)
	}
	if !valid {
		return model.Unauthenticated(nil)
	}
	return nil
}

const transferColumns = `id::text,user_id::text,authority_kind,authority_id::text,direction,project_id::text,task_id::text,path,content_type,binding,data,state,cleanup_from_state,reserved_bytes,outstanding_bytes,version,created_at,updated_at,expires_at,hard_expires_at,lease_until,retain_until,last_cleanup_attempt`

func scanPrivateTransfer(row pgx.Row) (model.PrivateTransfer, error) {
	var t model.PrivateTransfer
	err := row.Scan(&t.ID, &t.UserID, &t.AuthorityKind, &t.AuthorityID, &t.Direction, &t.ProjectID, &t.TaskID, &t.Path, &t.ContentType, &t.Binding, &t.Data, &t.State, &t.CleanupFromState, &t.ReservedBytes, &t.OutstandingBytes, &t.Version, &t.CreatedAt, &t.UpdatedAt, &t.ExpiresAt, &t.HardExpiresAt, &t.LeaseUntil, &t.RetainUntil, &t.LastCleanupAttempt)
	if err != nil {
		return model.PrivateTransfer{}, pg.QueryError("read private transfer", err)
	}
	return t, nil
}

func (d *privateTransferDAO) Get(ctx context.Context, id string) (model.PrivateTransfer, error) {
	return scanPrivateTransfer(d.tx.QueryRow(ctx, `SELECT `+transferColumns+` FROM private_transfers WHERE id=$1 FOR UPDATE`, id))
}

func (d *privateTransferDAO) Insert(ctx context.Context, t model.PrivateTransfer) (model.PrivateTransfer, bool, error) {
	result, err := scanPrivateTransfer(d.tx.QueryRow(ctx, `INSERT INTO private_transfers(id,user_id,authority_kind,authority_id,direction,project_id,task_id,path,content_type,binding,data,state,created_at,updated_at,expires_at,hard_expires_at,lease_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (id) DO NOTHING RETURNING `+transferColumns, t.ID, t.UserID, t.AuthorityKind, t.AuthorityID, t.Direction, t.ProjectID, t.TaskID, t.Path, t.ContentType, t.Binding, t.Data, t.State, t.CreatedAt, t.UpdatedAt, t.ExpiresAt, t.HardExpiresAt, t.LeaseUntil))
	if errors.Is(err, model.ErrNotFound) {
		existing, e := d.Get(ctx, t.ID)
		return existing, false, e
	}
	if err != nil {
		return model.PrivateTransfer{}, false, err
	}
	return result, true, nil
}

func (d *privateTransferDAO) CountActive(ctx context.Context, userID string) (int, error) {
	var active int
	if err := d.tx.QueryRow(ctx, `SELECT count(*) FROM private_transfers WHERE user_id=$1 AND state<>'closed'`, userID).Scan(&active); err != nil {
		return 0, pg.QueryError("count active private transfers", err)
	}
	return active, nil
}

func (d *privateTransferDAO) LockLedger(ctx context.Context) error {
	if d.ledgerLocked {
		return nil
	}
	var reserved int64
	if err := d.tx.QueryRow(ctx, `SELECT reserved_bytes FROM private_transfer_ledger WHERE singleton FOR UPDATE`).Scan(&reserved); err != nil {
		return pg.QueryError("lock private transfer ledger", err)
	}
	d.ledgerLocked = true
	return nil
}

func (d *privateTransferDAO) OutstandingTotal(ctx context.Context) (int64, error) {
	if err := d.LockLedger(ctx); err != nil {
		return 0, err
	}
	var total int64
	if err := d.tx.QueryRow(ctx, `SELECT outstanding_bytes FROM private_transfer_ledger WHERE singleton`).Scan(&total); err != nil {
		return 0, pg.QueryError("read outstanding transfer capacity", err)
	}
	return total, nil
}

func (d *privateTransferDAO) ReservedTotal(ctx context.Context) (int64, error) {
	if err := d.LockLedger(ctx); err != nil {
		return 0, err
	}
	var total int64
	if err := d.tx.QueryRow(ctx, `SELECT reserved_bytes FROM private_transfer_ledger WHERE singleton`).Scan(&total); err != nil {
		return 0, pg.QueryError("read private transfer capacity", err)
	}
	return total, nil
}

func (d *privateTransferDAO) AddReservation(ctx context.Context, id string, additional int64) (model.PrivateTransfer, error) {
	if _, err := d.tx.Exec(ctx, `UPDATE private_transfer_ledger SET reserved_bytes=reserved_bytes+$1,outstanding_bytes=outstanding_bytes+$1 WHERE singleton`, additional); err != nil {
		return model.PrivateTransfer{}, pg.QueryError("reserve private transfer capacity", err)
	}
	return scanPrivateTransfer(d.tx.QueryRow(ctx, `UPDATE private_transfers SET reserved_bytes=reserved_bytes+$2,outstanding_bytes=outstanding_bytes+$2,version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING `+transferColumns, id, additional))
}

func (d *privateTransferDAO) SubtractOutstanding(ctx context.Context, id string, amount int64) (model.PrivateTransfer, error) {
	result, err := d.tx.Exec(ctx, `UPDATE private_transfer_ledger SET outstanding_bytes=outstanding_bytes-$1 WHERE singleton AND outstanding_bytes >= $1`, amount)
	if err != nil {
		return model.PrivateTransfer{}, pg.QueryError("consume transfer reservation", err)
	}
	if result.RowsAffected() != 1 {
		return model.PrivateTransfer{}, errors.New("private transfer outstanding ledger underflow")
	}
	return scanPrivateTransfer(d.tx.QueryRow(ctx, `UPDATE private_transfers SET outstanding_bytes=outstanding_bytes-$2,updated_at=clock_timestamp(),version=version+1 WHERE id=$1 RETURNING `+transferColumns, id, amount))
}

func scanUploadChunk(row pgx.Row) (model.UploadChunk, error) {
	var c model.UploadChunk
	err := row.Scan(&c.TransferID, &c.ChunkID, &c.ObjectID, &c.Offset, &c.Size, &c.SHA256)
	if err != nil {
		return model.UploadChunk{}, pg.QueryError("read upload chunk receipt", err)
	}
	return c, nil
}

const uploadChunkColumns = `transfer_id::text,chunk_id::text,object_id::text,byte_offset,byte_size,sha256`

func (d *privateTransferDAO) UploadChunk(ctx context.Context, transferID, chunkID string) (model.UploadChunk, error) {
	return scanUploadChunk(d.tx.QueryRow(ctx, `SELECT `+uploadChunkColumns+` FROM private_upload_chunks WHERE transfer_id=$1 AND chunk_id=$2`, transferID, chunkID))
}

func (d *privateTransferDAO) UploadChunkAt(ctx context.Context, transferID string, offset int64) (model.UploadChunk, error) {
	return scanUploadChunk(d.tx.QueryRow(ctx, `SELECT `+uploadChunkColumns+` FROM private_upload_chunks WHERE transfer_id=$1 AND byte_offset=$2`, transferID, offset))
}

func (d *privateTransferDAO) InsertUploadChunk(ctx context.Context, c model.UploadChunk) error {
	result, err := d.tx.Exec(ctx, `INSERT INTO private_upload_chunks (transfer_id,chunk_id,object_id,byte_offset,byte_size,sha256) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, c.TransferID, c.ChunkID, c.ObjectID, c.Offset, c.Size, c.SHA256)
	if err != nil {
		return pg.QueryError("insert upload chunk receipt", err)
	}
	if result.RowsAffected() != 1 {
		return &model.Fault{Code: "transfer_conflict", Message: "Upload chunk receipt conflicts with an existing receipt."}
	}
	return nil
}

func (d *privateTransferDAO) Put(ctx context.Context, t model.PrivateTransfer, expected int64) (model.PrivateTransfer, error) {
	return scanPrivateTransfer(d.tx.QueryRow(ctx, `UPDATE private_transfers SET cleanup_from_state=$7,state=$3,data=$4,expires_at=$5,lease_until=$6,updated_at=clock_timestamp(),version=version+1 WHERE id=$1 AND version=$2 RETURNING `+transferColumns, t.ID, expected, t.State, t.Data, t.ExpiresAt, t.LeaseUntil, t.CleanupFromState))
}

func (d *privateTransferDAO) Release(ctx context.Context, t model.PrivateTransfer, expected int64, retainUntil time.Time, closedState string) (model.PrivateTransfer, error) {
	result, err := d.tx.Exec(ctx, `UPDATE private_transfer_ledger SET reserved_bytes=reserved_bytes-$1,outstanding_bytes=outstanding_bytes-$2 WHERE singleton AND reserved_bytes >= $1 AND outstanding_bytes >= $2`, t.ReservedBytes, t.OutstandingBytes)
	if err != nil {
		return model.PrivateTransfer{}, pg.QueryError("release private transfer capacity", err)
	}
	if result.RowsAffected() != 1 {
		return model.PrivateTransfer{}, errors.New("private transfer ledger underflow")
	}
	return scanPrivateTransfer(d.tx.QueryRow(ctx, `UPDATE private_transfers SET state=$4,reserved_bytes=0,outstanding_bytes=0,retain_until=$3,lease_until=NULL,updated_at=clock_timestamp(),version=version+1 WHERE id=$1 AND version=$2 RETURNING `+transferColumns, t.ID, expected, retainUntil, closedState))
}

func (d *privateTransferDAO) Due(ctx context.Context, now time.Time, limit int) ([]model.PrivateTransfer, error) {
	rows, err := d.tx.Query(ctx, `WITH candidates AS (
 SELECT id FROM private_transfers WHERE state<>'closed'
 AND (state='cleanup_pending' OR expires_at<=$1 OR hard_expires_at<=$1 OR (state='committing' AND (lease_until IS NULL OR lease_until<=$1)))
 AND (state<>'committing' OR lease_until IS NULL OR lease_until<=$1)
 ORDER BY COALESCE(last_cleanup_attempt,LEAST(expires_at,hard_expires_at,CASE WHEN state='cleanup_pending' THEN updated_at WHEN state='committing' THEN COALESCE(lease_until,created_at) ELSE expires_at END)),id LIMIT $2 FOR UPDATE SKIP LOCKED
 ) UPDATE private_transfers SET last_cleanup_attempt=$1,version=version+1 WHERE id IN (SELECT id FROM candidates) RETURNING `+transferColumns, now, limit)
	if err != nil {
		return nil, pg.QueryError("list due private transfers", err)
	}
	defer rows.Close()
	var result []model.PrivateTransfer
	for rows.Next() {
		t, err := scanPrivateTransfer(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, t)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("list due private transfers", err)
	}
	return result, nil
}

func (d *privateTransferDAO) Prune(ctx context.Context, now time.Time, limit int) (int64, error) {
	result, err := d.tx.Exec(ctx, `DELETE FROM private_transfers WHERE id IN (SELECT id FROM private_transfers WHERE state='closed' AND retain_until<=$1 ORDER BY retain_until,id LIMIT $2)`, now, limit)
	if err != nil {
		return 0, pg.QueryError("prune private transfers", err)
	}
	return result.RowsAffected(), nil
}
