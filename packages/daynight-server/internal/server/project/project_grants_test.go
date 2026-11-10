package project

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
)

func TestProjectGrantHTTPReceiptsAndIdentity(t *testing.T) {
	for _, version := range []*int64{nil, ptrGrantVersion(9007199254740993)} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			h := newHTTPHarness(t)
			check := membershipExpectation(t, h, h.Project.ID)
			grant := membershipGrant(h, 9007199254740994, model.ProjectMemberRole)
			access := membershipAccess(h, &grant)
			h.Memberships.SetGrantFunc = func(ctx context.Context, p model.Principal, project, user string, input coreproject.SetProjectGrant) (coreproject.SetGrantResult, error) {
				check(ctx, p, project)
				if user != p.UserID || input.Role != model.ProjectMemberRole || input.ExpectedUserID != p.UserID || (version == nil) != (input.Version == nil) || version != nil && *version != *input.Version {
					t.Fatalf("grant input: %q %+v", user, input)
				}
				return coreproject.SetGrantResult{Grant: grant, ActorAccess: &access}, nil
			}
			encodedVersion := "null"
			if version != nil {
				encodedVersion = fmt.Sprint(*version)
			}
			response := membershipCall(t, h, "PUT", "/api/v1/projects/"+h.Project.ID+"/grants/"+h.Principal.UserID, fmt.Sprintf(`{"version":%s,"role":"member","expectedUserId":%q}`, encodedVersion, h.Principal.UserID))
			result := decodeResponse[api.ProjectGrantResult](t, response, 200)
			if result.Grant.Version != grant.Version || result.Grant.Role != "member" || result.Grant.ProjectID != h.Project.ID || result.Grant.UserID != h.Principal.UserID || result.ActorAccess == nil || result.ActorAccess.EffectiveRole != "admin" || result.ActorAccess.DirectGrant == nil || result.ActorAccess.DirectGrant.Version != grant.Version || response.Header().Get("Daynight-User-ID") != h.Principal.UserID || response.Header().Get("Cache-Control") != "no-store" || !strings.Contains(response.Body.String(), `"version":9007199254740994`) {
				t.Fatalf("grant receipt: %+v %s %v", result, response.Body, response.Header())
			}
			if !strings.Contains(h.Logs.String(), `"component":"project_grant"`) || !strings.Contains(h.Logs.String(), `"outcome":"success"`) {
				t.Fatalf("grant success log: %s", &h.Logs)
			}
			h.assertCalls(map[string]int{"SetGrant": 1})
		})
	}
	for _, retained := range []bool{false, true} {
		t.Run(fmt.Sprintf("remove/retained=%v", retained), func(t *testing.T) {
			h := newHTTPHarness(t)
			check := membershipExpectation(t, h, h.Project.ID)
			var access *model.ProjectAccess
			if retained {
				value := membershipAccess(h, nil)
				access = &value
			}
			h.Memberships.RemoveGrantFunc = func(ctx context.Context, p model.Principal, project, user string, input coreproject.RemoveProjectMember) (coreproject.RemoveGrantResult, error) {
				check(ctx, p, project)
				if user != p.UserID || input != (coreproject.RemoveProjectMember{Version: 8, ExpectedUserID: p.UserID}) {
					t.Fatalf("remove: %q %+v", user, input)
				}
				return coreproject.RemoveGrantResult{ProjectID: project, UserID: user, ActorAccess: access}, nil
			}
			response := membershipCall(t, h, "DELETE", "/api/v1/projects/"+h.Project.ID+"/grants/"+h.Principal.UserID, memberRemovalBody(t, 8, h.Principal.UserID))
			result := decodeResponse[api.RemoveProjectGrantResult](t, response, 200)
			if !result.Deleted || result.ProjectID != h.Project.ID || result.UserID != h.Principal.UserID || response.Header().Get("Daynight-User-ID") != h.Principal.UserID || response.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("remove receipt: %+v %v", result, response.Header())
			}
			if retained {
				if result.ActorAccess == nil || result.ActorAccess.EffectiveRole != "admin" || result.ActorAccess.DirectGrant != nil {
					t.Fatalf("retained access: %+v", result)
				}
			} else if result.ActorAccess != nil || !strings.Contains(response.Body.String(), `"actorAccess":null`) {
				t.Fatalf("lost access: %s", response.Body)
			}
			h.assertCalls(map[string]int{"RemoveGrant": 1})
		})
	}
}

func ptrGrantVersion(value int64) *int64 { return &value }

func TestProjectGrantHTTPStrictVersion(t *testing.T) {
	h := newHTTPHarness(t)
	path := "/api/v1/projects/" + h.Project.ID + "/grants/" + h.Principal.UserID
	for _, value := range []string{``, `,"version":0`, `,"version":-1`, `,"version":1.0`, `,"version":9223372036854775808`, `,"version":"1"`, `,"version":true`} {
		body := fmt.Sprintf(`{"role":"member","expectedUserId":%q%s}`, h.Principal.UserID, value)
		assertProjectError(t, membershipCall(t, h, "PUT", path, body), 400, "invalid_input")
	}
	for _, value := range []string{`null`, `0`, `1.0`, `9223372036854775808`} {
		body := fmt.Sprintf(`{"version":%s,"expectedUserId":%q}`, value, h.Principal.UserID)
		assertProjectError(t, membershipCall(t, h, "DELETE", path, body), 400, "invalid_input")
	}
	for _, method := range []string{"PUT", "DELETE"} {
		body := fmt.Sprintf(`{"version":1,"expectedUserId":%q}`, h.Principal.UserID)
		if method == "PUT" {
			body = fmt.Sprintf(`{"version":null,"role":"member","expectedUserId":%q}`, h.Principal.UserID)
		}
		assertProjectError(t, membershipCall(t, h, method, path+"?extra=true", body), 400, "invalid_input")
	}
	response := membershipCall(t, h, "POST", path, `{}`)
	if response.Code != 405 || response.Header().Get("Allow") != "PUT, DELETE" {
		t.Fatalf("method: %d %v", response.Code, response.Header())
	}
	h.assertCalls(map[string]int{})
}

func TestProjectGrantHTTPRefusals(t *testing.T) {
	for _, method := range []string{"PUT", "DELETE"} {
		for _, fault := range []struct {
			code   string
			status int
		}{{"identity_mismatch", 409}, {"version_conflict", 409}, {"not_found", 404}, {"forbidden", 403}, {"invalid_input", 400}} {
			t.Run(method+"/"+fault.code, func(t *testing.T) {
				h := newHTTPHarness(t)
				check := membershipExpectation(t, h, h.Project.ID)
				failure := &model.Fault{Code: fault.code, Message: "Project mutation was refused."}
				expected := "00000000-0000-4000-8000-000000000075"
				body := memberRemovalBody(t, 9, expected)
				if method == "PUT" {
					body = memberRoleBody(t, 9, "admin", expected)
					h.Memberships.SetGrantFunc = func(ctx context.Context, p model.Principal, project, user string, input coreproject.SetProjectGrant) (coreproject.SetGrantResult, error) {
						check(ctx, p, project)
						if user != p.UserID || input.Version == nil || *input.Version != 9 || input.Role != model.ProjectAdmin || input.ExpectedUserID != expected {
							t.Fatalf("refused input: %q %+v", user, input)
						}
						return coreproject.SetGrantResult{}, failure
					}
				} else {
					h.Memberships.RemoveGrantFunc = func(ctx context.Context, p model.Principal, project, user string, input coreproject.RemoveProjectMember) (coreproject.RemoveGrantResult, error) {
						check(ctx, p, project)
						if user != p.UserID || input != (coreproject.RemoveProjectMember{Version: 9, ExpectedUserID: expected}) {
							t.Fatalf("refused remove: %q %+v", user, input)
						}
						return coreproject.RemoveGrantResult{}, failure
					}
				}
				response := membershipCall(t, h, method, "/api/v1/projects/"+h.Project.ID+"/grants/"+h.Principal.UserID, body)
				assertProjectError(t, response, fault.status, fault.code)
				if response.Header().Get("Daynight-User-ID") != h.Principal.UserID || !strings.Contains(h.Logs.String(), `"outcome":"refused"`) || !strings.Contains(h.Logs.String(), `"error_code":"`+fault.code+`"`) {
					t.Fatalf("refusal identity/log: %v %s", response.Header(), &h.Logs)
				}
			})
		}
	}
}
