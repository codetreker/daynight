package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/google/uuid"
)

func TestTeamMembersHTTP(t *testing.T) {
	h := authTestHarness(t)
	logger := slog.New(slog.NewJSONHandler(&h.logs, nil))
	mux := http.NewServeMux()
	h.auth.RegisterRoutes(mux)
	teamRoutes(mux, service.NewTeams(h.database), h.auth, logger)
	h.handler = RequestLogging(logger, mux)
	admin, member, outsider := h.login(t, "members-admin"), h.login(t, "members-member"), h.login(t, "members-outsider")
	a, m, o := []*http.Cookie{admin}, []*http.Cookie{member}, []*http.Cookie{outsider}
	me := func(c []*http.Cookie) api.User {
		return decodeResponse[api.User](t, h.request("GET", "/api/v1/me", "", c, nil, ""), 200)
	}
	au, mu, ou := me(a), me(m), me(o)
	team := decodeResponse[api.Team](t, h.request("POST", "/api/v1/teams", jsonBody(t, api.CreateTeamRequest{Name: "Members", ExpectedUserID: au.ID}), a, nil, h.auth.origin), 201)
	base := "/api/v1/teams/" + team.ID + "/members"
	invite := func() api.TeamMember {
		created := decodeResponse[api.CreatedTeamInvitation](t, h.request("POST", "/api/v1/teams/"+team.ID+"/invitations", jsonBody(t, api.ProjectInvitationMutationRequest{ExpectedUserID: au.ID}), a, nil, h.auth.origin), 201)
		link, err := url.Parse(created.Link)
		if err != nil {
			t.Fatal(err)
		}
		accepted := decodeResponse[api.TeamInvitationAcceptance](t, h.request("POST", "/api/v1/team-invitations/accept", jsonBody(t, api.AcceptProjectInvitationRequest{Token: link.Fragment, ExpectedUserID: mu.ID}), m, nil, h.auth.origin), 200)
		if !accepted.Joined {
			t.Fatal("member was not joined")
		}
		return accepted.Membership
	}
	memberRow := invite()
	list := decodeResponse[api.TeamMemberList](t, h.request("GET", base, "", m, nil, ""), 200)
	if len(list.Items) != 2 || list.Items[1].UserID != mu.ID || list.Items[1].Profile.Name != nil || list.Items[1].Profile.Email != nil || list.Items[1].Profile.AvatarURL != nil {
		t.Fatalf("directory: %#v", list)
	}
	assertProjectError(t, h.request("GET", base, "", o, nil, ""), 404, "not_found")
	change := api.SetTeamMemberRoleRequest{Version: memberRow.Version, Role: "admin", ExpectedUserID: mu.ID}
	assertProjectError(t, h.request("PATCH", base+"/"+au.ID, jsonBody(t, change), m, nil, h.auth.origin), 403, "forbidden")
	change.ExpectedUserID = ou.ID
	assertProjectError(t, h.request("PATCH", base+"/"+mu.ID, jsonBody(t, change), a, nil, h.auth.origin), 409, "identity_mismatch")
	assertProjectError(t, h.request("DELETE", base+"/"+mu.ID, jsonBody(t, api.RemoveTeamMemberRequest{Version: memberRow.Version, ExpectedUserID: ou.ID}), a, nil, h.auth.origin), 409, "identity_mismatch")
	afterMismatch := decodeResponse[api.TeamMemberList](t, h.request("GET", base, "", m, nil, ""), 200)
	if !reflect.DeepEqual(list, afterMismatch) {
		t.Fatal("identity mismatch changed member rows")
	}
	change.ExpectedUserID = au.ID
	change.Version++
	assertProjectError(t, h.request("PATCH", base+"/"+mu.ID, jsonBody(t, change), a, nil, h.auth.origin), 409, "version_conflict")
	change.Version = memberRow.Version
	promoted := decodeResponse[api.TeamMemberRoleReceipt](t, h.request("PATCH", base+"/"+mu.ID, jsonBody(t, change), a, nil, h.auth.origin), 200)
	if promoted.Membership.Role != "admin" || promoted.Membership.Version <= memberRow.Version || promoted.ActorRole == nil || *promoted.ActorRole != "admin" {
		t.Fatalf("promoted: %#v", promoted)
	}
	assertProjectError(t, h.request("PATCH", base+"/"+mu.ID, jsonBody(t, api.SetTeamMemberRoleRequest{Version: memberRow.Version, Role: "admin", ExpectedUserID: au.ID}), a, nil, h.auth.origin), 409, "version_conflict")
	unchanged := decodeResponse[api.TeamMemberRoleReceipt](t, h.request("PATCH", base+"/"+mu.ID, jsonBody(t, api.SetTeamMemberRoleRequest{Version: promoted.Membership.Version, Role: "admin", ExpectedUserID: au.ID}), a, nil, h.auth.origin), 200)
	if !reflect.DeepEqual(promoted, unchanged) {
		t.Fatal("no-op changed member")
	}
	// Admin removal does not change independent project grants.
	var projectID string
	err := h.database.Pool.QueryRow(context.Background(), `INSERT INTO projects(id,name,repo_url) VALUES($1,'p','https://example.test/repo') RETURNING id::text`, uuid.NewString()).Scan(&projectID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.database.Pool.Exec(context.Background(), `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, projectID, team.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.database.Pool.Exec(context.Background(), `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, projectID, mu.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = h.database.Pool.Exec(context.Background(), `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, projectID, ou.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, h.request("GET", base, "", o, nil, ""), 404, "not_found")
	var before, after string
	if err = h.database.Pool.QueryRow(context.Background(), `SELECT row_to_json(g)::text FROM project_grants g WHERE project_id=$1 AND user_id=$2`, projectID, mu.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	demoted := decodeResponse[api.TeamMemberRoleReceipt](t, h.request("PATCH", base+"/"+mu.ID, jsonBody(t, api.SetTeamMemberRoleRequest{Version: promoted.Membership.Version, Role: "member", ExpectedUserID: mu.ID}), m, nil, h.auth.origin), 200)
	if demoted.ActorRole == nil || *demoted.ActorRole != "member" {
		t.Fatalf("self demotion: %#v", demoted)
	}
	if err = h.database.Pool.QueryRow(context.Background(), `SELECT row_to_json(g)::text FROM project_grants g WHERE project_id=$1 AND user_id=$2`, projectID, mu.ID).Scan(&after); err != nil || before != after {
		t.Fatalf("grant changed on role change %v", err)
	}
	promoted = decodeResponse[api.TeamMemberRoleReceipt](t, h.request("PATCH", base+"/"+mu.ID, jsonBody(t, api.SetTeamMemberRoleRequest{Version: demoted.Membership.Version, Role: "admin", ExpectedUserID: au.ID}), a, nil, h.auth.origin), 200)
	removed := decodeResponse[api.RemoveTeamMemberReceipt](t, h.request("DELETE", base+"/"+mu.ID, jsonBody(t, api.RemoveTeamMemberRequest{Version: promoted.Membership.Version, ExpectedUserID: au.ID}), a, nil, h.auth.origin), 200)
	if !removed.Removed || removed.ActorRole == nil || *removed.ActorRole != "admin" || removed.UserID != mu.ID {
		t.Fatalf("receipt: %#v", removed)
	}
	if err = h.database.Pool.QueryRow(context.Background(), `SELECT row_to_json(g)::text FROM project_grants g WHERE project_id=$1 AND user_id=$2`, projectID, mu.ID).Scan(&after); err != nil || before != after {
		t.Fatalf("grant changed %q %q %v", before, after, err)
	}
	rejoined := invite()
	if rejoined.Version <= promoted.Membership.Version {
		t.Fatalf("ABA %d <= %d", rejoined.Version, promoted.Membership.Version)
	}
	assertProjectError(t, h.request("DELETE", base+"/"+mu.ID, jsonBody(t, api.RemoveTeamMemberRequest{Version: promoted.Membership.Version, ExpectedUserID: au.ID}), a, nil, h.auth.origin), 409, "version_conflict")
	self := decodeResponse[api.RemoveTeamMemberReceipt](t, h.request("DELETE", base+"/"+mu.ID, jsonBody(t, api.RemoveTeamMemberRequest{Version: rejoined.Version, ExpectedUserID: mu.ID}), m, nil, h.auth.origin), 200)
	if self.ActorRole != nil || !self.Removed {
		t.Fatalf("self exit: %#v", self)
	}
	if err = h.database.Pool.QueryRow(context.Background(), `SELECT row_to_json(g)::text FROM project_grants g WHERE project_id=$1 AND user_id=$2`, projectID, mu.ID).Scan(&after); err != nil || before != after {
		t.Fatalf("grant changed on exit %v", err)
	}
	assertProjectError(t, h.request("DELETE", base+"/"+au.ID, jsonBody(t, api.RemoveTeamMemberRequest{Version: team.Membership.Version, ExpectedUserID: au.ID}), a, nil, h.auth.origin), 409, "last_admin")
	personal := decodeResponse[api.TeamPage](t, h.request("GET", "/api/v1/teams", "", a, nil, ""), 200).Items[0]
	personalPath := "/api/v1/teams/" + personal.ID + "/members/" + au.ID
	for _, method := range []string{"PATCH", "DELETE"} {
		body := jsonBody(t, api.RemoveTeamMemberRequest{Version: personal.Membership.Version, ExpectedUserID: au.ID})
		if method == "PATCH" {
			body = jsonBody(t, api.SetTeamMemberRoleRequest{Version: personal.Membership.Version, Role: "member", ExpectedUserID: au.ID})
		}
		assertProjectError(t, h.request(method, personalPath, body, a, nil, h.auth.origin), 409, "personal_team_immutable")
	}
	for _, bad := range []string{`{"version":null,"role":"member","expectedUserId":"` + au.ID + `"}`, `{"version":1,"role":"other","expectedUserId":"` + au.ID + `"}`, `{"version":1,"role":"member","extra":1,"expectedUserId":"` + au.ID + `"}`} {
		assertProjectError(t, h.request("PATCH", base+"/"+au.ID, bad, a, nil, h.auth.origin), 400, "invalid_input")
	}
	assertProjectError(t, h.request("GET", base+"?limit=1", "", a, nil, ""), 400, "invalid_input")
	// Exact int64 versions survive JSON decoding and are compared before a no-op.
	const precise int64 = 9007199254740993
	_, err = h.database.Pool.Exec(context.Background(), `UPDATE team_members SET version=$3 WHERE team_id=$1 AND user_id=$2`, team.ID, au.ID, precise)
	if err != nil {
		t.Fatal(err)
	}
	exact := h.request("PATCH", base+"/"+au.ID, jsonBody(t, api.SetTeamMemberRoleRequest{Version: precise, Role: "admin", ExpectedUserID: au.ID}), a, nil, h.auth.origin)
	exactReceipt := decodeResponse[api.TeamMemberRoleReceipt](t, exact, 200)
	if exactReceipt.Membership.Version != precise || !strings.Contains(exact.Body.String(), `"version":9007199254740993`) {
		t.Fatalf("rounded version: %s", exact.Body)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	principal := core.Principal{Kind: core.SessionCredential, CredentialID: uuid.NewString(), UserID: au.ID}
	_, err = service.NewTeams(h.database).SetMemberRole(canceled, principal, team.ID, au.ID, service.ChangeTeamMember{Version: precise, Role: core.ProjectMemberRole, ExpectedUserID: au.ID})
	if err == nil {
		t.Fatal("canceled operation succeeded")
	}
	var currentVersion int64
	var currentRole string
	if err = h.database.Pool.QueryRow(context.Background(), `SELECT version,role FROM team_members WHERE team_id=$1 AND user_id=$2`, team.ID, au.ID).Scan(&currentVersion, &currentRole); err != nil || currentVersion != precise || currentRole != "admin" {
		t.Fatalf("canceled write changed row: %d %s %v", currentVersion, currentRole, err)
	}
	// A broken user reference must fail the whole directory rather than hiding a member.
	_, err = h.database.Pool.Exec(context.Background(), `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, team.ID, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, h.request("GET", base, "", a, nil, ""), 500, "internal_error")
	if strings.Contains(h.logs.String(), "github:members") {
		t.Fatal("profile source leaked")
	}
}

func TestTeamMembersConcurrentLastAdmin(t *testing.T) {
	h := authTestHarness(t)
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	mux := http.NewServeMux()
	h.auth.RegisterRoutes(mux)
	teamRoutes(mux, service.NewTeams(h.database), h.auth, logger)
	h.handler = mux
	a, b := h.login(t, "concurrent-a"), h.login(t, "concurrent-b")
	ac, bc := []*http.Cookie{a}, []*http.Cookie{b}
	au := decodeResponse[api.User](t, h.request("GET", "/api/v1/me", "", ac, nil, ""), 200)
	bu := decodeResponse[api.User](t, h.request("GET", "/api/v1/me", "", bc, nil, ""), 200)
	s := service.NewTeams(h.database)
	pa := core.Principal{Kind: core.SessionCredential, CredentialID: uuid.NewString(), UserID: au.ID}
	pb := core.Principal{Kind: core.SessionCredential, CredentialID: uuid.NewString(), UserID: bu.ID}
	for _, remove := range []bool{false, true} {
		team, err := s.Create(context.Background(), pa, service.CreateTeam{Name: "race", ExpectedUserID: au.ID})
		if err != nil {
			t.Fatal(err)
		}
		created := decodeResponse[api.CreatedTeamInvitation](t, h.request("POST", "/api/v1/teams/"+team.ID+"/invitations", jsonBody(t, api.ProjectInvitationMutationRequest{ExpectedUserID: au.ID}), ac, nil, h.auth.origin), 201)
		link, err := url.Parse(created.Link)
		if err != nil {
			t.Fatal(err)
		}
		joined := decodeResponse[api.TeamInvitationAcceptance](t, h.request("POST", "/api/v1/team-invitations/accept", jsonBody(t, api.AcceptProjectInvitationRequest{Token: link.Fragment, ExpectedUserID: bu.ID}), bc, nil, h.auth.origin), 200)
		promoted, err := s.SetMemberRole(context.Background(), pa, team.ID, bu.ID, service.ChangeTeamMember{Version: joined.Membership.Version, Role: core.ProjectAdmin, ExpectedUserID: au.ID})
		if err != nil {
			t.Fatal(err)
		}
		bv := promoted.Membership.Version
		start := make(chan struct{})
		errs := make([]error, 2)
		var wg sync.WaitGroup
		for i, p := range []core.Principal{pa, pb} {
			i, p := i, p
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				v := team.Membership.Version
				if i == 1 {
					v = bv
				}
				input := service.ChangeTeamMember{Version: v, Role: core.ProjectMemberRole, ExpectedUserID: p.UserID}
				if remove {
					_, errs[i] = s.RemoveMember(context.Background(), p, team.ID, p.UserID, input)
				} else {
					_, errs[i] = s.SetMemberRole(context.Background(), p, team.ID, p.UserID, input)
				}
			}()
		}
		close(start)
		wg.Wait()
		successes, refusals := 0, 0
		for _, err := range errs {
			if err == nil {
				successes++
				continue
			}
			var fault *service.Fault
			if errors.As(err, &fault) && fault.Code == "last_admin" {
				refusals++
				continue
			}
			t.Fatalf("unexpected result %v", err)
		}
		if successes != 1 || refusals != 1 {
			t.Fatalf("results %v", errs)
		}
		var count int
		if err = h.database.Pool.QueryRow(context.Background(), `SELECT count(*) FROM team_members WHERE team_id=$1 AND role='admin'`, team.ID).Scan(&count); err != nil || count != 1 {
			t.Fatalf("admins %d %v", count, err)
		}
	}
}
