package team

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"math"
	"reflect"
	"strings"
	"testing"
)

func readPlan(operation string) []string {
	return []string{"validateRead", "snapshot", "reader", operation, "snapshot_done"}
}
func listPlan() []string { return []string{"snapshot", "reader", "list", "snapshot_done"} }
func writePlan(validation, operation string, refresh bool) []string {
	result := []string{validation, "write", "writer", operation}
	if refresh {
		result = append(result, "eligibility", "refresh")
	}
	return append(result, "write_done")
}

func TestTeamLifecycleForwardsExactMetadata(t *testing.T) {
	raw := " \t研发😀\u2003 " + strings.Repeat("x", 180)
	t.Run("create", func(t *testing.T) {
		f := newTeamFixture(t, "validateCreate", "create_scope", "create", "create_done")
		input := core.CreateTeam{Name: raw, ExpectedUserID: f.p.UserID}
		want := fixtureTeam()
		want.Name = fixturePointer(raw)
		f.bindCreate(input, want, nil, nil)
		got, err := f.service.Create(f.ctx, f.p, input)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("creation=%+v %v", got, err)
		}
	})
	t.Run("get", func(t *testing.T) {
		f := newTeamFixture(t, readPlan("get")...)
		want := fixtureTeam()
		want.Name = fixturePointer(raw)
		f.bindGet(want, nil)
		got, err := f.service.Get(f.ctx, f.p, f.rawID)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("read=%+v %v", got, err)
		}
	})
	for _, name := range []string{raw, " Renamed "} {
		t.Run("rename "+name, func(t *testing.T) {
			f := newTeamFixture(t, writePlan("validateChange", "rename", false)...)
			input := core.ChangeTeam{Name: name, Version: 1, ExpectedUserID: f.p.UserID}
			want := fixtureTeam()
			want.Name = fixturePointer(name)
			f.bindRename(input, want, nil)
			got, err := f.service.Rename(f.ctx, f.p, f.rawID, input)
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("rename=%+v %v", got, err)
			}
		})
	}
	t.Run("delete", func(t *testing.T) {
		f := newTeamFixture(t, writePlan("validateChange", "delete", true)...)
		input := core.ChangeTeam{Name: raw, Version: 2, ExpectedUserID: f.p.UserID}
		f.bindDelete(input, nil)
		f.bindRefresh(store.WebhookEligibilityFilter{TeamID: f.id, TeamOwner: true}, nil)
		if err := f.service.Delete(f.ctx, f.p, f.rawID, input); err != nil {
			t.Fatal(err)
		}
	})
}

func TestTeamPermissionsPersonalAndNonemptyDeletion(t *testing.T) {
	for _, operation := range []string{"rename", "delete"} {
		for _, code := range []string{"forbidden", "not_found", "personal_team_immutable", "team_not_empty", "version_conflict"} {
			t.Run(operation+"/"+code, func(t *testing.T) {
				f := newTeamFixture(t, writePlan("validateChange", operation, false)...)
				input := core.ChangeTeam{Name: "Team", Version: 1, ExpectedUserID: f.p.UserID}
				refusal := fixtureFault(code)
				if operation == "rename" {
					f.bindRename(input, model.Team{}, refusal)
					result, err := f.service.Rename(f.ctx, f.p, f.rawID, input)
					if !reflect.DeepEqual(result, model.Team{}) || err != refusal {
						t.Fatalf("rename refusal=%+v %v", result, err)
					}
				} else {
					f.bindDelete(input, refusal)
					if err := f.service.Delete(f.ctx, f.p, f.rawID, input); err != refusal {
						t.Fatalf("delete refusal=%v", err)
					}
				}
			})
		}
	}
	t.Run("member read", func(t *testing.T) {
		f := newTeamFixture(t, readPlan("get")...)
		f.p.UserID = teamFixtureTarget
		want := fixtureTeam()
		want.Membership.UserID = f.p.UserID
		want.Membership.Role = model.ProjectMemberRole
		f.bindGet(want, nil)
		got, err := f.service.Get(f.ctx, f.p, f.rawID)
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("member result=%+v %v", got, err)
		}
	})
}

func TestTeamPaginationBindsCurrentActorAndRealVersions(t *testing.T) {
	first := fixtureTeam()
	second := fixtureTeam()
	second.ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	cursor, err := query.EncodeListCursor(query.ListScope{Kind: "teams", UserID: teamFixtureActor}, first.CreatedAt, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, request := range []model.PageRequest{{Limit: 1}, {Limit: 1, Cursor: &cursor}, {Limit: 100}} {
		t.Run("page", func(t *testing.T) {
			f := newTeamFixture(t, listPlan()...)
			want := core.TeamPage{Items: []model.Team{first, second}, NextCursor: &cursor}
			f.bindList(request, want, nil)
			got, err := f.service.List(f.ctx, f.p, request)
			if err != nil || !reflect.DeepEqual(got, want) {
				t.Fatalf("Team page=%+v %v", got, err)
			}
		})
	}
	for _, request := range []model.PageRequest{{Limit: 0}, {Limit: 1, Cursor: fixturePointer("invalid")}, {Limit: 1, Cursor: &cursor}} {
		t.Run("invalid page", func(t *testing.T) {
			f := newTeamFixture(t)
			if request.Cursor == &cursor {
				f.p.UserID = teamFixtureTarget
			}
			got, err := f.service.List(f.ctx, f.p, request)
			teamFault(t, err, "invalid_input")
			if got.Items != nil || got.NextCursor != nil {
				t.Error("invalid page exposed data")
			}
		})
	}
}

func TestTeamValidationAndIdentityGuardPrecedeOperations(t *testing.T) {
	for _, test := range []struct {
		input core.CreateTeam
		code  string
	}{
		{core.CreateTeam{Name: "Good", ExpectedUserID: teamFixtureTarget}, "identity_mismatch"},
		{core.CreateTeam{Name: "", ExpectedUserID: teamFixtureActor}, "invalid_input"},
		{core.CreateTeam{Name: " \t\n\u2003\u0085", ExpectedUserID: teamFixtureActor}, "invalid_input"},
		{core.CreateTeam{Name: "bad\x00name", ExpectedUserID: teamFixtureActor}, "invalid_input"},
		{core.CreateTeam{Name: "bad\xffname", ExpectedUserID: teamFixtureActor}, "invalid_input"},
		{core.CreateTeam{Name: "valid", ExpectedUserID: ""}, "invalid_input"},
		{core.CreateTeam{Name: "valid", ExpectedUserID: strings.ToUpper("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")}, "invalid_input"},
	} {
		t.Run("create "+test.code, func(t *testing.T) {
			f := newTeamFixture(t, "validateCreate")
			refusal := fixtureFault(test.code)
			f.bindCreate(test.input, model.Team{}, nil, refusal)
			got, err := f.service.Create(f.ctx, f.p, test.input)
			if err != refusal || !reflect.DeepEqual(got, model.Team{}) {
				t.Fatalf("admission=%+v %v", got, err)
			}
		})
	}
	for _, id := range []string{"invalid", strings.ToUpper("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")} {
		for _, operation := range []string{"get", "rename"} {
			t.Run("ID "+operation+"/"+id, func(t *testing.T) {
				call := "validateRead"
				if operation == "rename" {
					call = "validateChange"
				}
				f := newTeamFixture(t, call)
				f.rawID = id
				refusal := fixtureFault("invalid_input")
				if operation == "get" {
					f.validateRead(refusal)
					_, err := f.service.Get(f.ctx, f.p, id)
					if err != refusal {
						t.Fatal(err)
					}
				} else {
					input := core.ChangeTeam{Name: "valid", Version: 1, ExpectedUserID: f.p.UserID}
					f.validateChange(input, refusal)
					_, err := f.service.Rename(f.ctx, f.p, id, input)
					if err != refusal {
						t.Fatal(err)
					}
				}
			})
		}
	}
	for _, input := range []core.ChangeTeam{{Name: "Good", Version: 1, ExpectedUserID: teamFixtureTarget}, {Name: "", Version: 1, ExpectedUserID: teamFixtureActor}, {Name: " \t\n\u2003\u0085", Version: 1, ExpectedUserID: teamFixtureActor}, {Name: "bad\x00name", Version: 1, ExpectedUserID: teamFixtureActor}, {Name: "bad\xffname", Version: 1, ExpectedUserID: teamFixtureActor}, {Name: "valid", Version: 0, ExpectedUserID: teamFixtureActor}} {
		for _, operation := range []string{"rename", "delete"} {
			t.Run(operation, func(t *testing.T) {
				f := newTeamFixture(t, "validateChange")
				refusal := fixtureFault("invalid_input")
				f.validateChange(input, refusal)
				if operation == "rename" {
					_, err := f.service.Rename(f.ctx, f.p, f.rawID, input)
					if err != refusal {
						t.Fatal(err)
					}
				} else if err := f.service.Delete(f.ctx, f.p, f.rawID, input); err != refusal {
					t.Fatal(err)
				}
			})
		}
	}
	t.Run("unauthenticated list", func(t *testing.T) {
		f := newTeamFixture(t)
		f.p = model.Principal{}
		_, err := f.service.List(f.ctx, f.p, model.PageRequest{Limit: 1})
		teamFault(t, err, "unauthenticated")
	})
	for _, operation := range []string{"create", "get"} {
		t.Run("unauthenticated "+operation, func(t *testing.T) {
			f := newTeamFixture(t, "validateRead")
			f.p = model.Principal{}
			refusal := fixtureFault("unauthenticated")
			if operation == "get" {
				f.validateRead(refusal)
				_, err := f.service.Get(f.ctx, f.p, f.rawID)
				if err != refusal {
					t.Fatal(err)
				}
			} else {
				f.want = []string{"validateCreate"}
				input := core.CreateTeam{Name: "valid", ExpectedUserID: teamFixtureActor}
				f.bindCreate(input, model.Team{}, nil, refusal)
				_, err := f.service.Create(f.ctx, f.p, input)
				if err != refusal {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestTeamMetadataVersionExhaustionAndFaultPriority(t *testing.T) {
	for _, code := range []string{"", "version_exhausted"} {
		t.Run(code, func(t *testing.T) {
			f := newTeamFixture(t, writePlan("validateChange", "rename", false)...)
			input := core.ChangeTeam{Name: "Full", Version: math.MaxInt64, ExpectedUserID: f.p.UserID}
			want := fixtureTeam()
			want.Version = math.MaxInt64
			var refusal error
			if code != "" {
				input.Name = "Changed"
				refusal = fixtureFault(code)
				want = model.Team{}
			}
			f.bindRename(input, want, refusal)
			got, err := f.service.Rename(f.ctx, f.p, f.rawID, input)
			if err != refusal || !reflect.DeepEqual(got, want) {
				t.Fatalf("exhaustion result=%+v %v", got, err)
			}
		})
	}
}
