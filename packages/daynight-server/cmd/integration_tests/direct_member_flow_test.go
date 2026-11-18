//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
)

func serverAPIDirectMemberNormalFlow(t *testing.T, f *fixture) {
	t.Helper()
	team := requestJSON[api.Team](t, f, http.MethodPost, "/api/v1/teams", api.CreateTeamRequest{Name: "Direct member integration", ExpectedUserID: f.userID}, http.StatusCreated)
	if team.ID == "" || team.Kind != "ordinary" || team.Membership.UserID != f.userID || team.Membership.Role != "admin" {
		t.Fatalf("created Team or actor membership differs: %+v", team)
	}
	name, avatar := "  External target "+uuid.NewString()+"  ", "data:image/png;base64,dGFyZ2V0"
	externalID := "integration:" + uuid.NewString()
	path := "/api/v1/teams/" + team.ID
	added := requestJSON[api.AddTeamMemberReceipt](t, f, http.MethodPost, path+"/members", map[string]any{
		"expectedUserId": f.userID,
		"user":           map[string]any{"externalUserId": externalID, "profile": map[string]any{"name": name, "avatarUrl": avatar}},
		"role":           "admin",
	}, http.StatusOK)
	member := added.Membership
	parsed, err := uuid.Parse(member.UserID)
	if err != nil || parsed == uuid.Nil || parsed.String() != member.UserID || member.UserID == f.userID || member.TeamID != team.ID || member.Role != "admin" || member.Version < 1 || member.CreatedAt.IsZero() || member.UpdatedAt.IsZero() || !added.Added || added.ActorRole != "admin" {
		t.Fatalf("direct member receipt differs: %+v", added)
	}
	search := requestJSON[struct {
		Items []struct {
			UserID  string                        `json:"userId"`
			Profile api.ProjectParticipantProfile `json:"profile"`
		} `json:"items"`
		NextCursor *string `json:"nextCursor"`
		ActorRole  string  `json:"actorRole"`
	}](t, f, http.MethodPost, path+"/member-candidates/search", map[string]any{"expectedUserId": f.userID, "query": strings.TrimSpace(name)}, http.StatusOK)
	if len(search.Items) != 1 || search.Items[0].UserID != member.UserID || search.Items[0].Profile.Name == nil || *search.Items[0].Profile.Name != name || search.Items[0].Profile.Email != nil || search.Items[0].Profile.AvatarURL == nil || *search.Items[0].Profile.AvatarURL != avatar || search.NextCursor != nil || search.ActorRole != "admin" {
		t.Fatalf("candidate search differs: %+v", search)
	}
	// Search identifies an account initialized independently of the destination Team.
	destination := requestJSON[api.Team](t, f, http.MethodPost, "/api/v1/teams", api.CreateTeamRequest{Name: "Existing account destination", ExpectedUserID: f.userID}, http.StatusCreated)
	project := requestJSON[api.Project](t, f, http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: "Existing account access", RepoURL: "https://github.com/example/existing-account", TeamID: &destination.ID, ExpectedUserID: f.userID}, http.StatusCreated)
	plain := &http.Client{Timeout: 5 * time.Second}
	defer plain.CloseIdleConnections()
	body, err := json.Marshal(map[string]any{"externalUserId": externalID})
	if err != nil {
		t.Fatal(err)
	}
	_, tokenData := applicationRequest(t, f, plain, "/api/v1/oauth/s2s/token", string(body), "application/json", "S2S "+f.s2sSharedKey)
	var tokens applicationTokens
	if err := json.Unmarshal(tokenData, &tokens); err != nil || tokens.UserID != member.UserID {
		t.Fatal("target credential did not identify existing account")
	}
	target := *f
	transport := http.DefaultTransport.(*http.Transport).Clone()
	defer transport.CloseIdleConnections()
	target.client = &http.Client{Timeout: 5 * time.Second, Transport: tokenTransport{token: tokens.AccessToken, next: transport}}
	target.userID = member.UserID
	directProject := requestJSON[api.Project](t, f, http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: "Direct project member", RepoURL: "https://github.com/example/direct-project-member", TeamID: &destination.ID, ExpectedUserID: f.userID}, http.StatusCreated)
	directPath := "/api/v1/projects/" + directProject.ID
	teamBefore := requestJSON[api.TeamMemberList](t, f, http.MethodGet, "/api/v1/teams/"+destination.ID+"/members", nil, http.StatusOK)
	requestJSON[api.ProjectDocument](t, &target, http.MethodGet, directPath, nil, http.StatusNotFound)
	type directReceipt struct {
		Added       bool                   `json:"added"`
		Participant api.ProjectParticipant `json:"participant"`
		ActorAccess api.ProjectAccess      `json:"actorAccess"`
	}
	direct := requestJSON[directReceipt](t, f, http.MethodPost, directPath+"/members/"+member.UserID, map[string]any{"expectedUserId": f.userID}, http.StatusOK)
	if !direct.Added || direct.Participant.UserID != member.UserID || direct.Participant.EffectiveRole != "member" || direct.Participant.InheritedFrom != nil || direct.Participant.DirectGrant == nil || direct.Participant.DirectGrant.Role != "member" || direct.ActorAccess.EffectiveRole != "admin" {
		t.Fatalf("direct project receipt differs: %+v", direct)
	}
	directAccess := requestJSON[api.ProjectDocument](t, &target, http.MethodGet, directPath, nil, http.StatusOK).Access
	if directAccess.EffectiveRole != "member" || directAccess.TeamRole != nil || directAccess.DirectGrant == nil || !reflect.DeepEqual(*directAccess.DirectGrant, *direct.Participant.DirectGrant) {
		t.Fatalf("direct project access differs: %+v", directAccess)
	}
	roster := requestJSON[api.ProjectParticipantList](t, f, http.MethodGet, directPath+"/members", nil, http.StatusOK)
	if actual := expectID(t, roster.Items, member.UserID, func(item api.ProjectParticipant) string { return item.UserID }); !reflect.DeepEqual(actual, direct.Participant) {
		t.Fatal("project roster did not retain the direct receipt")
	}
	again := requestJSON[directReceipt](t, f, http.MethodPost, directPath+"/members/"+member.UserID, map[string]any{"expectedUserId": f.userID}, http.StatusOK)
	if again.Added || !reflect.DeepEqual(again.Participant, direct.Participant) {
		t.Fatalf("repeated direct project receipt differs: %+v", again)
	}
	teamAfter := requestJSON[api.TeamMemberList](t, f, http.MethodGet, "/api/v1/teams/"+destination.ID+"/members", nil, http.StatusOK)
	if !reflect.DeepEqual(teamBefore, teamAfter) {
		t.Fatal("direct project addition changed Team membership")
	}
	requestJSON[api.ProjectDocument](t, &target, http.MethodGet, "/api/v1/projects/"+project.ID, nil, http.StatusNotFound)
	invitation := requestJSON[api.CreatedProjectInvitation](t, f, http.MethodPost, "/api/v1/projects/"+project.ID+"/invitations", api.ProjectInvitationMutationRequest{ExpectedUserID: f.userID}, http.StatusCreated)
	_, token, ok := strings.Cut(invitation.Link, "#")
	if !ok || token == "" {
		t.Fatal("invitation token missing")
	}
	accepted := requestJSON[api.ProjectInvitationAcceptance](t, &target, http.MethodPost, "/api/v1/invitations/accept", api.AcceptProjectInvitationRequest{Token: token, ExpectedUserID: member.UserID}, http.StatusOK)
	grant := requestJSON[api.ProjectGrantResult](t, f, http.MethodPut, "/api/v1/projects/"+project.ID+"/grants/"+member.UserID, api.SetProjectGrantRequest{Version: &accepted.DirectGrant.Version, Role: "admin", ExpectedUserID: f.userID}, http.StatusOK).Grant
	beforeAccess := requestJSON[api.ProjectDocument](t, &target, http.MethodGet, "/api/v1/projects/"+project.ID, nil, http.StatusOK).Access
	if beforeAccess.DirectGrant == nil || !reflect.DeepEqual(*beforeAccess.DirectGrant, grant) || beforeAccess.TeamRole != nil || beforeAccess.EffectiveRole != "admin" {
		t.Fatalf("initial grant differs: %+v", beforeAccess)
	}
	db, err := pgxpool.New(f.context, f.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var usersBefore, teamsBefore, usersAfter, teamsAfter int
	if err := db.QueryRow(f.context, `SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM teams)`).Scan(&usersBefore, &teamsBefore); err != nil {
		t.Fatal(err)
	}
	destinationPath := "/api/v1/teams/" + destination.ID + "/members/" + search.Items[0].UserID
	receipt := requestJSON[api.AddExistingTeamMemberReceipt](t, f, http.MethodPost, destinationPath, api.AddExistingTeamMemberRequest{ExpectedUserID: f.userID}, http.StatusOK)
	if !receipt.Added || receipt.ActorRole != "admin" || receipt.Membership.UserID != member.UserID || receipt.Membership.TeamID != destination.ID || receipt.Membership.Role != "member" || !reflect.DeepEqual(receipt.Membership.Profile, search.Items[0].Profile) {
		t.Fatalf("existing member receipt differs: %+v", receipt)
	}
	repeated := requestJSON[api.AddExistingTeamMemberReceipt](t, f, http.MethodPost, destinationPath, api.AddExistingTeamMemberRequest{ExpectedUserID: f.userID}, http.StatusOK)
	if repeated.Added || !reflect.DeepEqual(repeated.Membership, receipt.Membership) {
		t.Fatalf("repeated receipt differs: %+v", repeated)
	}
	directory := requestJSON[api.TeamMemberList](t, f, http.MethodGet, "/api/v1/teams/"+destination.ID+"/members", nil, http.StatusOK)
	if actual := expectID(t, directory.Items, member.UserID, func(item api.TeamMemberWithProfile) string { return item.UserID }); !reflect.DeepEqual(actual, receipt.Membership) {
		t.Fatal("directory did not retain receipt")
	}
	access := requestJSON[api.ProjectDocument](t, &target, http.MethodGet, "/api/v1/projects/"+project.ID, nil, http.StatusOK).Access
	if access.TeamRole == nil || *access.TeamRole != "member" || access.DirectGrant == nil || !reflect.DeepEqual(*access.DirectGrant, grant) || access.EffectiveRole != "admin" {
		t.Fatalf("inherited access differs: %+v", access)
	}
	later := requestJSON[api.Project](t, f, http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: "Later Team project", RepoURL: "https://github.com/example/later-existing-account", TeamID: &destination.ID, ExpectedUserID: f.userID}, http.StatusCreated)
	laterAccess := requestJSON[api.ProjectDocument](t, &target, http.MethodGet, "/api/v1/projects/"+later.ID, nil, http.StatusOK).Access
	if laterAccess.TeamRole == nil || *laterAccess.TeamRole != "member" || laterAccess.DirectGrant != nil || laterAccess.EffectiveRole != "member" {
		t.Fatalf("later inherited access differs: %+v", laterAccess)
	}
	if err := db.QueryRow(f.context, `SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM teams)`).Scan(&usersAfter, &teamsAfter); err != nil {
		t.Fatal(err)
	}
	if usersBefore != usersAfter || teamsBefore != teamsAfter {
		t.Fatal("existing account addition initialized an account or Team")
	}
	adminReceipt := requestJSON[api.AddExistingTeamMemberReceipt](t, f, http.MethodPost, path+"/members/"+member.UserID, api.AddExistingTeamMemberRequest{ExpectedUserID: f.userID}, http.StatusOK)
	if adminReceipt.Added || !reflect.DeepEqual(adminReceipt.Membership.TeamMember, member) {
		t.Fatal("existing admin relationship changed")
	}
	resolve := func(externalID string) api.ResolveTeamMemberResponse {
		t.Helper()
		body, err := json.Marshal(api.ResolveTeamMemberRequest{ExpectedUserID: f.userID, User: api.ResolveTeamMemberUser{ExternalUserID: externalID}})
		if err != nil {
			t.Fatal(err)
		}
		response, data := f.request(t, http.MethodPost, path+"/members/resolve", "application/json", body, http.StatusOK)
		var result api.ResolveTeamMemberResponse
		if err := json.Unmarshal(data, &result); err != nil {
			t.Fatalf("decode member resolution: %v", err)
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(data, &fields); err != nil {
			t.Fatalf("decode member resolution envelope: %v", err)
		}
		membership, present := fields["membership"]
		if response.Header.Get("Daynight-User-ID") != f.userID || response.Header.Get("Cache-Control") != "no-store" || result.ActorRole != "admin" || len(fields) != 2 || !present || (result.Membership == nil && string(membership) != "null") || strings.Contains(string(data), externalID) || strings.Contains(string(data), "profile") {
			t.Fatal("member resolution headers or response differ")
		}
		return result
	}
	resolved := resolve(externalID)
	if resolved.Membership == nil || !reflect.DeepEqual(*resolved.Membership, member) {
		t.Fatalf("resolved membership differs: %+v", resolved)
	}
	missing := resolve("integration:" + uuid.NewString())
	if missing.Membership != nil {
		t.Fatalf("missing identity returned a membership: %+v", missing)
	}
	members := requestJSON[api.TeamMemberList](t, f, http.MethodGet, path+"/members", nil, http.StatusOK)
	if len(members.Items) != 2 {
		t.Fatalf("Team directory differs after direct addition: %+v", members)
	}
	actual := expectID(t, members.Items, member.UserID, func(item api.TeamMemberWithProfile) string { return item.UserID })
	if !reflect.DeepEqual(actual.TeamMember, member) || actual.Profile.Name == nil || *actual.Profile.Name != name || actual.Profile.AvatarURL == nil || *actual.Profile.AvatarURL != avatar || actual.Profile.Email != nil {
		t.Fatalf("persisted direct member or target profile differs: %+v", actual)
	}
	actor := expectID(t, members.Items, f.userID, func(item api.TeamMemberWithProfile) string { return item.UserID })
	if !reflect.DeepEqual(actor.TeamMember, team.Membership) {
		t.Fatal("direct addition changed the actor membership")
	}
	current := requestJSON[api.Team](t, f, http.MethodGet, path, nil, http.StatusOK)
	if !reflect.DeepEqual(current, team) {
		t.Fatal("direct addition changed Team metadata, timestamps or actor membership")
	}
}
