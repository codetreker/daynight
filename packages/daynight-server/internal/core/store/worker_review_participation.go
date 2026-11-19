package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type WorkerReviewParticipationReader interface {
	WorkerReviewParticipation(context.Context, string, string) (model.WorkerReviewParticipation, error)
}

type WorkerReviewParticipationWriter interface {
	WorkerReviewParticipationReader
	// SetWorkerReviewParticipation compares the observed version even for an unchanged value.
	SetWorkerReviewParticipation(context.Context, string, string, int64, model.WorkerReviewParticipation) error
}
