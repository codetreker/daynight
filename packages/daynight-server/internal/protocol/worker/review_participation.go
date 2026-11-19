package worker

import (
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type ReviewParticipation struct {
	Enabled bool   `json:"enabled"`
	Version string `json:"version"`
}

func ProjectReviewParticipation(value model.WorkerReviewParticipation) ReviewParticipation {
	return ReviewParticipation{Enabled: value.Enabled, Version: strconv.FormatInt(value.Version, 10)}
}
