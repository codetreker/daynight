package attachment

import (
	"context"

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
	return pg.LockTaskResource(ctx, s.tx, projectID, taskID, false)
}

func (s *scope) ProjectAuthorization(ctx context.Context, principal model.Principal, projectID string) (model.ProjectAccess, error) {
	// Admission follows the Task lock, but membership changes must not wait for
	// an admitted file stream. Read both authorization sources in one statement.
	return pg.ReadProjectAccess(ctx, s.tx, principal.UserID, projectID)
}

func (s *scope) AttachmentDAO() store.AttachmentMutationDAO { return s }

// ProjectLive checks the deletion barrier after the caller has locked the Task.
func (s *scope) ProjectLive(ctx context.Context, projectID string) error {
	var live bool
	if err := s.tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM projects WHERE id=$1 AND deleted_at IS NULL)`, projectID).Scan(&live); err != nil {
		return pg.QueryError("check attachment project lifecycle", err)
	}
	if !live {
		return model.ErrNotFound
	}
	return nil
}

func (s *scope) UploadChunkAt(ctx context.Context, transferID string, offset int64) (model.UploadChunk, error) {
	var c model.UploadChunk
	err := s.tx.QueryRow(ctx, `SELECT transfer_id::text,chunk_id::text,object_id::text,byte_offset,byte_size,sha256 FROM private_upload_chunks WHERE transfer_id=$1 AND byte_offset=$2`, transferID, offset).Scan(&c.TransferID, &c.ChunkID, &c.ObjectID, &c.Offset, &c.Size, &c.SHA256)
	if err != nil {
		return model.UploadChunk{}, pg.QueryError("read admitted upload chunk", err)
	}
	return c, nil
}
