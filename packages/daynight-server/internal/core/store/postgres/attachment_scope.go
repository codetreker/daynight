package postgres

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/attachment"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

func (s *Store) PutAttachment(ctx context.Context, value model.Attachment) (model.Attachment, bool, error) {
	return attachment.NewWriter(s.Pool).PutAttachment(ctx, value)
}

func (s *Store) DeleteAttachment(ctx context.Context, projectID, taskID, path string) error {
	return attachment.NewWriter(s.Pool).DeleteAttachment(ctx, projectID, taskID, path)
}

// WriteAttachmentMutation retains the Task lock until commit. Authorization is
// checked at admission without holding its source rows across file IO.
func (s *Store) WriteAttachmentMutation(ctx context.Context, operation func(store.AttachmentMutationScope) error) (store.Completion, error) {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin attachment mutation", err)
	}
	return transactAttachment(ctx, tx, operation)
}

func transactAttachment(ctx context.Context, tx pgx.Tx, operation func(store.AttachmentMutationScope) error) (store.Completion, error) {
	err := transact(ctx, tx, func(tx pgx.Tx) error { return operation(attachment.NewMutationScope(tx)) })
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
