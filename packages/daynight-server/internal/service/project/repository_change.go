package project

import (
	"context"
	"errors"
	"log/slog"
	"math"
	"reflect"
	"time"

	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/internal/completion"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

type RepositoryObserver interface {
	ObserveRepository(context.Context, store.GitHubProjectAppFacts, *store.GitHubProjectApp, string) core.RepositoryEvidence
}

func (s *AppProjects) SetRepositoryObserver(observer RepositoryObserver) {
	s.repositoryObserver = observer
}

// SetRepositoryLogger configures diagnostics before repository operations start.
func (s *AppProjects) SetRepositoryLogger(logger *slog.Logger) {
	if logger == nil {
		logger = slog.Default()
	}
	s.repositoryLogger = logger
}

func (s *AppProjects) logRepository(ctx context.Context, principal model.Principal, id, phase, classification string, outcome store.TransactionOutcome, count int, countKnown bool) {
	logger := s.repositoryLogger
	if logger == nil {
		logger = slog.Default()
	}
	args := []any{"component", "project_repository", "project_id", id, "user_id", principal.UserID, "request_id", requestid.From(ctx), "phase", phase}
	if classification != "" {
		args = append(args, "classification", classification)
	}
	if outcome != "" {
		args = append(args, "commit_outcome", outcome)
		switch outcome {
		case store.TransactionCommitted:
			if countKnown {
				args = append(args, "affected_worker_configuration_rows", count)
			}
		case store.TransactionNotCommitted:
			args = append(args, "affected_worker_configuration_rows", 0)
		case store.TransactionUnknown:
			if countKnown {
				args = append(args, "provisional_worker_configuration_rows", count)
			}
		}
	}
	logger.InfoContext(ctx, "Project repository operation", args...)
}

type repositorySnapshot struct {
	project store.ProjectRepositoryFacts
	github  store.GitHubProjectAppFacts
	app     *store.GitHubProjectApp
}

func repositoryFacts(ctx context.Context, p model.Principal, project store.ProjectRepositoryReadDAO, github store.GitHubProjectAppReadDAO) (repositorySnapshot, error) {
	var out repositorySnapshot
	var err error
	out.project, err = project.RepositoryFacts(ctx, p)
	if err != nil {
		return out, core.LookupError(err)
	}
	if out.project.Version < 1 {
		return out, errors.New("invalid stored repository version")
	}
	if err = core.RequireProjectAdmin(out.project.Access); err != nil {
		return out, err
	}
	out.github, err = github.Facts(ctx, p)
	if err != nil {
		return out, err
	}
	if out.github.AppResourceID != nil && out.github.GrantID != nil {
		a, e := github.App(ctx, *out.github.AppResourceID, *out.github.GrantID, out.project.Project.Ownership.TeamID)
		if e == nil {
			out.app = &a
		} else if !errors.Is(e, model.ErrNotFound) {
			return out, e
		}
	}
	return out, nil
}
func (s *AppProjects) repositorySnapshot(ctx context.Context, p model.Principal, id string) (repositorySnapshot, error) {
	var out repositorySnapshot
	var refusal *model.Fault
	err := s.repositoryStore.ReadProjectRepository(ctx, id, func(scope store.ProjectRepositoryReadScope) error {
		return completion.Capture(func() error {
			var e error
			out, e = repositoryFacts(ctx, p, scope.ProjectRepositoryDAO(), scope.GitHubAppDAO())
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
func repositoryIdentity(f store.ProjectRepositoryFacts) string {
	if f.Identity == nil {
		return ""
	}
	return *f.Identity
}
func (s *AppProjects) previewRepository(ctx context.Context, p model.Principal, id, address, identity string) (core.RepositoryPreview, repositorySnapshot, core.RepositoryEvidence, error) {
	f, err := s.repositorySnapshot(ctx, p, id)
	if err != nil {
		return core.RepositoryPreview{}, f, core.RepositoryEvidence{}, err
	}
	e := core.RepositoryEvidence{OldID: f.github.Connection.RepositoryID, UnverifiedReason: "no_github_access"}
	if address != f.project.Project.RepoURL && s.repositoryObserver != nil {
		e = s.repositoryObserver.ObserveRepository(ctx, f.github, f.app, address)
		if err := ctx.Err(); err != nil {
			return core.RepositoryPreview{}, f, e, err
		}
	}
	classification, target, reason := core.ClassifyRepository(f.project.Project.RepoURL, address, repositoryIdentity(f.project), identity, e)
	return core.RepositoryPreview{ProjectID: id, ProjectName: f.project.Project.Name, CurrentRepoURL: f.project.Project.RepoURL, RepoURL: address, RepositoryVersion: f.project.Version, OwnershipVersion: f.project.Project.Ownership.Version, Classification: classification, TargetGitHubRepositoryID: target, UnverifiedReason: reason, BindingsInvalidated: classification == "different_repository" || classification == "unverified"}, f, e, nil
}
func (s *AppProjects) RepositoryPreview(ctx context.Context, p model.Principal, id, address, expectedUser string) (core.RepositoryPreview, error) {
	id, identity, err := core.ValidateRepositoryChange(p, id, address, expectedUser)
	if err != nil {
		return core.RepositoryPreview{}, err
	}
	if s.repositoryStore == nil {
		return core.RepositoryPreview{}, errors.New("repository store unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	out, _, _, err := s.previewRepository(ctx, p, id, address, identity)
	s.logRepository(ctx, p, id, "preview", out.Classification, "", 0, false)
	return out, err
}
func relevantGitHubFacts(a, b repositorySnapshot) bool {
	x, y := a.github, b.github
	return reflect.DeepEqual(x.Access.TeamRole, y.Access.TeamRole) && x.Connection.Version == y.Connection.Version && x.Connection.Generation == y.Connection.Generation &&
		reflect.DeepEqual(x.Connection.RepositoryID, y.Connection.RepositoryID) && reflect.DeepEqual(x.Connection.InstallationID, y.Connection.InstallationID) &&
		reflect.DeepEqual(x.AppResourceID, y.AppResourceID) && reflect.DeepEqual(x.GrantID, y.GrantID) && reflect.DeepEqual(x.CredentialVersion, y.CredentialVersion) && reflect.DeepEqual(a.app, b.app)
}
func repositoryConflict() error {
	return &model.Fault{Code: "version_conflict", Message: "Repository preview changed. Preview again before saving."}
}
func (s *AppProjects) SetRepository(ctx context.Context, p model.Principal, id string, input core.RepositoryChange) (core.RepositoryReceipt, error) {
	id, identity, err := core.ValidateRepositoryChange(p, id, input.RepoURL, input.ExpectedUserID)
	if err != nil {
		return core.RepositoryReceipt{}, err
	}
	if input.RepositoryVersion < 1 || input.OwnershipVersion < 1 || input.TargetGitHubRepositoryID != nil && *input.TargetGitHubRepositoryID < 1 {
		return core.RepositoryReceipt{}, &model.Fault{Code: "invalid_input", Message: "Versions and repository ID must be positive."}
	}
	if input.Classification != "unchanged" && input.Classification != "same_repository" && input.Classification != "different_repository" && input.Classification != "unverified" || input.TreatUnverifiedAsSwitch && input.Classification != "unverified" || input.Classification == "unverified" && !input.TreatUnverifiedAsSwitch {
		return core.RepositoryReceipt{}, &model.Fault{Code: "invalid_input", Message: "Invalid repository classification or unverified confirmation."}
	}
	s.logRepository(ctx, p, id, "prepare", input.Classification, "", 0, false)
	if s.repositoryStore == nil {
		return core.RepositoryReceipt{}, errors.New("repository store unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	preview, before, evidence, err := s.previewRepository(ctx, p, id, input.RepoURL, identity)
	if err != nil {
		return core.RepositoryReceipt{}, err
	}
	if preview.RepositoryVersion != input.RepositoryVersion || preview.OwnershipVersion != input.OwnershipVersion || preview.Classification != input.Classification || !core.SameRepositoryID(preview.TargetGitHubRepositoryID, input.TargetGitHubRepositoryID) {
		return core.RepositoryReceipt{}, repositoryConflict()
	}
	var out core.RepositoryReceipt
	workerRows, workerRowsKnown := 0, false
	c, err := s.repositoryStore.WriteProjectRepository(ctx, id, p.UserID, func(scope store.ProjectRepositoryWriteScope) error {
		dao := scope.ProjectRepositoryDAO()
		github := scope.GitHubSwitchDAO()
		if _, e := github.LockBinding(ctx); e != nil {
			return e
		}
		now, e := repositoryFacts(ctx, p, dao, scope.GitHubAppDAO())
		if e != nil {
			return e
		}
		if now.project.Version != input.RepositoryVersion || now.project.Project.Ownership.Version != input.OwnershipVersion || now.project.Project.RepoURL != before.project.Project.RepoURL || repositoryIdentity(now.project) != repositoryIdentity(before.project) || !relevantGitHubFacts(before, now) {
			return repositoryConflict()
		}
		out = core.RepositoryReceipt{ProjectID: id, RepoURL: input.RepoURL, RepositoryVersion: now.project.Version}
		if input.Classification == "unchanged" {
			workerRowsKnown = true
			return nil
		}
		if now.project.Version == math.MaxInt64 {
			return &model.Fault{Code: "version_exhausted", Message: "Project repository version is exhausted."}
		}
		occupied, e := dao.RepositoryOccupiedByOther(ctx, now.project.Project.Ownership.TeamID, identity)
		if e != nil {
			return e
		}
		if occupied {
			return &model.Fault{Code: "project_repository_conflict", Message: "The target Team already owns an active Project for this repository."}
		}
		version, saved, e := dao.SaveRepository(ctx, input.RepoURL, identity, input.RepositoryVersion)
		if e != nil {
			return e
		}
		if !saved {
			return repositoryConflict()
		}
		if preview.BindingsInvalidated {
			var target *store.GitHubRepositoryTarget
			if evidence.TargetID != nil {
				target = &store.GitHubRepositoryTarget{RepositoryID: *evidence.TargetID, FullName: evidence.TargetFullName, Private: evidence.TargetPrivate}
			}
			decision, e := coregithub.RepositorySwitch(now.github.Connection, target)
			if e != nil {
				return e
			}
			saved, e := github.SaveSwitch(ctx, decision)
			if e != nil {
				return e
			}
			if !saved {
				return repositoryConflict()
			}
			if e = github.AdvanceImpact(ctx); e != nil {
				return e
			}
			workerRows, e = worker.RemoveProjectSelectionsCount(ctx, scope.WorkerSelectionsDAO(), id)
			if e != nil {
				return e
			}
		}
		workerRowsKnown = true
		out.RepositoryVersion, out.Changed, out.BindingsInvalidated = version, true, preview.BindingsInvalidated
		return nil
	})
	outcome := c.Outcome
	if outcome != store.TransactionCommitted && outcome != store.TransactionNotCommitted && outcome != store.TransactionUnknown {
		outcome = store.TransactionUnknown
	}
	if facts := operation.CompletionFacts(err); facts.Outcome != "" && facts.Outcome != outcome {
		outcome = store.TransactionUnknown
	}
	s.logRepository(ctx, p, id, "save", input.Classification, outcome, workerRows, workerRowsKnown)
	if err = completed(c, err, nil); err != nil {
		return core.RepositoryReceipt{}, core.ProjectWriteError(err)
	}
	return out, nil
}
