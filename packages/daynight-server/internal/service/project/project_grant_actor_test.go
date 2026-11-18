package project

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const grantActorProject = "bf000000-0000-4000-8000-000000000001"

type grantActorCall struct {
	name   string
	args   []any
	result any
	err    error
}

type grantActorWritePlan struct {
	projectValidationStore
	store.ProjectWriteScope
	store.ProjectWriteDAO
	store.WebhookEligibilityDAO
	t          *testing.T
	ctx        context.Context
	pending    []grantActorCall
	writes     int
	inCallback bool
	completion store.Completion
	begin      *store.Error
}

func newGrantActorWritePlan(t *testing.T, ctx context.Context, pending ...grantActorCall) *grantActorWritePlan {
	t.Helper()
	p := &grantActorWritePlan{
		t:          t,
		ctx:        ctx,
		pending:    pending,
		completion: store.Completion{Outcome: store.TransactionCommitted},
	}
	t.Cleanup(func() {
		if p.writes != 1 || len(p.pending) != 0 {
			t.Errorf("Project write calls=%d, want 1; pending calls: %#v", p.writes, p.pending)
		}
	})
	return p
}

func (p *grantActorWritePlan) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	p.t.Helper()
	p.writes++
	if ctx != p.ctx || id != grantActorProject || p.writes != 1 {
		p.t.Fatalf("unexpected Project write: same context=%v id=%q writes=%d", ctx == p.ctx, id, p.writes)
	}
	if p.begin != nil {
		if !errors.Is(ctx.Err(), p.begin.Cause) {
			p.t.Fatalf("write did not receive canceled context: %v", ctx.Err())
		}
		return p.completion, p.begin
	}
	p.inCallback = true
	defer func() { p.inCallback = false }()
	if err := work(p); err != nil {
		p.t.Fatalf("unexpected Project callback error: %v", err)
	}
	return p.completion, nil
}

func (p *grantActorWritePlan) take(ctx context.Context, name string, args ...any) grantActorCall {
	p.t.Helper()
	if ctx != p.ctx || !p.inCallback || len(p.pending) == 0 {
		p.t.Fatalf("unexpected Project scope call %s(%#v): same context=%v in callback=%v pending=%#v", name, args, ctx == p.ctx, p.inCallback, p.pending)
	}
	call := p.pending[0]
	p.pending = p.pending[1:]
	if call.name != name || !reflect.DeepEqual(call.args, args) {
		p.t.Fatalf("Project scope call %s(%#v), want %s(%#v)", name, args, call.name, call.args)
	}
	return call
}

func (p *grantActorWritePlan) ProjectDAO() store.ProjectWriteDAO {
	p.take(p.ctx, "ProjectDAO")
	return p
}

func (p *grantActorWritePlan) EligibilityDAO() store.WebhookEligibilityDAO {
	p.take(p.ctx, "EligibilityDAO")
	return p
}

func (p *grantActorWritePlan) ProjectAccess(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
	call := p.take(ctx, "ProjectAccess", principal)
	if call.err != nil {
		return model.ProjectAccess{}, call.err
	}
	return call.result.(model.ProjectAccess), nil
}

func (p *grantActorWritePlan) DirectGrant(ctx context.Context, userID string) (model.ProjectGrant, error) {
	call := p.take(ctx, "DirectGrant", userID)
	return call.result.(model.ProjectGrant), call.err
}

func (p *grantActorWritePlan) RemoveMember(ctx context.Context, userID string) error {
	return p.take(ctx, "RemoveMember", userID).err
}

func (p *grantActorWritePlan) SetMemberRole(ctx context.Context, userID string, role model.ProjectRole) (model.ProjectMember, error) {
	call := p.take(ctx, "SetMemberRole", userID, role)
	return call.result.(model.ProjectMember), call.err
}

func (p *grantActorWritePlan) LockAffected(ctx context.Context, filter store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	call := p.take(ctx, "LockAffected", filter)
	return nil, call.err
}

func grantActorAccessFact(grant model.ProjectGrant) model.ProjectAccess {
	return model.ProjectAccess{
		ProjectID:   grant.ProjectID,
		UserID:      grant.UserID,
		Role:        grant.Role,
		DirectGrant: &grant,
		OwnerTeam:   model.TeamRef{ID: projectProjectionTeam, Kind: "personal"},
		Ownership:   model.ProjectOwnership{TeamID: projectProjectionTeam, Version: 1, UpdatedAt: grant.CreatedAt},
	}
}

func grantActorAdminFact(principal model.Principal) model.ProjectGrant {
	created := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	return model.ProjectGrant{
		ProjectID: grantActorProject,
		UserID:    principal.UserID,
		Role:      model.ProjectAdmin,
		Version:   4,
		CreatedAt: created,
		UpdatedAt: created.Add(time.Minute),
	}
}

func TestGrantActorLosesAccessAndIdentityGuard(t *testing.T) {
	owner, admin := projectProjectionPrincipal(1), projectProjectionPrincipal(2)
	before := grantActorAdminFact(admin)
	ctx := t.Context()
	validation := NewMemberships(projectValidationStore{})
	remove := coreproject.RemoveProjectMember{Version: before.Version, ExpectedUserID: owner.UserID}
	rejectedRemove, err := validation.RemoveGrant(ctx, admin, grantActorProject, admin.UserID, remove)
	requireFault(t, err, "identity_mismatch")
	if rejectedRemove != (coreproject.RemoveGrantResult{}) {
		t.Fatalf("identity mismatch returned a removal: %#v", rejectedRemove)
	}
	rejectedSet, err := validation.SetGrant(ctx, admin, grantActorProject, admin.UserID, coreproject.SetProjectGrant{
		Version: &before.Version, Role: model.ProjectMemberRole, ExpectedUserID: owner.UserID,
	})
	requireFault(t, err, "identity_mismatch")
	if rejectedSet != (coreproject.SetGrantResult{}) {
		t.Fatalf("identity mismatch returned a grant: %#v", rejectedSet)
	}

	db := newGrantActorWritePlan(t, ctx,
		grantActorCall{name: "ProjectDAO"},
		grantActorCall{name: "ProjectAccess", args: []any{admin}, result: grantActorAccessFact(before)},
		grantActorCall{name: "DirectGrant", args: []any{admin.UserID}, result: before},
		grantActorCall{name: "RemoveMember", args: []any{admin.UserID}},
		grantActorCall{name: "ProjectAccess", args: []any{admin}, err: model.ErrNotFound},
		grantActorCall{name: "EligibilityDAO"},
		grantActorCall{name: "LockAffected", args: []any{store.WebhookEligibilityFilter{ProjectID: grantActorProject, UserID: admin.UserID}}},
	)
	remove.ExpectedUserID = admin.UserID
	removed, err := NewMemberships(db).RemoveGrant(ctx, admin, strings.ToUpper(grantActorProject), strings.ToUpper(admin.UserID), remove)
	wantRemoved := coreproject.RemoveGrantResult{ProjectID: grantActorProject, UserID: admin.UserID}
	if err != nil || removed != wantRemoved {
		t.Fatalf("self-removal returned stale actor access or failed: %#v, %v, want %#v", removed, err, wantRemoved)
	}

	db = newGrantActorWritePlan(t, ctx,
		grantActorCall{name: "ProjectDAO"},
		grantActorCall{name: "ProjectAccess", args: []any{admin}, err: model.ErrNotFound},
	)
	result, err := NewMemberships(db).SetGrant(ctx, admin, grantActorProject, admin.UserID, coreproject.SetProjectGrant{
		Role: model.ProjectAdmin, ExpectedUserID: admin.UserID,
	})
	fault := requireFault(t, err, "not_found")
	if result != (coreproject.SetGrantResult{}) || !errors.Is(fault, model.ErrNotFound) {
		t.Fatalf("setting a grant after losing access returned data or lost its cause: %#v, %v", result, fault)
	}

	canceled, cancel := context.WithCancel(ctx)
	cancel()
	db = newGrantActorWritePlan(t, canceled)
	db.begin = &store.Error{Phase: "begin project write", Cause: context.Canceled}
	db.completion = store.Completion{Outcome: store.TransactionNotCommitted}
	result, err = NewMemberships(db).SetGrant(canceled, owner, grantActorProject, owner.UserID, coreproject.SetProjectGrant{
		Role: model.ProjectAdmin, ExpectedUserID: owner.UserID,
	})
	assertOperational(t, err)
	if !errors.Is(err, db.begin) || !errors.Is(err, context.Canceled) || result != (coreproject.SetGrantResult{}) {
		t.Fatalf("canceled grant returned data or lost its cause: %#v, %v", result, err)
	}

	result, err = validation.SetGrant(ctx, owner, grantActorProject, projectProjectionPrincipal(3).UserID, coreproject.SetProjectGrant{
		Version: new(int64), Role: model.ProjectAdmin, ExpectedUserID: owner.UserID,
	})
	requireFault(t, err, "invalid_input")
	if result != (coreproject.SetGrantResult{}) {
		t.Fatalf("invalid version returned a grant: %#v", result)
	}
}

func TestGrantSelfDemotionReturnsRemainingMemberAccess(t *testing.T) {
	owner, admin := projectProjectionPrincipal(1), projectProjectionPrincipal(2)
	before := grantActorAdminFact(admin)
	after := before
	after.Role = model.ProjectMemberRole
	after.Version = 9
	after.UpdatedAt = before.UpdatedAt.Add(time.Minute)

	ctx := t.Context()
	db := newGrantActorWritePlan(t, ctx,
		grantActorCall{name: "ProjectDAO"},
		grantActorCall{name: "ProjectAccess", args: []any{admin}, result: grantActorAccessFact(before)},
		grantActorCall{name: "DirectGrant", args: []any{admin.UserID}, result: before},
		grantActorCall{name: "SetMemberRole", args: []any{admin.UserID, model.ProjectMemberRole}, result: model.ProjectMember{Grant: after}},
		grantActorCall{name: "ProjectAccess", args: []any{admin}, result: grantActorAccessFact(after)},
		grantActorCall{name: "EligibilityDAO"},
		grantActorCall{name: "LockAffected", args: []any{store.WebhookEligibilityFilter{ProjectID: grantActorProject, UserID: admin.UserID}}},
	)
	result, err := NewMemberships(db).SetGrant(ctx, admin, strings.ToUpper(grantActorProject), strings.ToUpper(admin.UserID), coreproject.SetProjectGrant{
		Version: &before.Version, Role: model.ProjectMemberRole, ExpectedUserID: admin.UserID,
	})
	wantAccess := grantActorAccessFact(after)
	want := coreproject.SetGrantResult{Grant: after, ActorAccess: &wantAccess}
	if err != nil || !reflect.DeepEqual(result, want) {
		t.Fatalf("self-demotion returned stale actor access or failed: %#v, %v, want %#v", result, err, want)
	}

	db = newGrantActorWritePlan(t, ctx,
		grantActorCall{name: "ProjectDAO"},
		grantActorCall{name: "ProjectAccess", args: []any{admin}, result: grantActorAccessFact(after)},
	)
	result, err = NewMemberships(db).SetGrant(ctx, admin, grantActorProject, owner.UserID, coreproject.SetProjectGrant{
		Role: model.ProjectMemberRole, ExpectedUserID: admin.UserID,
	})
	requireFault(t, err, "forbidden")
	if result != (coreproject.SetGrantResult{}) {
		t.Fatalf("forbidden grant returned data: %#v", result)
	}
}
