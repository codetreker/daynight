package service

import (
	"errors"
	"log/slog"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/reviewassignment"
)

func (a *App) assembleReviewAssignment(database store.Transactions, logger *slog.Logger) error {
	db, ok := database.(store.ReviewAssignmentStore)
	if !ok {
		return errors.New("review assignment store unavailable")
	}
	a.reviewAssignment = reviewassignment.NewRunner(reviewassignment.New(db, logger))
	return nil
}
