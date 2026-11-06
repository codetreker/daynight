package attachment

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

type scope struct {
	*Reader
	tx pgx.Tx
}

// NewMutationScope binds Task authorization and attachment access to tx.
func NewMutationScope(tx pgx.Tx) store.AttachmentMutationScope {
	return &scope{Reader: &Reader{tx: tx}, tx: tx}
}

var _ store.AttachmentMutationScope = (*scope)(nil)
var _ store.AttachmentMutationDAO = (*scope)(nil)

// The lock includes deleted rows so callers can authorize before revealing the
// deletion state, including when a waiting deletion commits first.
func (s *scope) LockTaskPresence(ctx context.Context, projectID, taskID string) (store.TaskPresence, error) {
	var result store.TaskPresence
	err := s.tx.QueryRow(ctx, `SELECT deleted_at FROM tasks WHERE project_id=$1 AND id=$2 FOR SHARE`, projectID, taskID).Scan(&result.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, nil
	}
	if err != nil {
		return store.TaskPresence{}, pg.QueryError("lock attachment task", err)
	}
	result.Found = true
	if result.DeletedAt != nil {
		utc := result.DeletedAt.UTC()
		result.DeletedAt = &utc
	}
	return result, nil
}

func (s *scope) ProjectAuthorization(ctx context.Context, principal model.Principal, projectID string) (model.ProjectAccess, error) {
	// Admission follows the Task lock, but membership changes must not wait for
	// an admitted file stream. Read both authorization sources in one statement.
	return pg.ReadProjectAccess(ctx, s.tx, principal.UserID, projectID)
}

func (s *scope) AttachmentDAO() store.AttachmentMutationDAO { return s }
