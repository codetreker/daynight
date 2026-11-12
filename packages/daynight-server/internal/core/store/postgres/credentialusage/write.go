// Package credentialusage owns the PostgreSQL usage metadata statements.
package credentialusage

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
)

// Write locks the entire existing set without waiting before issuing updates.
// This prevents a metadata batch from waiting while holding an earlier row lock.
func Write(ctx context.Context, tx pgx.Tx, events []model.CredentialUsageEvent) error {
	locks := &pgx.Batch{}
	for _, event := range events {
		query := `SELECT id FROM personal_access_tokens WHERE id=$1 AND user_id=$2 FOR UPDATE NOWAIT`
		if event.Kind == model.UsageSubjectOAuthGrant {
			query = `SELECT id FROM oauth_grants WHERE id=$1 AND user_id=$2 FOR UPDATE NOWAIT`
		}
		locks.Queue(query, event.SubjectID, event.UserID)
	}
	results := tx.SendBatch(ctx, locks)
	locked := make([]model.CredentialUsageEvent, 0, len(events))
	var failure error
	for _, event := range events {
		var id string
		err := results.QueryRow().Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			failure = err
			break
		}
		locked = append(locked, event)
	}
	if err := results.Close(); err != nil {
		failure = errors.Join(failure, err)
	}
	if failure != nil {
		return failure
	}
	if len(locked) == 0 {
		return nil
	}
	updates := &pgx.Batch{}
	for _, event := range locked {
		query := `UPDATE personal_access_tokens SET last_used_at=$3 WHERE id=$1 AND user_id=$2 AND (last_used_at IS NULL OR last_used_at<$3)`
		if event.Kind == model.UsageSubjectOAuthGrant {
			query = `UPDATE oauth_grants SET last_used_at=$3 WHERE id=$1 AND user_id=$2 AND (last_used_at IS NULL OR last_used_at<$3)`
		}
		updates.Queue(query, event.SubjectID, event.UserID, event.At)
	}
	results = tx.SendBatch(ctx, updates)
	for range locked {
		if _, err := results.Exec(); err != nil {
			failure = err
			break
		}
	}
	return errors.Join(failure, results.Close())
}
