package postgres

import (
	"context"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"time"
)

func (s *Snapshot) ObservedAt(ctx context.Context) (time.Time, error) {
	var observed time.Time
	if err := s.tx.QueryRow(ctx, "SELECT statement_timestamp()").Scan(&observed); err != nil {
		return time.Time{}, pg.QueryError("read snapshot clock", err)
	}
	return observed.UTC(), nil
}
