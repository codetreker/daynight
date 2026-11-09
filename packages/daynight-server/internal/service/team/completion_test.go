package team

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/google/uuid"
	"reflect"
	"testing"
)

func TestListDiscardsResultsWhenSnapshotCompletionFails(t *testing.T) {
	f := newTeamFixture(t, listPlan()...)
	request := model.PageRequest{Limit: 10}
	f.bindList(request, core.TeamPage{Items: []model.Team{fixtureTeam()}, NextCursor: fixturePointer("retained lower cursor")}, nil)
	failure := errors.New("snapshot cleanup failed")
	f.readError = failure
	got, err := f.service.List(f.ctx, f.p, request)
	if err != failure || got.Items != nil || got.NextCursor != nil {
		t.Fatalf("snapshot completion exposed page=%+v error=%v", got, err)
	}
}
func TestCreationErrorPreservesIdentifierAndFailure(t *testing.T) {
	for _, allocated := range []bool{true, false} {
		t.Run("allocated", func(t *testing.T) {
			f := newTeamFixture(t, "validateCreate", "create_scope", "create", "create_done")
			cause := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("lost commit")}
			f.completion.Outcome = store.TransactionUnknown
			f.writeError = cause
			input := core.CreateTeam{Name: "Example", ExpectedUserID: f.p.UserID}
			result := fixtureTeam()
			if !allocated {
				result = model.Team{}
			}
			f.bindCreate(input, result, nil, nil)
			got, err := f.service.Create(f.ctx, f.p, input)
			var creation *CreationError
			var transaction *store.TransactionError
			if !reflect.DeepEqual(got, model.Team{}) || !errors.Is(err, cause) || !errors.As(err, &transaction) || transaction != cause || err.Error() != cause.Error() {
				t.Fatalf("creation completion=%+v %v", got, err)
			}
			if allocated {
				if !errors.As(err, &creation) || creation.TeamID != result.ID || uuid.Validate(creation.TeamID) != nil {
					t.Fatalf("allocated identity lost: %v", err)
				}
			} else if errors.As(err, &creation) || err != cause {
				t.Fatalf("unallocated creation invented identity: %v", err)
			}
		})
	}
	t.Run("unconfirmed outcome", func(t *testing.T) {
		f := newTeamFixture(t, "validateCreate", "create_scope", "create", "create_done")
		f.completion.Outcome = store.TransactionNotCommitted
		input := core.CreateTeam{Name: "Example", ExpectedUserID: f.p.UserID}
		f.bindCreate(input, model.Team{}, nil, nil)
		got, err := f.service.Create(f.ctx, f.p, input)
		if err == nil || !reflect.DeepEqual(got, model.Team{}) {
			t.Fatalf("unconfirmed creation=%+v %v", got, err)
		}
	})
}

func TestMCPTeamReadsDiscardResultsAfterSnapshotCompletionFailure(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionUnknown, store.TransactionNotCommitted, store.TransactionCommitted} {
		for _, method := range []string{"List", "Get", "MembersPage"} {
			t.Run(string(outcome)+"/"+method, func(t *testing.T) {
				plan := readPlan("get")
				if method == "List" {
					plan = listPlan()
				}
				if method == "MembersPage" {
					plan = readPlan("membersPage")
				}
				f := newTeamFixture(t, plan...)
				failure := &store.TransactionError{Phase: "commit", Outcome: outcome, CommitAttempted: true, Cause: errors.New("snapshot completion failure")}
				f.readError = failure
				request := model.PageRequest{Limit: 50}
				var result any
				var err error
				switch method {
				case "List":
					f.bindList(request, core.TeamPage{Items: []model.Team{fixtureTeam()}, NextCursor: fixturePointer("lower cursor")}, nil)
					result, err = f.service.List(f.ctx, f.p, request)
				case "Get":
					f.bindGet(fixtureTeam(), nil)
					result, err = f.service.Get(f.ctx, f.p, f.rawID)
				case "MembersPage":
					f.bindMembersPage(request, core.MemberPage{Items: []model.TeamMemberProfile{fixtureMember()}, NextCursor: fixturePointer("lower cursor")}, nil)
					result, err = f.service.MembersPage(f.ctx, f.p, f.rawID, request)
				}
				if err != failure || !reflect.DeepEqual(result, reflect.Zero(reflect.TypeOf(result)).Interface()) {
					t.Fatalf("snapshot completion exposed result=%+v error=%v", result, err)
				}
			})
		}
	}
}
func TestMCPTeamWritesPreserveUnknownCompletion(t *testing.T) {
	for _, method := range []string{"rename", "delete", "leave", "set_role", "remove"} {
		t.Run(method, func(t *testing.T) {
			validation, operation, refresh := "validateMember", "changeMember", true
			if method == "rename" || method == "delete" {
				validation = "validateChange"
				operation = method
				refresh = method == "delete"
			}
			f := newTeamFixture(t, writePlan(validation, operation, refresh)...)
			failure := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("lost commit")}
			f.completion.Outcome = store.TransactionUnknown
			f.writeError = failure
			var err error
			switch method {
			case "rename":
				input := core.ChangeTeam{Name: "Changed", Version: 1, ExpectedUserID: f.p.UserID}
				f.bindRename(input, fixtureTeam(), nil)
				result, e := f.service.Rename(f.ctx, f.p, f.rawID, input)
				err = e
				if !reflect.DeepEqual(result, model.Team{}) {
					t.Error("uncertain rename exposed result")
				}
			case "delete":
				input := core.ChangeTeam{Name: "Original", Version: 1, ExpectedUserID: f.p.UserID}
				f.bindDelete(input, nil)
				f.bindRefresh(store.WebhookEligibilityFilter{TeamID: f.id, TeamOwner: true}, nil)
				err = f.service.Delete(f.ctx, f.p, f.rawID, input)
			default:
				if method == "leave" {
					f.target = f.p.UserID
				}
				input := core.ChangeTeamMember{Version: 1, ExpectedUserID: f.p.UserID}
				remove := method != "set_role"
				if !remove {
					input.Role = model.ProjectAdmin
				}
				lower := core.TeamMemberResult{Membership: fixtureMember().Membership, ActorRole: fixturePointer(model.ProjectAdmin)}
				f.bindChangeMember(input, remove, lower, nil)
				f.bindRefresh(store.WebhookEligibilityFilter{TeamID: f.id, UserID: f.target}, nil)
				var result core.TeamMemberResult
				if remove {
					result, err = f.service.RemoveMember(f.ctx, f.p, f.rawID, f.target, input)
				} else {
					result, err = f.service.SetMemberRole(f.ctx, f.p, f.rawID, f.target, input)
				}
				if !reflect.DeepEqual(result, core.TeamMemberResult{}) {
					t.Error("uncertain membership exposed result")
				}
			}
			if err != failure || !errors.Is(err, failure) {
				t.Fatalf("unknown completion=%v", err)
			}
		})
	}
}

func TestTeamMissingReadsRetainSnapshotCompletionFailure(t *testing.T) {
	for _, method := range []string{"Get", "Members", "InspectInvitation"} {
		for _, failCompletion := range []bool{false, true} {
			t.Run(method, func(t *testing.T) {
				plan := readPlan("get")
				if method == "Members" {
					plan = readPlan("members")
				}
				if method == "InspectInvitation" {
					plan = []string{"validateInvitation", "snapshot", "reader", "invitation", "clock", "snapshot_done"}
				}
				f := newTeamFixture(t, plan...)
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				f.ctx = ctx
				refusal := fixtureFault("not_found")
				failure := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: context.Canceled}
				if failCompletion {
					f.readError = failure
					f.cancelAfterRead = cancel
				}
				var result any
				var err error
				switch method {
				case "Get":
					f.bindGet(model.Team{}, refusal)
					result, err = f.service.Get(f.ctx, f.p, f.rawID)
				case "Members":
					f.bindMembers(nil, refusal)
					result, err = f.service.Members(f.ctx, f.p, f.rawID)
				case "InspectInvitation":
					f.bindInvitation(fixtureInvitation(), refusal, nil)
					result, err = f.service.InspectInvitation(f.ctx, f.p, f.secret)
				}
				if !failCompletion {
					if err != refusal {
						t.Fatalf("snapshot refusal changed: %v", err)
					}
					return
				}
				var fault *model.Fault
				var completion *store.TransactionError
				if err != failure || !errors.Is(err, context.Canceled) || !errors.As(err, &completion) || completion.Outcome != store.TransactionUnknown || errors.As(err, &fault) || !reflect.DeepEqual(result, reflect.Zero(reflect.TypeOf(result)).Interface()) {
					t.Fatalf("completion became refusal/result: %+v %v", result, err)
				}
			})
		}
	}
}
