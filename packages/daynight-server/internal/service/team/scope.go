package team

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
)

// AuthorizationProvider returns the authenticated request's current snapshot.
type AuthorizationProvider func(context.Context, model.Principal) (model.CredentialAuthorization, error)

// SnapshotAuthorization reads current authorization through the same snapshot as the business read.
type SnapshotAuthorization func(context.Context, store.SnapshotScope, model.Principal) (model.CredentialAuthorization, error)

// WriteAuthorization reads current authorization through the existing Team transaction.
type WriteAuthorization func(context.Context, store.TeamWriteScope, model.Principal) (model.CredentialAuthorization, error)

type scopeAdmission struct {
	request  AuthorizationProvider
	snapshot SnapshotAuthorization
	write    WriteAuthorization
}

func scopeCheck(provider AuthorizationProvider) func(context.Context, model.Principal, ...scopepolicy.Operation) error {
	return func(ctx context.Context, principal model.Principal, operations ...scopepolicy.Operation) error {
		auth, err := provider(ctx, principal)
		if err != nil {
			return err
		}
		if auth.Principal != principal {
			return errors.New("Team authorization principal mismatch")
		}
		return core.RequireScope(auth, operations...)
	}
}
func (s *scopeAdmission) context(ctx context.Context) context.Context {
	if s == nil {
		return ctx
	}
	return core.WithScopeCheck(ctx, scopeCheck(s.request))
}
func (s *scopeAdmission) snapshotContext(ctx context.Context, scope store.SnapshotScope) context.Context {
	if s == nil {
		return ctx
	}
	return core.WithScopeCheck(ctx, scopeCheck(func(ctx context.Context, p model.Principal) (model.CredentialAuthorization, error) {
		return s.snapshot(ctx, scope, p)
	}))
}
func (s *scopeAdmission) writeContext(ctx context.Context, scope store.TeamWriteScope) context.Context {
	if s == nil {
		return ctx
	}
	return core.WithScopeCheck(ctx, scopeCheck(func(ctx context.Context, p model.Principal) (model.CredentialAuthorization, error) {
		return s.write(ctx, scope, p)
	}))
}
func (s *scopeAdmission) require(ctx context.Context, p model.Principal, operations ...scopepolicy.Operation) error {
	if s == nil {
		return nil
	}
	return scopeCheck(s.request)(ctx, p, operations...)
}

// NewScopedTeams enables request-snapshot admission while preserving the original
// constructor for existing deployments. Snapshot reads need their own authority.
func NewScopedTeams(database interface {
	store.TeamWriter
	store.SnapshotReader
}, request AuthorizationProvider, snapshot SnapshotAuthorization) (*Teams, error) {
	if request == nil || snapshot == nil {
		return nil, errors.New("Team authorization providers are required")
	}
	teams := NewTeams(database)
	teams.admission = &scopeAdmission{request: request, snapshot: snapshot}
	return teams, nil
}

// NewScopedDirectMembers requires transaction-bound current authorization at
// the existing credential revalidation points.
func NewScopedDirectMembers(writer store.TeamWriter, ensureUser func(context.Context, model.User) (model.User, error), resource string, request AuthorizationProvider, current WriteAuthorization) (*DirectMembers, error) {
	if request == nil || current == nil {
		return nil, errors.New("Team authorization providers are required")
	}
	members := NewDirectMembers(writer, ensureUser, resource)
	members.admission = &scopeAdmission{request: request, write: current}
	return members, nil
}

func (s *scopeAdmission) requireWrite(ctx context.Context, scope store.TeamWriteScope, p model.Principal, operations ...scopepolicy.Operation) error {
	if s == nil {
		return nil
	}
	return scopeCheck(func(ctx context.Context, principal model.Principal) (model.CredentialAuthorization, error) {
		return s.write(ctx, scope, principal)
	})(ctx, p, operations...)
}

// NewScopedAppTeams enables Team admission on the GitHub lifecycle-aware deletion path.
func NewScopedAppTeams(db interface {
	store.TeamWriter
	store.SnapshotReader
	store.GitHubTeamDeletionStore
}, request AuthorizationProvider, snapshot SnapshotAuthorization) (*AppTeams, error) {
	teams, err := NewScopedTeams(db, request, snapshot)
	if err != nil {
		return nil, err
	}
	return &AppTeams{Teams: teams, lifecycle: db}, nil
}

// ScopeProtected reports whether this service was constructed with mandatory admission.
func (s *Teams) ScopeProtected() bool         { return s != nil && s.admission != nil }
func (s *DirectMembers) ScopeProtected() bool { return s != nil && s.admission != nil }
