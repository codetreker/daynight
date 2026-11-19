package project

import (
	"context"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const transferBoundaryProject = "ca000000-0000-4000-8000-000000000001"
const transferBoundaryTarget = "ca000000-0000-4000-8000-000000000002"

func boundaryTransferInput(actor model.Principal) coreproject.TransferInput {
	return coreproject.TransferInput{
		Ownership: model.ProjectOwnership{
			TeamID:    projectProjectionTeam,
			Version:   1,
			UpdatedAt: time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC),
		},
		TargetTeam:     coreproject.TeamVersion{ID: projectProjectionTeam, Version: 1},
		ExpectedUserID: actor.UserID,
	}
}

func requireTransferRefusal[T comparable](t *testing.T, result T, err error, code string) *model.Fault {
	t.Helper()
	var zero T
	var fault *model.Fault
	if result != zero || !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("transfer result=%#v, error=%v, want zero result and %s", result, err, code)
	}
	return fault
}

func TestTransferValidationBeforeDomainSQL(t *testing.T) {
	actor, other := projectProjectionPrincipal(1), projectProjectionPrincipal(2)
	input := boundaryTransferInput(actor)
	input.TargetTeam.ID = transferBoundaryTarget
	input.ExpectedUserID = other.UserID
	result, err := NewProjects(projectValidationStore{}).Transfer(t.Context(), actor, transferBoundaryProject, input)
	requireTransferRefusal(t, result, err, "identity_mismatch")
}

func TestTransferInvalidInputsAndCancellation(t *testing.T) {
	actor := projectProjectionPrincipal(1)
	valid := boundaryTransferInput(actor)
	ctx := t.Context()
	projectID, targetID := transferBoundaryProject, valid.TargetTeam.ID
	validation := NewProjects(projectValidationStore{})
	preview, err := validation.TransferPreview(ctx, model.Principal{}, projectID, targetID)
	requireTransferRefusal(t, preview, err, "unauthenticated")
	preview, err = validation.TransferPreview(ctx, actor, "bad", targetID)
	requireTransferRefusal(t, preview, err, "invalid_input")
	preview, err = validation.TransferPreview(ctx, actor, projectID, strings.ToUpper(targetID))
	requireTransferRefusal(t, preview, err, "invalid_input")

	result, err := validation.Transfer(ctx, model.Principal{}, projectID, valid)
	requireTransferRefusal(t, result, err, "unauthenticated")
	result, err = validation.Transfer(ctx, actor, "bad", valid)
	requireTransferRefusal(t, result, err, "invalid_input")
	for _, mutate := range []func(*coreproject.TransferInput){
		func(input *coreproject.TransferInput) { input.Ownership.TeamID = "bad" },
		func(input *coreproject.TransferInput) { input.TargetTeam.ID = "bad" },
		func(input *coreproject.TransferInput) { input.Ownership.Version = 0 },
		func(input *coreproject.TransferInput) { input.TargetTeam.Version = 0 },
		func(input *coreproject.TransferInput) { input.ExpectedUserID = "bad" },
	} {
		input := valid
		mutate(&input)
		result, err := validation.Transfer(ctx, actor, projectID, input)
		requireTransferRefusal(t, result, err, "invalid_input")
	}

	canceled, cancel := context.WithCancel(ctx)
	cancel()
	readFailure := &store.Error{Phase: "begin snapshot", Cause: canceled.Err()}
	read := newCompletionProjectReadPlan(t, canceled, nil)
	read.begin = readFailure
	preview, err = NewProjects(read).TransferPreview(canceled, actor, projectID, targetID)
	assertOperational(t, err)
	if preview != (coreproject.TransferPreview{}) || !errors.Is(err, readFailure) || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled preview returned data or lost its cause: %#v, %v", preview, err)
	}

	writeFailure := &store.Error{Phase: "begin project write", Cause: canceled.Err()}
	write := newTransferBoundaryWriter(t, canceled, projectID)
	write.enterErr = writeFailure
	write.completion = store.Completion{Outcome: store.TransactionNotCommitted}
	result, err = NewProjects(write).Transfer(canceled, actor, projectID, valid)
	assertOperational(t, err)
	if result != (coreproject.TransferReceipt{}) || !errors.Is(err, writeFailure) || !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled transfer returned data or lost its cause: %#v, %v", result, err)
	}
}

type transferBoundaryWriter struct {
	projectValidationStore
	t             *testing.T
	ctx           context.Context
	projectID     string
	scope         *transferBoundaryScope
	enterErr      error
	callbackFault string
	callbackErr   error
	completion    store.Completion
	finishErr     error
	calls         int
}

func newTransferBoundaryWriter(t *testing.T, ctx context.Context, projectID string) *transferBoundaryWriter {
	t.Helper()
	db := &transferBoundaryWriter{t: t, ctx: ctx, projectID: projectID}
	t.Cleanup(func() {
		if db.calls != 1 {
			t.Errorf("Project transfer scope entered %d times, want 1", db.calls)
		}
		if db.scope != nil && len(db.scope.pending) != 0 {
			t.Errorf("unconsumed transfer scope calls: %v", db.scope.pending)
		}
		if db.scope != nil && len(db.scope.access) != 0 {
			t.Errorf("unconsumed transfer access results: %v", db.scope.access)
		}
	})
	return db
}

func (s *transferBoundaryWriter) WriteProject(ctx context.Context, projectID string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	s.t.Helper()
	s.calls++
	if s.calls != 1 || projectID != s.projectID {
		s.t.Fatalf("unexpected Project write: calls=%d same context=%v id=%q want %q", s.calls, ctx == s.ctx, projectID, s.projectID)
	}
	deadline, bounded := ctx.Deadline()
	if !bounded || time.Until(deadline) > projectLifecycleTimeout {
		s.t.Fatal("transfer has no lifecycle budget")
	}
	if s.scope != nil {
		s.scope.ctx = ctx
	}
	if s.enterErr != nil {
		return s.completion, s.enterErr
	}
	err := work(s.scope)
	if s.callbackFault != "" {
		transferFault(s.t, err, s.callbackFault)
		return s.completion, &store.TransactionError{Phase: "operation", Outcome: s.completion.Outcome, Cause: err}
	}
	if s.callbackErr != nil {
		if !errors.Is(err, s.callbackErr) {
			s.t.Fatalf("transfer callback error: %v, want %v", err, s.callbackErr)
		}
		return s.completion, &store.TransactionError{Phase: "operation", Outcome: s.completion.Outcome, Cause: err}
	}
	if err != nil {
		s.t.Fatalf("transfer callback failed: %v", err)
	}
	return s.completion, s.finishErr
}

type transferAccessResult struct {
	access model.ProjectAccess
	err    error
}

const transferRepositoryIdentity = "github.com/Org/Repo"

type transferBoundaryScope struct {
	store.ProjectWriteScope
	store.ProjectWriteDAO
	store.WebhookEligibilityDAO
	t         *testing.T
	ctx       context.Context
	actor     model.Principal
	targetID  string
	ownership model.ProjectOwnership
	source    store.TransferTeam
	target    store.TransferTeam
	pending   []string
	access    []transferAccessResult
	moved     model.ProjectOwnership
}

func (s *transferBoundaryScope) take(ctx context.Context, call string) {
	s.t.Helper()
	if ctx != s.ctx || len(s.pending) == 0 || s.pending[0] != call {
		s.t.Fatalf("transfer called %q: same context=%v pending=%v", call, ctx == s.ctx, s.pending)
	}
	s.pending = s.pending[1:]
}

func (s *transferBoundaryScope) ProjectDAO() store.ProjectWriteDAO {
	s.take(s.ctx, "ProjectDAO")
	return s
}

func (s *transferBoundaryScope) LockTransferOwnership(ctx context.Context) (model.ProjectOwnership, error) {
	s.take(ctx, "LockTransferOwnership")
	return s.ownership, nil
}

func (s *transferBoundaryScope) LockTransferTeams(ctx context.Context, source, target string) (store.TransferTeam, store.TransferTeam, error) {
	s.take(ctx, "LockTransferTeams")
	if source != s.ownership.TeamID || target != s.targetID {
		s.t.Fatalf("transfer Team locks: source=%q target=%q, want %q %q", source, target, s.ownership.TeamID, s.targetID)
	}
	return s.source, s.target, nil
}

func (s *transferBoundaryScope) ProjectAccess(ctx context.Context, actor model.Principal) (model.ProjectAccess, error) {
	s.take(ctx, "ProjectAccess")
	if actor != s.actor {
		s.t.Fatalf("transfer access actor=%#v, want %#v", actor, s.actor)
	}
	if len(s.access) == 0 {
		s.t.Fatal("transfer access requires explicit result facts")
	}
	result := s.access[0]
	s.access = s.access[1:]
	return result.access, result.err
}

func (s *transferBoundaryScope) RepositoryIdentity(ctx context.Context) (*string, error) {
	s.take(ctx, "RepositoryIdentity")
	return pointer(transferRepositoryIdentity), nil
}

func (s *transferBoundaryScope) RepositoryOccupied(ctx context.Context, teamID, identity string) (bool, error) {
	s.take(ctx, "RepositoryOccupied")
	if teamID != s.targetID || identity != transferRepositoryIdentity {
		s.t.Fatalf("transfer occupancy Team=%q identity=%q, want %q %q", teamID, identity, s.targetID, transferRepositoryIdentity)
	}
	return false, nil
}

func (s *transferBoundaryScope) MoveOwnership(ctx context.Context, targetID string) (model.ProjectOwnership, error) {
	s.take(ctx, "MoveOwnership")
	if targetID != s.targetID {
		s.t.Fatalf("transfer moved to %q, want %q", targetID, s.targetID)
	}
	return s.moved, nil
}

func (s *transferBoundaryScope) EligibilityDAO() store.WebhookEligibilityDAO {
	s.take(s.ctx, "EligibilityDAO")
	return s
}

func (s *transferBoundaryScope) LockAffected(ctx context.Context, filter store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	s.take(ctx, "LockAffected")
	want := store.WebhookEligibilityFilter{ProjectID: transferBoundaryProject}
	if filter != want {
		s.t.Fatalf("transfer eligibility filter=%#v, want %#v", filter, want)
	}
	return nil, nil
}

func boundaryTransferAccess(actor model.Principal, ownership model.ProjectOwnership, source model.TeamRef) model.ProjectAccess {
	role := model.ProjectAdmin
	return model.ProjectAccess{
		ProjectID: transferBoundaryProject,
		UserID:    actor.UserID,
		Role:      role,
		DirectGrant: &model.ProjectGrant{
			ProjectID: transferBoundaryProject, UserID: actor.UserID, Role: role, Version: 2,
			CreatedAt: ownership.UpdatedAt, UpdatedAt: ownership.UpdatedAt.Add(time.Second),
		},
		OwnerTeam: source, Ownership: ownership, TeamRole: &role, CanTransfer: true,
	}
}

func TestTransferUnavailableAndVersionExhaustion(t *testing.T) {
	actor := projectProjectionPrincipal(1)
	valid := boundaryTransferInput(actor)
	source := store.TransferTeam{Ref: model.TeamRef{ID: valid.Ownership.TeamID, Kind: "personal"}, Version: 1}
	const missingProject = "ca000000-0000-4000-8000-000000000098"
	const missingTeam = "ca000000-0000-4000-8000-000000000099"

	t.Run("preview missing Team", func(t *testing.T) {
		ctx := t.Context()
		read := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{
			{name: "access", args: []any{actor, transferBoundaryProject}, result: boundaryTransferAccess(actor, valid.Ownership, source.Ref)},
			{name: "transfer", args: []any{missingTeam}, err: model.ErrNotFound},
		})
		result, err := NewProjects(read).TransferPreview(ctx, actor, strings.ToUpper(transferBoundaryProject), missingTeam)
		fault := requireTransferRefusal(t, result, err, "not_found")
		if fault.Message != "Target Team was not found." || !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing Team preview: %v", err)
		}
	})

	t.Run("preview missing Project", func(t *testing.T) {
		ctx := t.Context()
		read := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{
			{name: "access", args: []any{actor, missingProject}, err: model.ErrNotFound},
		})
		result, err := NewProjects(read).TransferPreview(ctx, actor, missingProject, missingTeam)
		fault := requireTransferRefusal(t, result, err, "not_found")
		if fault.Message != "Project was not found." || !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing Project preview: %v", err)
		}
	})

	t.Run("transfer missing Project", func(t *testing.T) {
		ctx := t.Context()
		write := newTransferBoundaryWriter(t, ctx, missingProject)
		write.completion = store.Completion{Outcome: store.TransactionNotCommitted}
		lockFailure := &store.Error{Phase: "lock project", Cause: model.ErrNotFound, MissingRow: true}
		write.enterErr = &store.TransactionError{Phase: "operation", Outcome: write.completion.Outcome, Cause: lockFailure}
		input := valid
		input.TargetTeam = coreproject.TeamVersion{ID: missingTeam, Version: 1}
		result, err := NewProjects(write).Transfer(ctx, actor, missingProject, input)
		assertOperational(t, err)
		if result != (coreproject.TransferReceipt{}) || !errors.Is(err, write.enterErr) ||
			!errors.Is(err, lockFailure) || !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing Project transfer returned data or lost its lock failure: %#v, %v", result, err)
		}
	})

	destination := store.TransferTeam{Ref: model.TeamRef{ID: transferBoundaryTarget, Kind: "ordinary", Name: pointer("Destination")}, Version: 3}
	for _, test := range []struct {
		name      string
		ownership model.ProjectOwnership
		target    store.TransferTeam
		inputTeam coreproject.TeamVersion
		fault     string
	}{
		{
			name: "transfer missing Team", ownership: valid.Ownership,
			inputTeam: coreproject.TeamVersion{ID: missingTeam, Version: 1}, fault: "not_found",
		},
		{
			name:      "transfer ownership version exhausted",
			ownership: model.ProjectOwnership{TeamID: valid.Ownership.TeamID, Version: math.MaxInt64, UpdatedAt: valid.Ownership.UpdatedAt},
			target:    destination, inputTeam: coreproject.TeamVersion{ID: destination.Ref.ID, Version: destination.Version}, fault: "version_exhausted",
		},
		{
			name:      "same Team at exhausted ownership version",
			ownership: model.ProjectOwnership{TeamID: valid.Ownership.TeamID, Version: math.MaxInt64, UpdatedAt: valid.Ownership.UpdatedAt},
			target:    source, inputTeam: coreproject.TeamVersion{ID: source.Ref.ID, Version: source.Version},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			write := newTransferBoundaryWriter(t, ctx, transferBoundaryProject)
			scope := &transferBoundaryScope{
				t: t, ctx: ctx, actor: actor, targetID: test.inputTeam.ID,
				ownership: test.ownership, source: source, target: test.target,
				pending: []string{"ProjectDAO", "LockTransferOwnership", "LockTransferTeams", "ProjectAccess"},
				access:  []transferAccessResult{{access: boundaryTransferAccess(actor, test.ownership, source.Ref)}},
			}
			write.scope = scope
			write.callbackFault = test.fault
			write.completion = store.Completion{Outcome: store.TransactionNotCommitted}
			if test.fault == "" {
				scope.pending = append(scope.pending, "ProjectAccess", "EligibilityDAO", "LockAffected")
				scope.access = append(scope.access, scope.access[0])
				write.completion = store.Completion{Outcome: store.TransactionCommitted}
			}
			input := coreproject.TransferInput{Ownership: test.ownership, TargetTeam: test.inputTeam, ExpectedUserID: actor.UserID}
			result, err := NewProjects(write).Transfer(ctx, actor, strings.ToUpper(transferBoundaryProject), input)
			if test.fault != "" {
				fault := requireTransferRefusal(t, result, err, test.fault)
				if test.fault == "not_found" && fault.Message != "Target Team was not found." {
					t.Fatalf("missing Team transfer: %v", fault)
				}
				return
			}
			access := boundaryTransferAccess(actor, test.ownership, source.Ref)
			want := coreproject.TransferReceipt{
				ProjectID: transferBoundaryProject, SourceTeam: source.Ref, OwnerTeam: source.Ref,
				Ownership: test.ownership, ActorAccess: &access,
			}
			if err != nil || !reflect.DeepEqual(result, want) {
				t.Fatalf("no-op transfer at exhausted version: %#v, %v, want %#v", result, err, want)
			}
		})
	}
}

func (s *transferBoundaryScope) ProjectGoalDependencyDAO() store.ProjectGoalDependencyDAO { return s }
func (s *transferBoundaryScope) LockTeam(ctx context.Context) error {
	if ctx != s.ctx {
		s.t.Fatal("graph lock context differs from transaction")
	}
	return nil
}
func (s *transferBoundaryScope) HasProjectEdges(ctx context.Context) (bool, error) {
	if ctx != s.ctx {
		s.t.Fatal("graph probe context differs from transaction")
	}
	return false, nil
}
func (s *transferBoundaryScope) RemoveProjectEdges(context.Context) error {
	s.t.Fatal("unexpected confirmed removal")
	return nil
}
