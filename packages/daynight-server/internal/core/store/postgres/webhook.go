package postgres

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	wh "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/jackc/pgx/v5"
)

type webhookScope struct {
	tx          pgx.Tx
	owner       wh.Owner
	operationID string
	dao         store.WebhookWriteDAO
}

func (s *Store) WriteWebhook(ctx context.Context, owner wh.Owner, operationID string, operation func(store.WebhookWriteScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin Webhook write", err)
	}
	err = writeWebhookTx(ctx, tx, owner, operationID, operation)
	return teamCompletion("Webhook write", err)
}

func writeWebhookTx(ctx context.Context, tx pgx.Tx, owner wh.Owner, operationID string, operation func(store.WebhookWriteScope) error) error {
	return transact(ctx, tx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "webhook-operation/"+string(owner.Kind)+"/"+owner.ID+"/"+operationID); err != nil {
			return pg.QueryError("lock Webhook operation", err)
		}
		return operation(&webhookScope{tx: tx, owner: owner, operationID: operationID, dao: webhook.NewWriter(tx, owner, operationID)})
	})
}

func (s *webhookScope) WebhookDAO() store.WebhookWriteDAO     { return s.dao }
func (s *webhookScope) CredentialDAO() store.CredentialReader { return &Snapshot{tx: s.tx} }
func (s *webhookScope) ObservedAt(ctx context.Context) (time.Time, error) {
	var observed time.Time
	if err := s.tx.QueryRow(ctx, `SELECT statement_timestamp()`).Scan(&observed); err != nil {
		return time.Time{}, pg.QueryError("read Webhook observation time", err)
	}
	return observed.UTC(), nil
}

func (s *Snapshot) WebhookDAO() store.WebhookReadDAO { return webhook.NewReader(s.tx) }
func (s *ProjectTx) WebhookEligibilityDAO() store.WebhookEligibilityDAO {
	return webhook.NewEligibility(s.tx)
}
func (s *deletionScope) WebhookEligibilityDAO() store.WebhookEligibilityDAO {
	return webhook.NewEligibility(s.tx)
}
