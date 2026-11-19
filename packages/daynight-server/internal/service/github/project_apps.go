package github

import (
	"context"
	"log/slog"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	project "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
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
}

func NewProjectAppManager(db store.GitHubProjectAppStore, provider projectAppClientProvider, logger *slog.Logger) *ProjectAppManager {
	return &ProjectAppManager{db: db, provider: provider, logger: logger}
}

func (m *ProjectAppManager) read(ctx context.Context, p model.Principal, id string, work func(store.GitHubProjectAppReadDAO, store.GitHubProjectAppFacts) error) error {
	var refusal *model.Fault
	err := m.db.ReadGitHubProjectApp(ctx, id, func(dao store.GitHubProjectAppReadDAO) error {
		return completion.Capture(func() error {
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
	ctx, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	id, err := project.ValidateRead(p, id)
	if err != nil {
		return core.ProjectAppStatus{}, err
	}
	var out core.ProjectAppStatus
	err = m.read(ctx, p, id, func(dao store.GitHubProjectAppReadDAO, f store.GitHubProjectAppFacts) error {
		var e error
		out, e = core.ProjectAppStatusFrom(ctx, dao, f)
		return e
	})
	return out, err
}

func (m *ProjectAppManager) selected(ctx context.Context, p model.Principal, id string, in core.ProjectAppSelection) (store.GitHubProjectAppFacts, store.GitHubProjectApp, error) {
	var facts store.GitHubProjectAppFacts
	var app store.GitHubProjectApp
	err := m.read(ctx, p, id, func(dao store.GitHubProjectAppReadDAO, f store.GitHubProjectAppFacts) error {
		facts = f
		var e error
		app, e = core.SelectProjectApp(ctx, dao, f, in)
		return e
	})
	return facts, app, err
}

func (m *ProjectAppManager) Discover(ctx context.Context, p model.Principal, id string, in core.ProjectAppSelection) (core.InstallationCandidate, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	id, err := project.ValidateRead(p, id)
	if err != nil {
		return core.InstallationCandidate{}, err
	}
	if err = core.ValidateProjectAppSelection(in); err != nil {
		return core.InstallationCandidate{}, err
	}
	f, a, err := m.selected(ctx, p, id, in)
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
	current, _, err := m.selected(ctx, p, id, in)
	if err != nil {
		return core.InstallationCandidate{}, err
	}
	if current.Connection.Version != f.Connection.Version || current.Project.RepoURL != f.Project.RepoURL || current.RepositoryVersion != f.RepositoryVersion {
		return core.InstallationCandidate{}, &model.Fault{Code: "version_conflict", Message: "Project connection changed during discovery."}
	}
	return out, nil
}

func (m *ProjectAppManager) Connect(ctx context.Context, p model.Principal, id string, in core.ProjectAppConnect) (core.ProjectAppStatus, error) {
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
	f, a, err := m.selected(ctx, p, id, in.ProjectAppSelection)
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
	return m.write(ctx, p, id, "connect", in, 0, false, f.Project.RepoURL, candidate)
}

func (m *ProjectAppManager) Disconnect(ctx context.Context, p model.Principal, id string, in core.ProjectAppDisconnect) (core.ProjectAppStatus, error) {
	if in.OwnershipVersion < 1 {
		return core.ProjectAppStatus{}, &model.Fault{Code: "invalid_input", Message: "Ownership version must be positive."}
	}
	return m.write(ctx, p, id, "disconnect", core.ProjectAppConnect{Version: in.Version, ProjectAppSelection: core.ProjectAppSelection{OwnershipVersion: in.OwnershipVersion}}, 0, false, "", core.InstallationCandidate{})
}
func (m *ProjectAppManager) Settings(ctx context.Context, p model.Principal, id string, version int64, minutes int32) (core.ProjectAppStatus, error) {
	return m.write(ctx, p, id, "settings", core.ProjectAppConnect{Version: version}, minutes, false, "", core.InstallationCandidate{})
}
func (m *ProjectAppManager) Sync(ctx context.Context, p model.Principal, id string, version int64, enabled bool) (core.ProjectAppStatus, error) {
	return m.write(ctx, p, id, "sync", core.ProjectAppConnect{Version: version}, 0, enabled, "", core.InstallationCandidate{})
}
func (m *ProjectAppManager) write(ctx context.Context, p model.Principal, id, action string, in core.ProjectAppConnect, minutes int32, enabled bool, repo string, candidate core.InstallationCandidate) (core.ProjectAppStatus, error) {
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
		out, e = core.ManageProjectApp(ctx, &observedProjectAppDAO{GitHubProjectAppWriteDAO: dao, observation: observation}, p, action, in, minutes, enabled, repo, candidate)
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
