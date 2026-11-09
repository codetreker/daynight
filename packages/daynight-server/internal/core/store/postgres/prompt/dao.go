package prompt

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
	"strconv"
	"time"
)

type DAO struct{ tx pgx.Tx }

func NewDAO(tx pgx.Tx) *DAO { return &DAO{tx: tx} }

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
	if m.Revision <= 0 {
		return store.PromptMetadata{}, promptError("read prompt metadata", errors.New("stored prompt revision is not positive"))
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
func (s *DAO) PromptMetadata(ctx context.Context, u string, scope model.PromptScope, id string) (store.PromptMetadata, error) {
	return promptMetadata(ctx, s.tx, u, scope, id)
}
func (s *DAO) PromptText(ctx context.Context, u string, scope model.PromptScope, id string) (string, error) {
	return promptText(ctx, s.tx, u, scope, id)
}
func (s *DAO) PromptWorkerExists(ctx context.Context, u, id string) error {
	return promptWorkerExists(ctx, s.tx, u, id)
}

func (s *DAO) LockPromptProject(ctx context.Context, principal model.Principal, id string) error {
	var locked string
	if err := s.tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, id).Scan(&locked); err != nil {
		return promptError("lock prompt project", err)
	}
	_, err := pg.LockProjectAuthorization(ctx, s.tx, principal.UserID, id)
	return err
}
func scanPrompt(row pgx.Row, scope model.PromptScope, id string) (model.PromptResource, error) {
	var revision int64
	var resource model.PromptResource
	resource.Scope, resource.ScopeID = scope, id
	if err := row.Scan(&revision, &resource.Text, &resource.UpdatedAt); err != nil {
		return resource, err
	}
	if revision <= 0 {
		return model.PromptResource{}, errors.New("stored prompt revision is not positive")
	}
	resource.Revision = strconv.FormatInt(revision, 10)
	resource.UpdatedAt = promptUTC(resource.UpdatedAt)
	return resource, nil
}
func (s *DAO) CreatePrompt(ctx context.Context, u string, scope model.PromptScope, id, text string) (model.PromptResource, error) {
	result, err := scanPrompt(s.tx.QueryRow(ctx, `INSERT INTO worker_prompts (user_id,scope,scope_id,revision,prompt_text,updated_at) VALUES ($1,$2,$3,1,$4,statement_timestamp()) ON CONFLICT (user_id,scope,scope_id) DO NOTHING RETURNING revision,prompt_text,updated_at`, u, scope, id, text), scope, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, &model.Fault{Code: "version_conflict", Message: "The prompt revision has changed."}
	}
	if err != nil {
		return result, promptError("create prompt", err)
	}
	return result, nil
}
func (s *DAO) UpdatePrompt(ctx context.Context, u string, scope model.PromptScope, id string, next, expected int64, text string) (model.PromptResource, error) {
	result, err := scanPrompt(s.tx.QueryRow(ctx, `UPDATE worker_prompts SET revision=$4,prompt_text=$5,updated_at=statement_timestamp() WHERE user_id=$1 AND scope=$2 AND scope_id=$3 AND revision=$6 RETURNING revision,prompt_text,updated_at`, u, scope, id, next, text, expected), scope, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, &model.Fault{Code: "version_conflict", Message: "The prompt revision has changed."}
	}
	if err != nil {
		return result, promptError("update prompt", err)
	}
	return result, nil
}

func (s *DAO) PromptResource(ctx context.Context, u string, scope model.PromptScope, id string) (model.PromptResource, error) {
	result, err := scanPrompt(s.tx.QueryRow(ctx, `SELECT revision,prompt_text,updated_at FROM worker_prompts WHERE user_id=$1 AND scope=$2 AND scope_id=$3`, u, scope, id), scope, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.PromptResource{Scope: scope, ScopeID: id, Revision: "0"}, nil
	}
	if err != nil {
		return result, promptError("read prompt", err)
	}
	return result, nil
}

func (s *DAO) ProjectAccess(ctx context.Context, principal model.Principal, projectID string) (model.ProjectAccess, error) {
	return pg.ReadProjectAccess(ctx, s.tx, principal.UserID, projectID)
}
func promptError(phase string, err error) error { return pg.QueryError(phase, err) }
func promptUTC(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	utc := value.UTC()
	return &utc
}
