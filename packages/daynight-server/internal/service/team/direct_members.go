package team

import (
	"context"
	"errors"
	"time"

	identity "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
)

// DirectMembers coordinates independently committed identity initialization and Team membership.
type DirectMembers struct {
	writer     store.TeamWriter
	ensureUser func(context.Context, model.User) (model.User, error)
	resource   string
	now        func() time.Time
	ops        directMemberOperations
}

type directMemberOperations struct {
	validate     func(model.Principal, string, string, model.ProjectRole) (string, error)
	validateUser func(model.User) (model.User, error)
	credential   func(context.Context, store.IdentityDAO, store.CredentialFamilyDAO, model.Principal, string, time.Time) error
	authorize    func(context.Context, store.TeamWriteDAO, model.Principal) error
	add          func(context.Context, store.TeamWriteDAO, model.Principal, string, model.ProjectRole) (core.DirectMemberResult, error)
	eligibility  func(context.Context, store.WebhookEligibilityDAO, store.WebhookEligibilityFilter) error
}

func NewDirectMembers(writer store.TeamWriter, ensureUser func(context.Context, model.User) (model.User, error), resource string) *DirectMembers {
	return &DirectMembers{writer: writer, ensureUser: ensureUser, resource: resource, now: time.Now, ops: directMemberOperations{
		validate: core.ValidateAddMember, validateUser: identity.ValidateExternalUser,
		credential: identity.NewIdentity("").LockProfileCredential,
		authorize:  core.AuthorizeAddMember, add: core.AddMember, eligibility: webhook.RefreshEligibility,
	}}
}

func (s *DirectMembers) strict(ctx context.Context, id string, operation func(store.TeamWriteScope) error) error {
	c, err := s.writer.WriteTeam(ctx, id, operation)
	if err != nil {
		return err
	}
	if c.Outcome != store.TransactionCommitted {
		return errors.New("Team transaction did not confirm commit")
	}
	return nil
}

func (s *DirectMembers) lockCredential(ctx context.Context, scope store.TeamWriteScope, p model.Principal) error {
	return s.ops.credential(ctx, scope.IdentityDAO(), scope.CredentialFamilyDAO(), p, s.resource, s.now().UTC())
}

func (s *DirectMembers) AddMember(ctx context.Context, p model.Principal, id string, input core.AddTeamMember) (core.DirectMemberResult, error) {
	id, err := s.ops.validate(p, id, input.ExpectedUserID, input.Role)
	if err != nil {
		return core.DirectMemberResult{}, err
	}
	user, err := s.ops.validateUser(input.User)
	if err != nil {
		return core.DirectMemberResult{}, err
	}
	if err := s.strict(ctx, id, func(scope store.TeamWriteScope) error {
		if err := s.lockCredential(ctx, scope, p); err != nil {
			return err
		}
		return s.ops.authorize(ctx, scope.TeamDAO(), p)
	}); err != nil {
		return core.DirectMemberResult{}, err
	}
	user, err = s.ensureUser(ctx, user)
	if err != nil {
		return core.DirectMemberResult{}, err
	}
	var result core.DirectMemberResult
	err = s.strict(ctx, id, func(scope store.TeamWriteScope) error {
		if err := s.lockCredential(ctx, scope, p); err != nil {
			return err
		}
		var err error
		result, err = s.ops.add(ctx, scope.TeamDAO(), p, user.ID, input.Role)
		if err != nil {
			return err
		}
		if err := s.ops.eligibility(ctx, scope.EligibilityDAO(), store.WebhookEligibilityFilter{TeamID: id, UserID: user.ID}); err != nil {
			return err
		}
		// Membership and eligibility contention can outlast the initial credential check.
		return s.lockCredential(ctx, scope, p)
	})
	if err != nil {
		return core.DirectMemberResult{}, err
	}
	return result, nil
}
