package assistanttask

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

// DAO borrows the transaction. Its caller owns admission and completion.
type DAO struct{ tx pgx.Tx }

func New(tx pgx.Tx) *DAO                                { return &DAO{tx: tx} }
func (d *DAO) AssistantTaskDAO() store.AssistantTaskDAO { return d }

var _ store.AssistantTaskScope = (*DAO)(nil)
var _ store.AssistantTaskDAO = (*DAO)(nil)

func (d *DAO) Credential(ctx context.Context, p model.Principal) error {
	if _, err := pg.ThreadCredential(ctx, d.tx, p, " FOR SHARE"); err != nil {
		return err
	}
	// Natural expiry can pass while the shared lock waits without changing the
	// row. Read again in a fresh statement under the acquired deletion barrier.
	_, err := pg.ThreadCredential(ctx, d.tx, p, "")
	return err
}

func (d *DAO) Bot(ctx context.Context, id string) (model.Bot, error) {
	var locked string
	if err := d.tx.QueryRow(ctx, `SELECT id::text FROM bots WHERE id=$1 FOR SHARE`, id).Scan(&locked); err != nil {
		return model.Bot{}, pg.QueryError("lock assistant Bot", err)
	}
	return botpg.NewReader(d.tx).Bot(ctx, id)
}

func (d *DAO) Now(ctx context.Context) (time.Time, error) {
	var now time.Time
	err := d.tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now)
	return now.UTC(), pg.AuthQueryError("observe assistant task time", err)
}

func (d *DAO) LockCreation(ctx context.Context, id string) error {
	_, err := d.tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('assistant-task-create:' || $1,0))`, id)
	return pg.AuthQueryError("lock assistant task creation", err)
}

func one[T any](row pgx.Row, phase string, scan func(pgx.Row) (T, error)) (T, error) {
	v, err := scan(row)
	if err != nil {
		var zero T
		return zero, pg.QueryError(phase, err)
	}
	return v, nil
}

func many[T any](ctx context.Context, tx pgx.Tx, phase, query string, scan func(pgx.Row) (T, error), args ...any) ([]T, error) {
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, pg.QueryError(phase, err)
	}
	defer rows.Close()
	items := make([]T, 0)
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return nil, pg.QueryError(phase, err)
		}
		v, err := scan(rows)
		if err != nil {
			return nil, pg.QueryError(phase, err)
		}
		items = append(items, v)
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError(phase, err)
	}
	return items, nil
}

func page(q store.AssistantTaskQuery) (any, any, int) {
	if q.After == nil {
		return nil, nil, q.Limit + 1
	}
	return q.After.CreatedAt, q.After.ID, q.Limit + 1
}

func (d *DAO) changed(ctx context.Context, phase, query string, args ...any) (bool, error) {
	tag, err := d.tx.Exec(ctx, query, args...)
	if err != nil {
		return false, pg.QueryError(phase, err)
	}
	return tag.RowsAffected() == 1, nil
}

func (d *DAO) execute(ctx context.Context, phase, query string, args ...any) error {
	_, err := d.tx.Exec(ctx, query, args...)
	return pg.AuthQueryError(phase, err)
}
