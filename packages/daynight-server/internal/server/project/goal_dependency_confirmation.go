package project

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const goalDependencyRemovalHeader = "Daynight-Confirm-Goal-Dependency-Removal"

func goalDependencyRemovalConfirmation(header http.Header) (bool, error) {
	values := header.Values(goalDependencyRemovalHeader)
	if len(values) == 0 {
		return false, nil
	}
	if len(values) != 1 || values[0] != "true" {
		return false, httpx.InvalidInput("Daynight-Confirm-Goal-Dependency-Removal must be exactly true.")
	}
	return true, nil
}
