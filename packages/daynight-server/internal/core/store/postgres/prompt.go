package postgres

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/internal/transaction"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type promptStore struct{ pool *pgxpool.Pool }

func NewPrompt(pool *pgxpool.Pool) *promptStore { return &promptStore{pool: pool} }
func (s *promptStore) ReadPromptSnapshot(ctx context.Context, operation func(store.PromptSnapshot) error) error {
	return store.ReadOnlySnapshot(ctx, s.pool, func(tx pgx.Tx) error { return operation(&promptTx{tx: tx}) })
}

type promptTx struct{ tx pgx.Tx }

type promptQuery interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func promptMetadata(ctx context.Context, tx promptQuery, user string, scope model.PromptScope, id string) (store.PromptMetadata, error) {
	var m store.PromptMetadata
	err := tx.QueryRow(ctx, `SELECT revision,updated_at FROM worker_prompts WHERE user_id=$1 AND scope=$2 AND scope_id=$3`, user, scope, id).Scan(&m.Revision, &m.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return store.PromptMetadata{}, nil
	}
	if err != nil {
		return store.PromptMetadata{}, promptError("read prompt metadata", err)
	}
	m.UpdatedAt = promptUTC(m.UpdatedAt)
	return m, nil
}
func promptText(ctx context.Context, tx promptQuery, user string, scope model.PromptScope, id string) (string, error) {
	var text string
	err := tx.QueryRow(ctx, `SELECT prompt_text FROM worker_prompts WHERE user_id=$1 AND scope=$2 AND scope_id=$3`, user, scope, id).Scan(&text)
	if err != nil {
		return "", promptError("read prompt text", err)
	}
	return text, nil
}
func promptWorkerExists(ctx context.Context, tx promptQuery, user, id string) error {
	var exists int
	err := tx.QueryRow(ctx, `SELECT 1 FROM workers WHERE user_id=$1 AND worker_id=$2`, user, id).Scan(&exists)
	if err != nil {
		return promptError("read prompt worker", err)
	}
	return nil
}
func (s *promptTx) PromptMetadata(ctx context.Context, u string, scope model.PromptScope, id string) (store.PromptMetadata, error) {
	return promptMetadata(ctx, s.tx, u, scope, id)
}
func (s *promptTx) PromptText(ctx context.Context, u string, scope model.PromptScope, id string) (string, error) {
	return promptText(ctx, s.tx, u, scope, id)
}
func (s *promptTx) PromptWorkerExists(ctx context.Context, u, id string) error {
	return promptWorkerExists(ctx, s.tx, u, id)
}

func (s *promptStore) WritePrompt(ctx context.Context, operation func(store.PromptWriteScope) error) (store.Completion, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, promptError("begin prompt write", err)
	}
	err = transaction.Run(ctx, tx, func(tx pgx.Tx) error { return operation(&promptTx{tx: tx}) }, false)
	if err == nil {
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	var failure *store.TransactionError
	outcome := store.TransactionUnknown
	if errors.As(err, &failure) {
		outcome = failure.Outcome
	}
	return store.Completion{Outcome: outcome}, promptError("write prompt", err)
}
func (s *promptTx) LockPromptProject(ctx context.Context, principal model.Principal, id string) error {
	var locked string
	if err := s.tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 FOR SHARE`, id).Scan(&locked); err != nil {
		return promptError("lock prompt project", err)
	}
	_, err := store.LockProjectAuthorization(ctx, s.tx, principal.UserID, id)
	return err
}
func scanPrompt(row pgx.Row, scope model.PromptScope, id string) (model.PromptResource, error) {
	var revision int64
	var resource model.PromptResource
	resource.Scope, resource.ScopeID = scope, id
	if err := row.Scan(&revision, &resource.Text, &resource.UpdatedAt); err != nil {
		return resource, err
	}
	resource.Revision = strconv.FormatInt(revision, 10)
	resource.UpdatedAt = promptUTC(resource.UpdatedAt)
	return resource, nil
}
func (s *promptTx) CreatePrompt(ctx context.Context, u string, scope model.PromptScope, id, text string) (model.PromptResource, error) {
	result, err := scanPrompt(s.tx.QueryRow(ctx, `INSERT INTO worker_prompts (user_id,scope,scope_id,revision,prompt_text,updated_at) VALUES ($1,$2,$3,1,$4,statement_timestamp()) ON CONFLICT (user_id,scope,scope_id) DO NOTHING RETURNING revision,prompt_text,updated_at`, u, scope, id, text), scope, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, &model.Fault{Code: "version_conflict", Message: "The prompt revision has changed."}
	}
	if err != nil {
		return result, promptError("create prompt", err)
	}
	return result, nil
}
func (s *promptTx) UpdatePrompt(ctx context.Context, u string, scope model.PromptScope, id string, next, expected int64, text string) (model.PromptResource, error) {
	result, err := scanPrompt(s.tx.QueryRow(ctx, `UPDATE worker_prompts SET revision=$4,prompt_text=$5,updated_at=statement_timestamp() WHERE user_id=$1 AND scope=$2 AND scope_id=$3 AND revision=$6 RETURNING revision,prompt_text,updated_at`, u, scope, id, next, text, expected), scope, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, &model.Fault{Code: "version_conflict", Message: "The prompt revision has changed."}
	}
	if err != nil {
		return result, promptError("update prompt", err)
	}
	return result, nil
}

func (s *promptTx) PromptResource(ctx context.Context, u string, scope model.PromptScope, id string) (model.PromptResource, error) {
	result, err := scanPrompt(s.tx.QueryRow(ctx, `SELECT revision,prompt_text,updated_at FROM worker_prompts WHERE user_id=$1 AND scope=$2 AND scope_id=$3`, u, scope, id), scope, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.PromptResource{Scope: scope, ScopeID: id, Revision: "0"}, nil
	}
	if err != nil {
		return result, promptError("read prompt", err)
	}
	return result, nil
}

func (s *promptTx) ProjectAccess(ctx context.Context, principal model.Principal, projectID string) (model.ProjectAccess, error) {
	return store.ReadProjectAccess(ctx, s.tx, principal.UserID, projectID)
}
func promptError(phase string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		err = errors.Join(model.ErrNotFound, err)
	}
	return &store.Error{Phase: phase, Cause: err}
}
func promptUTC(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	utc := value.UTC()
	return &utc
}
