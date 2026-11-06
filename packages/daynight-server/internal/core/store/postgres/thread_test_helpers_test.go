package postgres

import (
	"context"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func threadPositionAfter(candidate, head model.ThreadPosition) bool {
	return candidate.CreatedAt.After(head.CreatedAt) ||
		(candidate.CreatedAt.Equal(head.CreatedAt) && strings.Compare(candidate.ID, head.ID) > 0)
}

func waitThreadClock(ctx context.Context) error {
	timer := time.NewTimer(time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
