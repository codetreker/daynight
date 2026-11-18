package project

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	repositoryidentity "github.com/codetreker/daynight/packages/daynight-server/internal/core/repositoryidentity/v1"
)

// RepositoryIdentity uses the frozen v1 rules shared with persisted identities.
func RepositoryIdentity(input string) (string, error) {
	identity, err := repositoryidentity.RepositoryIdentity(input)
	if err != nil {
		return "", &model.Fault{Code: "invalid_input", Message: err.Error(), Cause: err}
	}
	return identity, nil
}
