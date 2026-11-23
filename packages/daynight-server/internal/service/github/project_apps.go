package github

import (
	"context"
	"log/slog"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	project "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
)

type projectAppClientProvider interface {
	Acquire(context.Context, string, int64) (*remote.Client, func(), error)
}

// ProjectAppManager composes current Team usage authorization, remote repository
// proof and the dedicated Project/App transaction.
type ProjectAppManager struct {
	db       store.GitHubProjectAppStore
	provider projectAppClientProvider
	logger   *slog.Logger
	current  AuthorizationReader
}

func NewProjectAppManager(db store.GitHubProjectAppStore, provider projectAppClientProvider, logger *slog.Logger) *ProjectAppManager {
	return &ProjectAppManager{db: db, provider: provider, logger: logger}
}

// NewScopedProjectAppManager supplies current credential authorization for work
// resumed after remote proof. Ordinary assembly continues to use the original constructor.
func NewScopedProjectAppManager(db store.GitHubProjectAppStore, provider projectAppClientProvider, logger *slog.Logger, current AuthorizationReader) *ProjectAppManager {
	return &ProjectAppManager{db: db, provider: provider, logger: logger, current: current}
}

func (m *ProjectAppManager) read(ctx context.Context, p model.Principal, id string, admit func() error, work func(store.GitHubProjectAppReadDAO, store.GitHubProjectAppFacts) error) error {
	var refusal *model.Fault
	err := m.db.ReadGitHubProjectApp(ctx, id, func(dao store.GitHubProjectAppReadDAO) error {
		return completion.Capture(func() error {
			if admit != nil {
				if _, err := core.ProjectAppAccess(ctx, dao, p); err != nil {
					return err
				}
				if err := admit(); err != nil {
					return err
				}
			}
			f, e := core.ReadProjectAppFacts(ctx, dao, p)
			if e != nil {
				return e
			}
			return work(dao, f)
		}, &refusal)
	})
	if err != nil {
		return err
	}
	if refusal != nil {
		return refusal
	}
	return nil
}

func (m *ProjectAppManager) Get(ctx context.Context, p model.Principal, id string) (core.ProjectAppStatus, error) {
	return m.get(ctx, p, id, nil)
}

func (m *ProjectAppManager) GetAuthorized(ctx context.Context, auth model.CredentialAuthorization, id string) (core.ProjectAppStatus, error) {
	if err := auth.Validate(); err != nil {
		return core.ProjectAppStatus{}, err
	}
	return m.get(ctx, auth.Principal, id, func() error { return scopeadmission.Require(auth, scopepolicy.GithubRead) })
}

func (m *ProjectAppManager) get(ctx context.Context, p model.Principal, id string, admit func() error) (core.ProjectAppStatus, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	id, err := project.ValidateRead(p, id)
	if err != nil {
		return core.ProjectAppStatus{}, err
	}
	var out core.ProjectAppStatus
	err = m.read(ctx, p, id, admit, func(dao store.GitHubProjectAppReadDAO, f store.GitHubProjectAppFacts) error {
		var e error
		out, e = core.ProjectAppStatusFrom(ctx, dao, f)
		return e
	})
	return out, err
}

func (m *ProjectAppManager) selected(ctx context.Context, p model.Principal, id string, in core.ProjectAppSelection, admit func() error) (store.GitHubProjectAppFacts, store.GitHubProjectApp, error) {
	var facts store.GitHubProjectAppFacts
	var app store.GitHubProjectApp
	var refusal *model.Fault
	err := m.db.ReadGitHubProjectApp(ctx, id, func(dao store.GitHubProjectAppReadDAO) error {
		return completion.Capture(func() error {
			if admit != nil {
				access, e := core.ProjectAppAccess(ctx, dao, p)
				if e != nil {
					return e
				}
				if e = core.RequireSelectedProjectApp(ctx, dao, access, in); e != nil {
					return e
				}
				if e = admit(); e != nil {
					return e
				}
			}
			var e error
			facts, e = core.ReadProjectAppFacts(ctx, dao, p)
			if e != nil {
				return e
			}
			app, e = core.SelectProjectApp(ctx, dao, facts, in)
			return e
		}, &refusal)
	})
	if err == nil && refusal != nil {
		err = refusal
	}
	return facts, app, err
}

func (m *ProjectAppManager) Discover(ctx context.Context, p model.Principal, id string, in core.ProjectAppSelection) (core.InstallationCandidate, error) {
	return m.discover(ctx, p, id, in, nil, nil)
}

func (m *ProjectAppManager) DiscoverAuthorized(ctx context.Context, auth model.CredentialAuthorization, id string, in core.ProjectAppSelection) (core.InstallationCandidate, error) {
	if err := auth.Validate(); err != nil {
		return core.InstallationCandidate{}, err
	}
	return m.discover(ctx, auth.Principal, id, in, func() error { return scopeadmission.Require(auth, scopepolicy.GithubRead) }, func(ctx context.Context) error { return currentAdmission(ctx, m.current, auth, scopepolicy.GithubRead) })
}

func (m *ProjectAppManager) discover(ctx context.Context, p model.Principal, id string, in core.ProjectAppSelection, admit func() error, afterProof func(context.Context) error) (core.InstallationCandidate, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	id, err := project.ValidateRead(p, id)
	if err != nil {
		return core.InstallationCandidate{}, err
	}
	if err = core.ValidateProjectAppSelection(in); err != nil {
		return core.InstallationCandidate{}, err
	}
	f, a, err := m.selected(ctx, p, id, in, admit)
	if err != nil {
		return core.InstallationCandidate{}, err
	}
	client, release, err := m.provider.Acquire(ctx, a.ID, a.CredentialVersion)
	if err != nil {
		return core.InstallationCandidate{}, err
	}
	defer release()
	proof := &repositoryProof{remote: client}
	// The shared discovery mechanism follows a retained numeric repository ID,
	// including renamed repositories and replacement App installations.
	out, err := proof.discoverSnapshot(ctx, managementSnapshot{project: f.Project, connection: f.Connection})
	if err != nil {
		return core.InstallationCandidate{}, err
	}
	postProof := admit
	if afterProof != nil {
		postProof = func() error { return afterProof(ctx) }
	}
	current, _, err := m.selected(ctx, p, id, in, postProof)
	if err != nil {
		return core.InstallationCandidate{}, err
	}
	if current.Connection.Version != f.Connection.Version || current.Project.RepoURL != f.Project.RepoURL || current.RepositoryVersion != f.RepositoryVersion {
		return core.InstallationCandidate{}, &model.Fault{Code: "version_conflict", Message: "Project connection changed during discovery."}
	}
	return out, nil
}

func (m *ProjectAppManager) Connect(ctx context.Context, p model.Principal, id string, in core.ProjectAppConnect) (core.ProjectAppStatus, error) {
	return m.connect(ctx, p, id, in, nil, nil)
}

func (m *ProjectAppManager) ConnectAuthorized(ctx context.Context, auth model.CredentialAuthorization, id string, in core.ProjectAppConnect) (core.ProjectAppStatus, error) {
	if err := auth.Validate(); err != nil {
		return core.ProjectAppStatus{}, err
	}
	return m.connect(ctx, auth.Principal, id, in, func() error { return scopeadmission.Require(auth, scopepolicy.GithubRead, scopepolicy.GithubManage) }, func(ctx context.Context) error {
		return currentAdmission(ctx, m.current, auth, scopepolicy.GithubRead, scopepolicy.GithubManage)
	})
}

func (m *ProjectAppManager) connect(ctx context.Context, p model.Principal, id string, in core.ProjectAppConnect, admit func() error, afterProof func(context.Context) error) (core.ProjectAppStatus, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	id, err := project.ValidateRead(p, id)
	if err != nil {
		return core.ProjectAppStatus{}, err
	}
	if err = core.ValidateProjectAppSelection(in.ProjectAppSelection); err != nil {
		return core.ProjectAppStatus{}, err
	}
	if in.Version < 1 || in.InstallationID < 1 {
		return core.ProjectAppStatus{}, &model.Fault{Code: "invalid_input", Message: "Version and installation ID must be positive."}
	}
	f, a, err := m.selected(ctx, p, id, in.ProjectAppSelection, admit)
	if err != nil {
		return core.ProjectAppStatus{}, err
	}
	if f.Connection.Version != in.Version {
		return core.ProjectAppStatus{}, &model.Fault{Code: "version_conflict", Message: "GitHub configuration version changed."}
	}
	client, release, err := m.provider.Acquire(ctx, a.ID, a.CredentialVersion)
	if err != nil {
		return core.ProjectAppStatus{}, err
	}
	defer release()
	proof := &repositoryProof{remote: client}
	var candidate core.InstallationCandidate
	if f.Connection.RepositoryID != nil {
		candidate, err = proof.proofBound(ctx, in.InstallationID, *f.Connection.RepositoryID)
	} else {
		owner, name, e := core.ProjectRepository(f.Project.RepoURL)
		if e != nil {
			return core.ProjectAppStatus{}, e
		}
		candidate, err = proof.proof(ctx, owner, name)
	}
	if err != nil {
		return core.ProjectAppStatus{}, err
	}
	in.RepositoryVersion = f.RepositoryVersion
	postProof := admit
	if afterProof != nil {
		postProof = func() error { return afterProof(ctx) }
	}
	return m.write(ctx, p, id, "connect", in, 0, false, f.Project.RepoURL, candidate, postProof)
}

func (m *ProjectAppManager) Disconnect(ctx context.Context, p model.Principal, id string, in core.ProjectAppDisconnect) (core.ProjectAppStatus, error) {
	return m.disconnect(ctx, p, id, in, nil)
}

func (m *ProjectAppManager) DisconnectAuthorized(ctx context.Context, auth model.CredentialAuthorization, id string, in core.ProjectAppDisconnect) (core.ProjectAppStatus, error) {
	if err := auth.Validate(); err != nil {
		return core.ProjectAppStatus{}, err
	}
	return m.disconnect(ctx, auth.Principal, id, in, func() error { return scopeadmission.Require(auth, scopepolicy.GithubRead, scopepolicy.GithubManage) })
}

func (m *ProjectAppManager) disconnect(ctx context.Context, p model.Principal, id string, in core.ProjectAppDisconnect, admit func() error) (core.ProjectAppStatus, error) {
	if in.OwnershipVersion < 1 {
		return core.ProjectAppStatus{}, &model.Fault{Code: "invalid_input", Message: "Ownership version must be positive."}
	}
	return m.write(ctx, p, id, "disconnect", core.ProjectAppConnect{Version: in.Version, ProjectAppSelection: core.ProjectAppSelection{OwnershipVersion: in.OwnershipVersion}}, 0, false, "", core.InstallationCandidate{}, admit)
}
func (m *ProjectAppManager) Settings(ctx context.Context, p model.Principal, id string, version int64, minutes int32) (core.ProjectAppStatus, error) {
	return m.settings(ctx, p, id, version, minutes, nil)
}

func (m *ProjectAppManager) SettingsAuthorized(ctx context.Context, auth model.CredentialAuthorization, id string, version int64, minutes int32) (core.ProjectAppStatus, error) {
	if err := auth.Validate(); err != nil {
		return core.ProjectAppStatus{}, err
	}
	return m.settings(ctx, auth.Principal, id, version, minutes, func() error { return scopeadmission.Require(auth, scopepolicy.GithubRead, scopepolicy.GithubManage) })
}

func (m *ProjectAppManager) settings(ctx context.Context, p model.Principal, id string, version int64, minutes int32, admit func() error) (core.ProjectAppStatus, error) {
	return m.write(ctx, p, id, "settings", core.ProjectAppConnect{Version: version}, minutes, false, "", core.InstallationCandidate{}, admit)
}
func (m *ProjectAppManager) Sync(ctx context.Context, p model.Principal, id string, version int64, enabled bool) (core.ProjectAppStatus, error) {
	return m.sync(ctx, p, id, version, enabled, nil)
}

func (m *ProjectAppManager) SyncAuthorized(ctx context.Context, auth model.CredentialAuthorization, id string, version int64, enabled bool) (core.ProjectAppStatus, error) {
	if err := auth.Validate(); err != nil {
		return core.ProjectAppStatus{}, err
	}
	return m.sync(ctx, auth.Principal, id, version, enabled, func() error { return scopeadmission.Require(auth, scopepolicy.GithubRead, scopepolicy.GithubManage) })
}

func (m *ProjectAppManager) sync(ctx context.Context, p model.Principal, id string, version int64, enabled bool, admit func() error) (core.ProjectAppStatus, error) {
	return m.write(ctx, p, id, "sync", core.ProjectAppConnect{Version: version}, 0, enabled, "", core.InstallationCandidate{}, admit)
}
func (m *ProjectAppManager) write(ctx context.Context, p model.Principal, id, action string, in core.ProjectAppConnect, minutes int32, enabled bool, repo string, candidate core.InstallationCandidate, admit func() error) (core.ProjectAppStatus, error) {
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	id, err := project.ValidateRead(p, id)
	if err != nil {
		return core.ProjectAppStatus{}, err
	}
	var out core.ProjectAppStatus
	observation := &projectAppObservation{}
	var callbackSucceeded bool
	c, err := m.db.WriteGitHubProjectApp(ctx, id, p.UserID, in.AppResourceID, func(dao store.GitHubProjectAppWriteDAO) error {
		var e error
		out, e = core.ManageProjectAppWithAdmission(ctx, &observedProjectAppDAO{GitHubProjectAppWriteDAO: dao, observation: observation}, p, action, in, minutes, enabled, repo, candidate, admit)
		callbackSucceeded = e == nil
		return e
	})
	err = grantCompletion(c, err)
	m.logProjectAppWrite(ctx, p, id, action, c, err, observation, out, callbackSucceeded)
	if err != nil {
		return core.ProjectAppStatus{}, err
	}
	return out, nil
}
