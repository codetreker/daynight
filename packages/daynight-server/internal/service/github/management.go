package github

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	project "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

type managementStore interface {
	store.SnapshotReader
	store.ProjectWriter
}
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

type Manager struct {
	db     managementStore
	remote managementRemote
	appID  int64
	logger *slog.Logger
}

func NewManager(db managementStore, r managementRemote, appID int64, loggers ...*slog.Logger) *Manager {
	logger := slog.Default()
	if len(loggers) > 0 && loggers[0] != nil {
		logger = loggers[0]
	}
	return &Manager{db: db, remote: r, appID: appID, logger: logger}
}
func (m *Manager) available() bool { return m.appID > 0 && m.remote != nil }
func (m *Manager) ready() error {
	if !m.available() {
		return &ManagementError{Code: "github_not_configured", Message: "GitHub integration is not configured."}
	}
	return nil
}
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

func (m *Manager) snapshot(ctx context.Context, p model.Principal, id string) (managementSnapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	var out managementSnapshot
	var refusal *model.Fault
	err := m.db.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
		return completion.Capture(func() error {
			access, e := project.RequireProjectRead(ctx, s.ProjectDAO(), p, id)
			if e != nil {
				return e
			}
			if e = project.RequireProjectAdmin(access); e != nil {
				return e
			}
			out.project, e = s.ProjectDAO().Project(ctx, id)
			if e != nil {
				return project.LookupError(e)
			}
			out.connection, e = s.GitHubDAO().Connection(ctx, id)
			return e
		}, &refusal)
	})
	if err != nil {
		return out, err
	}
	if refusal != nil {
		return out, refusal
	}
	return out, nil
}
func (m *Manager) proof(ctx context.Context, owner, name string) (core.InstallationCandidate, error) {
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
func (m *Manager) proofBound(ctx context.Context, installationID, repositoryID int64) (core.InstallationCandidate, error) {
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
func (m *Manager) Discover(ctx context.Context, p model.Principal, id string) (core.InstallationCandidate, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	id, err := project.ValidateRead(p, id)
	if err != nil {
		return core.InstallationCandidate{}, err
	}
	snap, err := m.snapshot(ctx, p, id)
	if err != nil {
		return core.InstallationCandidate{}, err
	}
	if err = m.ready(); err != nil {
		return core.InstallationCandidate{}, err
	}
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
func (m *Manager) Connect(ctx context.Context, p model.Principal, id string, version, installationID int64) (core.Status, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	id, err := project.ValidateRead(p, id)
	if err != nil {
		return core.Status{}, err
	}
	if version < 1 || installationID < 1 {
		return core.Status{}, &model.Fault{Code: "invalid_input", Message: "Version and installation ID must be positive."}
	}
	snap, err := m.snapshot(ctx, p, id)
	if err != nil {
		return core.Status{}, err
	}
	if snap.connection.Version != version {
		return core.Status{}, &model.Fault{Code: "version_conflict", Message: "GitHub configuration version does not match."}
	}
	if err = m.ready(); err != nil {
		return core.Status{}, err
	}
	owner, name, err := core.ProjectRepository(snap.project.RepoURL)
	if err != nil {
		return core.Status{}, err
	}
	var candidate core.InstallationCandidate
	if snap.connection.RepositoryID != nil {
		candidate, err = m.proofBound(ctx, installationID, *snap.connection.RepositoryID)
	} else {
		candidate, err = m.proof(ctx, owner, name)
	}
	if err != nil {
		return core.Status{}, err
	}
	if candidate.Installation.ID != installationID {
		return core.Status{}, &ManagementError{Code: "github_permission_denied", Message: "Installation does not provide access to this repository."}
	}
	return m.write(ctx, p, id, version, "connect", 0, snap.project.RepoURL, candidate)
}
func (m *Manager) Disconnect(ctx context.Context, p model.Principal, id string, version int64) (core.Status, error) {
	return m.write(ctx, p, id, version, "disconnect", 0, "", core.InstallationCandidate{})
}
func (m *Manager) Settings(ctx context.Context, p model.Principal, id string, version int64, minutes int32) (core.Status, error) {
	return m.write(ctx, p, id, version, "settings", minutes, "", core.InstallationCandidate{})
}

// Sync changes only Project synchronization intent, without contacting GitHub.
func (m *Manager) Sync(ctx context.Context, p model.Principal, id string, version int64, enabled bool) (core.Status, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	id, err := project.ValidateRead(p, id)
	if err != nil {
		return core.Status{}, err
	}
	var out githubpr.Connection
	var refusal *model.Fault
	c, err := m.db.WriteProject(ctx, id, func(s store.ProjectWriteScope) error {
		return completion.Capture(func() error {
			var e error
			out, e = core.ManageSync(ctx, s, p, version, enabled, m.available(), m.appID)
			return e
		}, &refusal)
	})
	code := "ok"
	if c.Outcome == store.TransactionUnknown {
		code = "github_write_outcome_unknown"
	} else if err != nil || c.Outcome != store.TransactionCommitted {
		code = "github_unavailable"
	} else if refusal != nil {
		code = refusal.Code
	}
	m.logger.InfoContext(ctx, "github synchronization configuration", "component", "github_sync", "phase", "sync_config", "request_id", requestid.From(ctx), "user_id", p.UserID, "project_id", id, "sync_enabled", enabled, "version", out.Version, "generation", out.Generation, "result_code", code, "write_outcome", string(c.Outcome))
	if c.Outcome == store.TransactionUnknown {
		return core.Status{}, &ManagementError{Code: code, Message: "GitHub configuration write outcome is unknown; read the resource before deciding what to do.", Cause: err}
	}
	if err != nil {
		return core.Status{}, project.ProjectWriteError(err)
	}
	if c.Outcome != store.TransactionCommitted {
		return core.Status{}, fmt.Errorf("GitHub configuration transaction not committed")
	}
	if refusal != nil {
		switch refusal.Code {
		case "github_not_configured", "github_not_connected", "github_connection_unavailable":
			return core.Status{}, &ManagementError{Code: refusal.Code, Message: refusal.Message, Cause: refusal}
		default:
			return core.Status{}, refusal
		}
	}
	return core.Status{Connection: out, ServiceAvailable: m.available()}, nil
}
func (m *Manager) write(ctx context.Context, p model.Principal, id string, version int64, action string, minutes int32, repo string, candidate core.InstallationCandidate) (core.Status, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	id, err := project.ValidateRead(p, id)
	if err != nil {
		return core.Status{}, err
	}
	var out githubpr.Connection
	var refusal *model.Fault
	c, err := m.db.WriteProject(ctx, id, func(s store.ProjectWriteScope) error {
		return completion.Capture(func() error {
			var e error
			out, e = core.Manage(ctx, s, p, version, action, minutes, m.appID, repo, candidate)
			return e
		}, &refusal)
	})
	if c.Outcome == store.TransactionUnknown {
		return core.Status{}, &ManagementError{Code: "github_write_outcome_unknown", Message: "GitHub configuration write outcome is unknown; read the resource before deciding what to do.", Cause: err}
	}
	if err != nil {
		return core.Status{}, project.ProjectWriteError(err)
	}
	if c.Outcome != store.TransactionCommitted {
		return core.Status{}, fmt.Errorf("GitHub configuration transaction not committed")
	}
	if refusal != nil {
		return core.Status{}, refusal
	}
	return core.Status{Connection: out, ServiceAvailable: m.available()}, nil
}
