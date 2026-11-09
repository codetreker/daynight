package team

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"reflect"
	"strings"
	"testing"
)

func TestTeamMemberServiceLifecycle(t *testing.T) {
	for _, test := range []struct {
		name         string
		remove, self bool
		role         model.ProjectRole
		actorRole    *model.ProjectRole
	}{
		{"promotion", false, false, model.ProjectAdmin, fixturePointer(model.ProjectAdmin)},
		{"no-op", false, false, model.ProjectAdmin, fixturePointer(model.ProjectAdmin)},
		{"self demotion", false, true, model.ProjectMemberRole, fixturePointer(model.ProjectMemberRole)},
		{"self exit", true, true, "", nil},
		{"remove member", true, false, "", fixturePointer(model.ProjectAdmin)},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newTeamFixture(t, writePlan("validateMember", "changeMember", true)...)
			if test.self {
				f.target = f.p.UserID
			}
			input := core.ChangeTeamMember{Version: 9007199254740995, Role: test.role, ExpectedUserID: f.p.UserID}
			member := fixtureMember().Membership
			member.UserID = f.target
			if !test.remove {
				member.Role = test.role
			}
			if test.name == "promotion" || test.name == "self demotion" {
				member.Version = input.Version + 1
			}
			want := core.TeamMemberResult{Membership: member, ActorRole: test.actorRole}
			f.bindChangeMember(input, test.remove, want, nil)
			f.bindRefresh(store.WebhookEligibilityFilter{TeamID: f.id, UserID: f.target}, nil)
			var got core.TeamMemberResult
			var err error
			if test.remove {
				got, err = f.service.RemoveMember(f.ctx, f.p, f.rawID, f.target, input)
			} else {
				got, err = f.service.SetMemberRole(f.ctx, f.p, f.rawID, f.target, input)
			}
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("member change=%+v %v", got, err)
			}
		})
	}
	for _, remove := range []bool{false, true} {
		for _, code := range []string{"forbidden", "not_found", "version_conflict", "last_admin", "personal_team_immutable"} {
			t.Run(code, func(t *testing.T) {
				f := newTeamFixture(t, writePlan("validateMember", "changeMember", false)...)
				input := core.ChangeTeamMember{Version: 1, Role: model.ProjectMemberRole, ExpectedUserID: f.p.UserID}
				refusal := fixtureFault(code)
				f.bindChangeMember(input, remove, core.TeamMemberResult{}, refusal)
				var got core.TeamMemberResult
				var err error
				if remove {
					got, err = f.service.RemoveMember(f.ctx, f.p, f.rawID, f.target, input)
				} else {
					got, err = f.service.SetMemberRole(f.ctx, f.p, f.rawID, f.target, input)
				}
				if err != refusal || !reflect.DeepEqual(got, core.TeamMemberResult{}) {
					t.Fatalf("member refusal=%+v %v", got, err)
				}
			})
		}
	}
}

func TestTeamMemberServiceValidationAndFailures(t *testing.T) {
	for _, remove := range []bool{false, true} {
		for _, kind := range []string{"identity mismatch", "unauthenticated", "invalid Team", "noncanonical user", "invalid version", "invalid role"} {
			t.Run(kind, func(t *testing.T) {
				f := newTeamFixture(t, "validateMember")
				input := core.ChangeTeamMember{Version: 1, Role: model.ProjectAdmin, ExpectedUserID: f.p.UserID}
				code := "invalid_input"
				switch kind {
				case "identity mismatch":
					input.ExpectedUserID = teamFixtureTarget
					code = "identity_mismatch"
				case "unauthenticated":
					f.p = model.Principal{}
					code = "unauthenticated"
				case "invalid Team":
					f.rawID = "invalid"
				case "noncanonical user":
					f.target = strings.ToUpper("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
				case "invalid version":
					input.Version = 0
				case "invalid role":
					input.Role = "invalid"
				}
				refusal := fixtureFault(code)
				f.validateMember(input, remove, refusal)
				var err error
				if remove {
					_, err = f.service.RemoveMember(f.ctx, f.p, f.rawID, f.target, input)
				} else {
					_, err = f.service.SetMemberRole(f.ctx, f.p, f.rawID, f.target, input)
				}
				if err != refusal {
					t.Fatalf("member admission changed: %v", err)
				}
			})
		}
	}
	for _, kind := range []string{"unauthenticated", "invalid Team"} {
		t.Run("Members "+kind, func(t *testing.T) {
			f := newTeamFixture(t, "validateRead")
			code := "invalid_input"
			if kind == "unauthenticated" {
				f.p = model.Principal{}
				code = "unauthenticated"
			} else {
				f.rawID = "invalid"
			}
			refusal := fixtureFault(code)
			f.validateRead(refusal)
			got, err := f.service.Members(f.ctx, f.p, f.rawID)
			if err != refusal || got != nil {
				t.Fatalf("Members admission=%+v %v", got, err)
			}
		})
	}
	for _, method := range []string{"Members", "SetMemberRole"} {
		t.Run("canceled "+method, func(t *testing.T) {
			plan := []string{"validateRead", "snapshot", "snapshot_done"}
			if method == "SetMemberRole" {
				plan = []string{"validateMember", "write", "write_done"}
			}
			f := newTeamFixture(t, plan...)
			ctx, cancel := context.WithCancel(t.Context())
			cancel()
			f.ctx = ctx
			f.runRead = false
			f.runWrite = false
			f.readError = context.Canceled
			f.writeError = context.Canceled
			var err error
			if method == "Members" {
				f.validateRead(nil)
				_, err = f.service.Members(ctx, f.p, f.rawID)
			} else {
				input := core.ChangeTeamMember{Version: 1, Role: model.ProjectAdmin, ExpectedUserID: f.p.UserID}
				f.validateMember(input, false, nil)
				_, err = f.service.SetMemberRole(ctx, f.p, f.rawID, f.target, input)
			}
			if err != context.Canceled {
				t.Fatalf("cancellation changed: %v", err)
			}
		})
	}
}

func TestTeamMemberServiceRetainsAdminTransitionRefusals(t *testing.T) {
	for _, remove := range []bool{false, true} {
		for _, refused := range []bool{false, true} {
			t.Run("transition", func(t *testing.T) {
				f := newTeamFixture(t, writePlan("validateMember", "changeMember", !refused)...)
				f.target = f.p.UserID
				input := core.ChangeTeamMember{Version: 3, Role: model.ProjectMemberRole, ExpectedUserID: f.p.UserID}
				want := core.TeamMemberResult{Membership: fixtureMember().Membership, ActorRole: fixturePointer(model.ProjectMemberRole)}
				var refusal error
				if refused {
					refusal = fixtureFault("last_admin")
					want = core.TeamMemberResult{}
				}
				f.bindChangeMember(input, remove, want, refusal)
				if !refused {
					f.bindRefresh(store.WebhookEligibilityFilter{TeamID: f.id, UserID: f.target}, nil)
				}
				var got core.TeamMemberResult
				var err error
				if remove {
					got, err = f.service.RemoveMember(f.ctx, f.p, f.rawID, f.target, input)
				} else {
					got, err = f.service.SetMemberRole(f.ctx, f.p, f.rawID, f.target, input)
				}
				if err != refusal || !reflect.DeepEqual(got, want) {
					t.Fatalf("admin transition=%+v %v", got, err)
				}
			})
		}
	}
}

func TestTeamMemberOperationCancellationPreservesFailure(t *testing.T) {
	for _, stage := range []string{"snapshot team", "write actor", "target", "count admins", "remove", "change role"} {
		t.Run(stage, func(t *testing.T) {
			read := stage == "snapshot team"
			remove := stage == "remove"
			plan := writePlan("validateMember", "changeMember", false)
			if read {
				plan = readPlan("members")
			}
			f := newTeamFixture(t, plan...)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			f.ctx = ctx
			cause := errors.Join(errors.New("declared lower query failure"), context.Canceled)
			var err error
			if read {
				f.validateRead(nil)
				f.readCallbackError = cause
				f.readError = cause
				f.service.core.members = func(actual context.Context, dao store.TeamReader, p model.Principal, id string) ([]model.TeamMemberProfile, error) {
					f.readCall("members", actual, dao, p, id)
					cancel()
					return []model.TeamMemberProfile{fixtureMember()}, cause
				}
				result, e := f.service.Members(ctx, f.p, f.rawID)
				err = e
				if result != nil {
					t.Error("canceled read exposed result")
				}
			} else {
				input := core.ChangeTeamMember{Version: 3, Role: model.ProjectAdmin, ExpectedUserID: f.p.UserID}
				if stage == "count admins" {
					f.target = f.p.UserID
					input.Role = model.ProjectMemberRole
				}
				f.validateMember(input, remove, nil)
				f.writeCallbackError = cause
				f.writeError = cause
				f.service.core.changeMember = func(actual context.Context, dao store.TeamWriteDAO, p model.Principal, target string, change core.ChangeTeamMember, actualRemove bool) (core.TeamMemberResult, error) {
					f.writeCall("changeMember", actual, dao, p)
					if target != f.target || change != input || actualRemove != remove {
						t.Error("canceled operation input changed")
					}
					cancel()
					return core.TeamMemberResult{Membership: fixtureMember().Membership}, cause
				}
				var result core.TeamMemberResult
				if remove {
					result, err = f.service.RemoveMember(ctx, f.p, f.rawID, f.target, input)
				} else {
					result, err = f.service.SetMemberRole(ctx, f.p, f.rawID, f.target, input)
				}
				if !reflect.DeepEqual(result, core.TeamMemberResult{}) {
					t.Error("canceled write exposed result")
				}
			}
			if err != cause || !errors.Is(err, context.Canceled) || ctx.Err() != context.Canceled {
				t.Fatalf("operation cancellation changed: %v", err)
			}
		})
	}
}
