package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"

	"github.com/google/uuid"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	dbwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/jackc/pgx/v5"
)

type webhookScope struct{ *Snapshot }

func (s *webhookScope) WebhookDAO() store.WebhookReader    { return dbwebhook.New(s.tx) }
func (s *webhookScope) WebhookWriter() store.WebhookWriter { return dbwebhook.New(s.tx) }
func (s *webhookScope) LockCredential(ctx context.Context, p model.Principal) (store.ThreadCredential, error) {
	return pg.ThreadCredential(ctx, s.tx, p, " FOR SHARE")
}
func (s *webhookScope) LockAuthority(ctx context.Context, o webhook.Owner, user string) error {
	if o.Kind == "user" {
		if o.ID != user {
			return model.ErrNotFound
		}
		return nil
	}
	if o.Kind != "team" {
		return model.ErrNotFound
	}
	var id string
	if err := s.tx.QueryRow(ctx, `SELECT id::text FROM teams WHERE id=$1 AND personal_user_id IS NULL FOR SHARE`, o.ID).Scan(&id); err != nil {
		return pg.QueryError("lock webhook Team", err)
	}
	if err := s.tx.QueryRow(ctx, `SELECT user_id::text FROM team_members WHERE team_id=$1 AND user_id=$2 FOR SHARE`, o.ID, user).Scan(&id); err != nil {
		return pg.QueryError("lock webhook membership", err)
	}
	return nil
}
func (s *Store) ReadWebhookSnapshot(ctx context.Context, operation func(store.WebhookReadScope) error) error {
	return readSnapshot(ctx, s.Pool, func(tx pgx.Tx) error { return operation(&webhookScope{&Snapshot{tx: tx}}) }, false)
}
func (s *Store) WriteWebhook(ctx context.Context, o webhook.Owner, id string, operation func(store.WebhookWriteScope) error) (store.Completion, error) {
	ownerID, ownerErr := uuid.Parse(o.ID)
	operationID, operationErr := uuid.Parse(id)
	if ownerErr != nil || operationErr != nil || (o.Kind != "user" && o.Kind != "team") {
		return store.Completion{Outcome: store.TransactionNotCommitted}, fmt.Errorf("invalid webhook operation identity")
	}
	o.ID, id = ownerID.String(), operationID.String()
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin webhook write", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		sum := sha256.Sum256([]byte("daynight-webhook-operation\x00" + o.Kind + "\x00" + o.ID + "\x00" + id))
		key := int64(binary.BigEndian.Uint64(sum[:8]))
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, key); err != nil {
			return pg.QueryError("fence webhook operation", err)
		}
		return operation(&webhookScope{&Snapshot{tx: tx}})
	})
	return teamCompletion("write webhook", err)
}

var _ store.WebhookTransactions = (*Store)(nil)
