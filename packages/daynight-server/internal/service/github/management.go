package github

import (
	"context"
	"errors"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

type managementRemote interface {
	DiscoverInstallation(context.Context, string, string) (githubpr.InstallationObservation, error)
	VerifyAccess(context.Context, int64, string, string) (githubpr.RepositoryObservation, error)
	ResolveRepository(context.Context, int64, int64) (githubpr.RepositoryObservation, error)
	FindInstallationByRepository(context.Context, int64) (githubpr.InstallationObservation, error)
}

// ManagementError exposes safe classification while retaining the original cause.
type ManagementError struct {
	Code, Message string
	Cause         error
}

func (e *ManagementError) Error() string { return e.Message }
func (e *ManagementError) Unwrap() error { return e.Cause }

type repositoryProof struct{ remote managementRemote }

func remoteError(err error) error {
	if err == nil {
		return nil
	}
	code := "github_unavailable"
	message := "GitHub is temporarily unavailable."
	var r *remote.Error
	if !errors.Is(err, remote.ErrInstallationScanIncomplete) && errors.As(err, &r) {
		switch r.Code {
		case "not_found", "installation_missing":
			code = "github_installation_missing"
			message = "GitHub installation was not found."
		case "permission_denied", "unauthorized":
			code = "github_permission_denied"
			message = "GitHub installation cannot read this repository."
		case "rate_limited":
			code = "github_rate_limited"
			message = "GitHub rate limit reached."
		}
	}
	return &ManagementError{Code: code, Message: message, Cause: err}
}

type managementSnapshot struct {
	project    model.Project
	connection githubpr.Connection
}

func (m *repositoryProof) proof(ctx context.Context, owner, name string) (core.InstallationCandidate, error) {
	var out core.InstallationCandidate
	var err error
	out.Installation, err = m.remote.DiscoverInstallation(ctx, owner, name)
	if err != nil {
		return out, remoteError(err)
	}
	out.Repository, err = m.remote.VerifyAccess(ctx, out.Installation.ID, owner, name)
	if err != nil {
		return out, remoteError(err)
	}
	return out, nil
}

// proofBound resolves the retained repository identity within the selected
// installation before verifying PR access and reading the account display name.
func (m *repositoryProof) proofBound(ctx context.Context, installationID, repositoryID int64) (core.InstallationCandidate, error) {
	var out core.InstallationCandidate
	repo, err := m.remote.ResolveRepository(ctx, installationID, repositoryID)
	if err != nil {
		return out, remoteError(err)
	}
	if repo.ID != repositoryID {
		return out, &model.Fault{Code: "github_repository_mismatch", Message: "GitHub repository does not match retained data."}
	}
	owner, name, err := core.RepositoryParts(repo.FullName)
	if err != nil {
		return out, remoteError(err)
	}
	out.Repository, err = m.remote.VerifyAccess(ctx, installationID, owner, name)
	if err != nil {
		return out, remoteError(err)
	}
	if out.Repository.ID != repositoryID {
		return core.InstallationCandidate{}, &model.Fault{Code: "github_repository_mismatch", Message: "GitHub repository does not match retained data."}
	}
	out.Installation, err = m.remote.DiscoverInstallation(ctx, owner, name)
	if err != nil {
		return core.InstallationCandidate{}, remoteError(err)
	}
	if out.Installation.ID != installationID {
		return core.InstallationCandidate{}, &ManagementError{Code: "github_permission_denied", Message: "Installation does not provide access to this repository."}
	}
	return out, nil
}
func (m *repositoryProof) discoverSnapshot(ctx context.Context, snap managementSnapshot) (core.InstallationCandidate, error) {
	owner, name, err := core.ProjectRepository(snap.project.RepoURL)
	if err != nil {
		return core.InstallationCandidate{}, err
	}
	if snap.connection.RepositoryID == nil {
		return m.proof(ctx, owner, name)
	}
	// A persisted canonical name can survive a stale Project URL and can locate
	// an installation under a replacement App. The stable ID is authoritative.
	paths := [][2]string{}
	if snap.connection.RepositoryFullName != nil {
		savedOwner, savedName, e := core.RepositoryParts(*snap.connection.RepositoryFullName)
		if e == nil {
			paths = append(paths, [2]string{savedOwner, savedName})
		}
	}
	if len(paths) == 0 || paths[0] != [2]string{owner, name} {
		paths = append(paths, [2]string{owner, name})
	}
	var lastErr error
	for _, path := range paths {
		candidate, e := m.proof(ctx, path[0], path[1])
		if e == nil {
			if candidate.Repository.ID == *snap.connection.RepositoryID {
				return candidate, nil
			}
			lastErr = &model.Fault{Code: "github_repository_mismatch", Message: "GitHub repository does not match retained data."}
			continue
		}
		var failure *ManagementError
		if !errors.As(e, &failure) || (failure.Code != "github_installation_missing" && failure.Code != "github_permission_denied") {
			return core.InstallationCandidate{}, e
		}
		lastErr = e
	}
	if snap.connection.InstallationID != nil {
		candidate, e := m.proofBound(ctx, *snap.connection.InstallationID, *snap.connection.RepositoryID)
		if e == nil {
			return candidate, nil
		}
		var failure *ManagementError
		var fault *model.Fault
		if !(errors.As(e, &failure) && (failure.Code == "github_installation_missing" || failure.Code == "github_permission_denied")) &&
			!(errors.As(e, &fault) && fault.Code == "github_repository_mismatch") {
			return core.InstallationCandidate{}, e
		}
	}
	installation, err := m.remote.FindInstallationByRepository(ctx, *snap.connection.RepositoryID)
	if err != nil {
		var mismatch *model.Fault
		if !errors.Is(err, remote.ErrInstallationScanIncomplete) && errors.As(lastErr, &mismatch) && mismatch.Code == "github_repository_mismatch" {
			var upstream *remote.Error
			if errors.As(err, &upstream) && upstream.Code == "not_found" {
				return core.InstallationCandidate{}, mismatch
			}
		}
		return core.InstallationCandidate{}, remoteError(err)
	}
	return m.proofBound(ctx, installation.ID, *snap.connection.RepositoryID)
}
