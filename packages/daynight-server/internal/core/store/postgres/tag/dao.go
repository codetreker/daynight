package tag

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

const projection = `id::text, project_id::text, name, name_key, version, created_at, updated_at`

type reader struct{ tx pgx.Tx }
type writer struct {
	tx        pgx.Tx
	projectID string
}

func NewReader(tx pgx.Tx) store.TagReader { return &reader{tx: tx} }
func NewWriter(tx pgx.Tx, projectID string) store.TagWriteDAO {
	return &writer{tx: tx, projectID: projectID}
}

var _ store.TagReader = (*reader)(nil)
var _ store.TagWriteDAO = (*writer)(nil)

func scan(row pgx.Row) (model.Tag, error) {
	var item model.Tag
	err := row.Scan(&item.ID, &item.ProjectID, &item.Name, &item.NameKey, &item.Version, &item.CreatedAt, &item.UpdatedAt)
	item.CreatedAt = item.CreatedAt.UTC()
	item.UpdatedAt = item.UpdatedAt.UTC()
	return item, err
}

func (r *reader) TagCatalogEpoch(ctx context.Context, projectID string) (string, error) {
	var epoch string
	err := r.tx.QueryRow(ctx, `SELECT tag_catalog_epoch::text FROM projects WHERE id=$1 AND deleted_at IS NULL`, projectID).Scan(&epoch)
	if err != nil {
		return "", pg.QueryError("read tag catalog epoch", err)
	}
	return epoch, nil
}

func (r *reader) Tags(ctx context.Context, projectID string, query store.TagQuery) (store.TagPage, error) {
	if query.Limit < 1 {
		return store.TagPage{}, fmt.Errorf("invalid tag page limit")
	}
	var afterKey, afterID any
	if query.After != nil {
		afterKey, afterID = query.After.NameKey, query.After.ID
	}
	rows, err := r.tx.Query(ctx, `SELECT `+projection+` FROM project_tags
		WHERE project_id=$1 AND strpos(name_key, $2)>0
		AND ($3::text IS NULL OR (name_key COLLATE "C", id)>($3::text COLLATE "C", $4::uuid))
		ORDER BY name_key COLLATE "C", id LIMIT $5`, projectID, query.NameContains, afterKey, afterID, query.Limit+1)
	if err != nil {
		return store.TagPage{}, pg.QueryError("list tags", err)
	}
	defer rows.Close()
	items := make([]model.Tag, 0)
	for rows.Next() {
		item, err := scan(rows)
		if err != nil {
			return store.TagPage{}, pg.QueryError("list tags", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return store.TagPage{}, pg.QueryError("list tags", err)
	}
	hasMore := len(items) > query.Limit
	if hasMore {
		items = items[:query.Limit]
	}
	return store.TagPage{Items: items, HasMore: hasMore}, nil
}

func (r *reader) Tag(ctx context.Context, projectID, id string) (model.Tag, error) {
	item, err := scan(r.tx.QueryRow(ctx, `SELECT `+projection+` FROM project_tags WHERE project_id=$1 AND id=$2`, projectID, id))
	if err != nil {
		return model.Tag{}, pg.QueryError("read tag", err)
	}
	return item, nil
}

func (r *reader) TagUsage(ctx context.Context, projectID, id string) (model.TagUsage, error) {
	var usage model.TagUsage
	err := r.tx.QueryRow(ctx, `SELECT count(*) FILTER (WHERE t.type='task'), count(*) FILTER (WHERE t.type='goal')
		FROM task_tags tt JOIN task_resource_rows t ON t.project_id=tt.project_id AND t.id=tt.task_id
		WHERE tt.project_id=$1 AND tt.tag_id=$2 AND t.effective_deleted_at IS NULL`, projectID, id).Scan(&usage.Tasks, &usage.Goals)
	if err != nil {
		return model.TagUsage{}, pg.QueryError("read tag usage", err)
	}
	return usage, nil
}

func (r *reader) ResolveTags(ctx context.Context, projectID string, ids []string) ([]model.Tag, error) {
	rows, err := r.tx.Query(ctx, `SELECT `+projection+` FROM project_tags WHERE project_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`, projectID, ids)
	if err != nil {
		return nil, pg.QueryError("resolve tags", err)
	}
	defer rows.Close()
	items := make([]model.Tag, 0)
	for rows.Next() {
		item, err := scan(rows)
		if err != nil {
			return nil, pg.QueryError("resolve tags", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("resolve tags", err)
	}
	return items, nil
}

func (w *writer) Tag(ctx context.Context, id string) (model.Tag, error) {
	return (&reader{tx: w.tx}).Tag(ctx, w.projectID, id)
}

func (w *writer) TagUsage(ctx context.Context, id string) (model.TagUsage, error) {
	return (&reader{tx: w.tx}).TagUsage(ctx, w.projectID, id)
}

func (w *writer) ResolveTags(ctx context.Context, ids []string) ([]model.Tag, error) {
	return (&reader{tx: w.tx}).ResolveTags(ctx, w.projectID, ids)
}

func (w *writer) InsertTag(ctx context.Context, item model.Tag) (model.Tag, error) {
	result, err := scan(w.tx.QueryRow(ctx, `INSERT INTO project_tags (id, project_id, name, name_key, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$5) RETURNING `+projection, item.ID, w.projectID, item.Name, item.NameKey, item.CreatedAt))
	if err != nil {
		return model.Tag{}, pg.QueryError("insert tag", err)
	}
	return result, nil
}

func (w *writer) UpdateTag(ctx context.Context, id string, version int64, name, nameKey string, observed time.Time) (model.Tag, error) {
	item, err := scan(w.tx.QueryRow(ctx, `UPDATE project_tags SET name=$4,name_key=$5,version=version+1,updated_at=$6
		WHERE project_id=$1 AND id=$2 AND version=$3 RETURNING `+projection, w.projectID, id, version, name, nameKey, observed))
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Tag{}, store.ErrTagWriteConflict
	}
	if err != nil {
		return model.Tag{}, pg.QueryError("update tag", err)
	}
	return item, nil
}

func (w *writer) DeleteTag(ctx context.Context, id string, version int64) error {
	result, err := w.tx.Exec(ctx, `DELETE FROM project_tags WHERE project_id=$1 AND id=$2 AND version=$3`, w.projectID, id, version)
	if err != nil {
		return pg.QueryError("delete tag", err)
	}
	if result.RowsAffected() != 1 {
		return store.ErrTagWriteConflict
	}
	return nil
}
