package worker

import (
	"context"
	"errors"
	"math"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func ReviewParticipationVersion(value string) (int64, error) {
	version, err := strconv.ParseInt(value, 10, 64)
	if err != nil || version < 1 || strconv.FormatInt(version, 10) != value {
		return 0, invalidInput("Worker review participation expectedVersion must be a positive decimal int64 string.")
	}
	return version, nil
}

func ReadReviewParticipation(ctx context.Context, dao store.WorkerReviewParticipationReader, principal model.Principal, workerID string) (model.WorkerReviewParticipation, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.WorkerReviewParticipation{}, err
	}
	id, err := model.CanonicalID(workerID)
	if err != nil {
		return model.WorkerReviewParticipation{}, err
	}
	value, err := dao.WorkerReviewParticipation(ctx, principal.UserID, id)
	if errors.Is(err, model.ErrNotFound) {
		return model.WorkerReviewParticipation{}, &model.Fault{Code: "not_found", Message: "Worker was not found.", Cause: err}
	}
	return value, err
}

func PutReviewParticipation(ctx context.Context, dao store.WorkerReviewParticipationWriter, principal model.Principal, workerID string, expected int64, enabled bool) (model.WorkerReviewParticipation, error) {
	current, err := ReadReviewParticipation(ctx, dao, principal, workerID)
	if err != nil {
		return model.WorkerReviewParticipation{}, err
	}
	if expected != current.Version {
		return model.WorkerReviewParticipation{}, &model.Fault{Code: "version_conflict", Message: "Worker review participation has changed."}
	}
	next := model.WorkerReviewParticipation{Enabled: enabled, Version: current.Version}
	if current.Enabled != enabled {
		if next.Version == math.MaxInt64 {
			return model.WorkerReviewParticipation{}, &model.Fault{Code: "version_conflict", Message: "Worker review participation version is exhausted."}
		}
		next.Version++
	}
	id, _ := model.CanonicalID(workerID)
	if err := dao.SetWorkerReviewParticipation(ctx, principal.UserID, id, expected, next); err != nil {
		return model.WorkerReviewParticipation{}, err
	}
	return next, nil
}
