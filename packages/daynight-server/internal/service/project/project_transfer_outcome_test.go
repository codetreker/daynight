package project

import (
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgconn"
)

func transferBoundaryTeams() (source, target store.TransferTeam) {
	return store.TransferTeam{Ref: model.TeamRef{ID: projectProjectionTeam, Kind: "personal"}, Version: 1},
		store.TransferTeam{Ref: model.TeamRef{ID: transferBoundaryTarget, Kind: "ordinary", Name: pointer("Destination")}, Version: 1}
}

func TestTransferPreviewRoleAndAuthorization(t *testing.T) {
	actor := projectProjectionPrincipal(1)
	ownership := boundaryTransferInput(actor).Ownership
	source, target := transferBoundaryTeams()
	for _, test := range []struct {
		name string
		role *model.ProjectRole
	}{
		{name: "direct administrator at destination", role: pointer(model.ProjectAdmin)},
		{name: "no access at destination"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			access := boundaryTransferAccess(actor, ownership, source.Ref)
			if test.role == nil {
				access.DirectGrant = nil
			}
			read := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{
				{name: "access", args: []any{actor, transferBoundaryProject}, result: access},
				{name: "transfer", args: []any{target.Ref.ID}, result: target},
				{name: "transfer role", args: []any{actor.UserID, transferBoundaryProject, target.Ref.ID}, result: test.role},
			})
			preview, err := NewProjects(read).TransferPreview(ctx, actor, strings.ToUpper(transferBoundaryProject), target.Ref.ID)
			want := coreproject.TransferPreview{
				SourceTeam: source.Ref, TargetTeam: target.Ref,
				Ownership: ownership, TargetTeamVersion: target.Version, ActorRole: test.role,
			}
			if err != nil || !reflect.DeepEqual(preview, want) {
				t.Fatalf("preview %#v, error %v, want %#v", preview, err, want)
			}
		})
	}

	t.Run("Project-only administrator", func(t *testing.T) {
		ctx := t.Context()
		other := projectProjectionPrincipal(2)
		directOnly := boundaryTransferAccess(other, ownership, source.Ref)
		directOnly.TeamRole = nil
		directOnly.CanTransfer = false
		read := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{
			{name: "access", args: []any{other, transferBoundaryProject}, result: directOnly},
		})
		preview, err := NewProjects(read).TransferPreview(ctx, other, transferBoundaryProject, target.Ref.ID)
		requireTransferRefusal(t, preview, err, "forbidden")
	})
}

func TestTransferAuthorizationAndVersionRefusals(t *testing.T) {
	actor := projectProjectionPrincipal(1)
	source, destination := transferBoundaryTeams()
	valid := boundaryTransferInput(actor)
	for _, test := range []struct {
		name        string
		target      store.TransferTeam
		inputOwner  int64
		actualOwner int64
		inputTeam   int64
		projectOnly bool
		code        string
	}{
		{name: "Project-only administrator", target: destination, inputOwner: 1, actualOwner: 1, inputTeam: 1, projectOnly: true, code: "forbidden"},
		{name: "higher ownership version", target: destination, inputOwner: 2, actualOwner: 1, inputTeam: 1, code: "version_conflict"},
		{name: "higher destination version", target: destination, inputOwner: 1, actualOwner: 1, inputTeam: 2, code: "version_conflict"},
		{name: "higher same Team version", target: source, inputOwner: 1, actualOwner: 1, inputTeam: 2, code: "version_conflict"},
		{name: "original Team after two moves", target: destination, inputOwner: 1, actualOwner: 3, inputTeam: 1, code: "version_conflict"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			principal := actor
			if test.projectOnly {
				principal = projectProjectionPrincipal(2)
			}
			input := valid
			input.Ownership.Version = test.inputOwner
			input.TargetTeam = coreproject.TeamVersion{ID: test.target.Ref.ID, Version: test.inputTeam}
			input.ExpectedUserID = principal.UserID
			ownership := valid.Ownership
			ownership.Version = test.actualOwner
			access := boundaryTransferAccess(principal, ownership, source.Ref)
			if test.projectOnly {
				access.TeamRole = nil
				access.CanTransfer = false
			}
			write := newTransferBoundaryWriter(t, ctx, transferBoundaryProject)
			write.callbackFault = test.code
			write.completion = store.Completion{Outcome: store.TransactionNotCommitted}
			write.scope = &transferBoundaryScope{
				t: t, ctx: ctx, actor: principal, targetID: input.TargetTeam.ID,
				ownership: ownership, source: source, target: test.target,
				pending: []string{"ProjectDAO", "LockTransferOwnership", "LockTransferTeams", "ProjectAccess"},
				access:  []transferAccessResult{{access: access}},
			}
			result, err := NewProjects(write).Transfer(ctx, principal, transferBoundaryProject, input)
			requireTransferRefusal(t, result, err, test.code)
		})
	}
}

func TestTransferReceiptRequiresCompletionAfterEligibilityRefresh(t *testing.T) {
	actor := projectProjectionPrincipal(1)
	source, destination := transferBoundaryTeams()
	for _, test := range []struct {
		name    string
		target  store.TransferTeam
		outcome store.TransactionOutcome
		cause   error
	}{
		{name: "confirmed move", target: destination, outcome: store.TransactionCommitted},
		{name: "move did not commit", target: destination, outcome: store.TransactionNotCommitted},
		{name: "move lost commit response", target: destination, outcome: store.TransactionUnknown, cause: errors.New("commit response lost")},
		{name: "confirmed same Team", target: source, outcome: store.TransactionCommitted},
		{name: "same Team without confirmation", target: source, outcome: store.TransactionUnknown},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			input := boundaryTransferInput(actor)
			input.TargetTeam = coreproject.TeamVersion{ID: test.target.Ref.ID, Version: test.target.Version}
			access := boundaryTransferAccess(actor, input.Ownership, source.Ref)
			access.DirectGrant = nil
			want := coreproject.TransferReceipt{
				ProjectID: transferBoundaryProject, SourceTeam: source.Ref, OwnerTeam: test.target.Ref,
				Ownership: input.Ownership, ActorAccess: &access,
			}
			scope := &transferBoundaryScope{
				t: t, ctx: ctx, actor: actor, targetID: input.TargetTeam.ID,
				ownership: input.Ownership, source: source, target: test.target,
				pending: []string{"ProjectDAO", "LockTransferOwnership", "LockTransferTeams", "ProjectAccess"},
				access:  []transferAccessResult{{access: access}},
			}
			if test.target.Ref.ID == destination.Ref.ID {
				want.Changed = true
				want.Ownership = model.ProjectOwnership{
					TeamID: destination.Ref.ID, Version: 2, UpdatedAt: input.Ownership.UpdatedAt.Add(time.Second),
				}
				want.ActorAccess = nil
				scope.moved = want.Ownership
				scope.pending = append(scope.pending, "RepositoryIdentity", "RepositoryOccupied", "MoveOwnership")
				scope.access = append(scope.access, transferAccessResult{err: model.ErrNotFound})
			} else {
				scope.access = append(scope.access, transferAccessResult{access: access})
			}
			scope.pending = append(scope.pending, "ProjectAccess", "EligibilityDAO", "LockAffected")
			write := newTransferBoundaryWriter(t, ctx, transferBoundaryProject)
			write.scope = scope
			write.completion = store.Completion{Outcome: test.outcome}
			if test.cause != nil {
				write.finishErr = &store.TransactionError{
					Phase: "commit", Cause: test.cause, Outcome: test.outcome, CommitAttempted: true,
				}
			}
			result, err := NewProjects(write).Transfer(ctx, actor, strings.ToUpper(transferBoundaryProject), input)
			if test.outcome == store.TransactionCommitted {
				if err != nil || !reflect.DeepEqual(result, want) {
					t.Fatalf("confirmed receipt %#v, error %v, want %#v", result, err, want)
				}
				return
			}
			assertOperational(t, err)
			if result != (coreproject.TransferReceipt{}) {
				t.Fatalf("unconfirmed transaction returned receipt %#v", result)
			}
			if test.cause != nil && (!errors.Is(err, write.finishErr) || !errors.Is(err, test.cause)) {
				t.Fatalf("unconfirmed transaction lost commit failure: %v", err)
			}
		})
	}
}

func TestTransferAuthorizationQueryFailure(t *testing.T) {
	actor := projectProjectionPrincipal(1)
	ctx := t.Context()
	input := boundaryTransferInput(actor)
	source, _ := transferBoundaryTeams()
	cause := &pgconn.PgError{Code: "42P01", Message: "project_grants does not exist"}
	failure := &store.Error{Phase: "read project access", SQLState: cause.Code, DatabaseFailure: true, Cause: cause}

	read := newCompletionProjectReadPlan(t, ctx, []completionProjectReadCall{
		{name: "access", args: []any{actor, transferBoundaryProject}, err: failure},
	})
	read.callbackErr = failure
	preview, err := NewProjects(read).TransferPreview(ctx, actor, transferBoundaryProject, source.Ref.ID)
	assertOperational(t, err)
	if preview != (coreproject.TransferPreview{}) || !errors.Is(err, failure) || !errors.Is(err, cause) {
		t.Fatalf("failed authorization preview returned data or lost its cause: %#v %v", preview, err)
	}

	write := newTransferBoundaryWriter(t, ctx, transferBoundaryProject)
	write.completion = store.Completion{Outcome: store.TransactionNotCommitted}
	write.callbackErr = failure
	write.scope = &transferBoundaryScope{
		t: t, ctx: ctx, actor: actor, targetID: source.Ref.ID,
		ownership: input.Ownership, source: source, target: source,
		pending: []string{"ProjectDAO", "LockTransferOwnership", "LockTransferTeams", "ProjectAccess"},
		access:  []transferAccessResult{{err: failure}},
	}
	result, err := NewProjects(write).Transfer(ctx, actor, transferBoundaryProject, input)
	assertOperational(t, err)
	if result != (coreproject.TransferReceipt{}) || !errors.Is(err, failure) || !errors.Is(err, cause) {
		t.Fatalf("failed authorization transfer returned data or lost its cause: %#v %v", result, err)
	}
}
