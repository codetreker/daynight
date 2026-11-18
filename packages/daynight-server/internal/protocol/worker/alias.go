package worker

import (
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type Alias struct {
	Value   *string `json:"value"`
	Version string  `json:"version"`
}

type AliasResource struct {
	WorkerID string `json:"workerId"`
	Alias    Alias  `json:"alias"`
}

func ProjectAlias(value model.WorkerAlias) *Alias {
	return &Alias{Value: value.Value, Version: strconv.FormatInt(value.Version, 10)}
}
