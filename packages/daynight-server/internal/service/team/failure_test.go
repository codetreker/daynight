package team

import (
	"errors"
	"fmt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/jackc/pgx/v5/pgconn"
	"math"
	"reflect"
	"strings"
	"testing"
)

func TestWritesRetainCurrentActorRefusals(t *testing.T) {
	for _, method := range []string{"rename", "delete", "set_role", "remove"} {
		for _, change := range []string{"demote", "remove"} {
			t.Run(method+"/"+change, func(t *testing.T) {
				validation, operation := "validateMember", "changeMember"
				if method == "rename" || method == "delete" {
					validation = "validateChange"
					operation = method
				}
				f := newTeamFixture(t, writePlan(validation, operation, false)...)
				code := "forbidden"
				if change == "remove" {
					code = "not_found"
				}
				refusal := fixtureFault(code)
				var err error
				switch method {
				case "rename":
					input := core.ChangeTeam{Name: "Changed", Version: 1, ExpectedUserID: f.p.UserID}
					f.bindRename(input, model.Team{}, refusal)
					got, e := f.service.Rename(f.ctx, f.p, f.rawID, input)
					err = e
					if !reflect.DeepEqual(got, model.Team{}) {
						t.Error("refused rename exposed result")
					}
				case "delete":
					input := core.ChangeTeam{Name: "Original", Version: 1, ExpectedUserID: f.p.UserID}
					f.bindDelete(input, refusal)
					err = f.service.Delete(f.ctx, f.p, f.rawID, input)
				default:
					input := core.ChangeTeamMember{Version: 3, ExpectedUserID: f.p.UserID}
					remove := method == "remove"
					if !remove {
						input.Role = model.ProjectAdmin
					}
					f.bindChangeMember(input, remove, core.TeamMemberResult{}, refusal)
					var got core.TeamMemberResult
					if remove {
						got, err = f.service.RemoveMember(f.ctx, f.p, f.rawID, f.target, input)
					} else {
						got, err = f.service.SetMemberRole(f.ctx, f.p, f.rawID, f.target, input)
					}
					if !reflect.DeepEqual(got, core.TeamMemberResult{}) {
						t.Error("refused member write exposed result")
					}
				}
				if err != refusal {
					t.Fatalf("current actor refusal changed: %v", err)
				}
			})
		}
	}
}
func TestTeamsQueryFailureIsNotAnEmptyPage(t *testing.T) {
	f := newTeamFixture(t, listPlan()...)
	cause := &pgconn.PgError{Code: "42P01", Message: "declared missing teams relation"}
	request := model.PageRequest{Limit: 10}
	f.bindList(request, core.TeamPage{Items: []model.Team{fixtureTeam()}}, cause)
	f.readCallbackError = cause
	f.readError = cause
	got, err := f.service.List(f.ctx, f.p, request)
	var pgError *pgconn.PgError
	if err != cause || !errors.As(err, &pgError) || pgError.Code != "42P01" || got.Items != nil || got.NextCursor != nil {
		t.Fatalf("query failure became empty success: %+v %v", got, err)
	}
}
func TestRenameMetadataLimitPreservesAuthorizationAndVersionPriority(t *testing.T) {
	name := strings.Repeat("a", 257)
	for _, test := range []struct {
		code                        string
		version                     int64
		member, outsider, preflight bool
	}{
		{code: "version_conflict", version: 2}, {code: "forbidden", version: 1, member: true}, {code: "not_found", version: 1, outsider: true}, {code: "identity_mismatch", version: 1, preflight: true}, {code: "invalid_input", version: 1}, {code: "version_exhausted", version: math.MaxInt64},
	} {
		t.Run(test.code, func(t *testing.T) {
			plan := writePlan("validateChange", "rename", false)
			if test.preflight {
				plan = []string{"validateChange"}
			}
			f := newTeamFixture(t, plan...)
			if test.member {
				f.p.UserID = teamFixtureTarget
			}
			if test.outsider {
				f.p.UserID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
			}
			input := core.ChangeTeam{Name: name, Version: test.version, ExpectedUserID: f.p.UserID}
			refusal := fixtureFault(test.code)
			if test.preflight {
				input.ExpectedUserID = teamFixtureTarget
				f.validateChange(input, refusal)
			} else {
				f.bindRename(input, model.Team{}, refusal)
			}
			got, err := f.service.Rename(f.ctx, f.p, f.rawID, input)
			if err != refusal || !reflect.DeepEqual(got, model.Team{}) {
				t.Fatalf("metadata priority result=%+v %v", got, err)
			}
		})
	}
}
func TestTeamRemovalSuppressesResultsWhenEligibilityFails(t *testing.T) {
	f := newTeamFixture(t, writePlan("validateMember", "changeMember", true)...)
	input := core.ChangeTeamMember{Version: 9007199254740995, ExpectedUserID: f.p.UserID}
	cause := errors.New("project ownership integrity failed")
	failure := fmt.Errorf("eligibility refresh: %w", cause)
	result := core.TeamMemberResult{Membership: fixtureMember().Membership, ActorRole: fixturePointer(model.ProjectAdmin)}
	f.bindChangeMember(input, true, result, nil)
	f.bindRefresh(store.WebhookEligibilityFilter{TeamID: f.id, UserID: f.target}, failure)
	f.writeCallbackError = failure
	f.writeError = failure
	got, err := f.service.RemoveMember(f.ctx, f.p, f.rawID, f.target, input)
	if err != failure || !errors.Is(err, cause) || !reflect.DeepEqual(got, core.TeamMemberResult{}) {
		t.Fatalf("eligibility failure lost cause/exposed result: %+v %v", got, err)
	}
}
