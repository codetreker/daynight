package project

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"

// RepositoryMatch collects visible Projects from one snapshot in page order.
type RepositoryMatch struct {
	identity string
	match    *model.Project
}

func NewRepositoryMatch(address string) (*RepositoryMatch, error) {
	if err := validateRepoURLSize(address); err != nil {
		return nil, err
	}
	identity, err := RepositoryIdentity(address)
	if err != nil {
		return nil, err
	}
	return &RepositoryMatch{identity: identity}, nil
}

// Add rejects ambiguity as soon as the second equivalent Project is observed.
func (m *RepositoryMatch) Add(candidate model.Project) error {
	identity, err := RepositoryIdentity(candidate.RepoURL)
	if err != nil {
		return err
	}
	if identity != m.identity {
		return nil
	}
	if m.match != nil {
		return &model.Fault{Code: "resource_conflict", Message: "Multiple accessible Projects match this repository."}
	}
	m.match = &candidate
	return nil
}

// Result returns the unique match collected so far, if any.
func (m *RepositoryMatch) Result() (model.Project, bool) {
	if m.match != nil {
		return *m.match, true
	}
	return model.Project{}, false
}

// RequireRepositoryCreationConfirmation guards creation when no match exists.
func RequireRepositoryCreationConfirmation(confirm bool) error {
	if !confirm {
		return &model.Fault{Code: "invalid_input", Message: "Project creation requires confirmation."}
	}
	return nil
}
