//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
)

func serverAPIProjectCandidatesNormalFlow(t *testing.T, f *fixture) {
	t.Helper()
	team := requestJSON[api.Team](t, f, http.MethodPost, "/api/v1/teams", api.CreateTeamRequest{Name: "Candidate search Team", ExpectedUserID: f.userID}, http.StatusCreated)
	query := "Project candidates " + uuid.NewString()
	var candidates []api.TeamMemberWithProfile
	for _, role := range []string{"admin", "member"} {
		receipt := requestJSON[api.AddTeamMemberReceipt](t, f, http.MethodPost, "/api/v1/teams/"+team.ID+"/members", map[string]any{
			"expectedUserId": f.userID,
			"user":           map[string]any{"externalUserId": "project-candidate:" + uuid.NewString(), "profile": map[string]any{"name": query}},
			"role":           role,
		}, http.StatusOK)
		candidates = append(candidates, api.TeamMemberWithProfile{TeamMember: receipt.Membership, Profile: api.ProjectParticipantProfile{Name: &query}})
	}
	newTeamProject := func(name string) api.Project {
		return requestJSON[api.Project](t, f, http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: name, RepoURL: "https://github.com/example/" + uuid.NewString(), TeamID: &team.ID, ExpectedUserID: f.userID}, http.StatusCreated)
	}
	inherited := newTeamProject("Inherited candidate search")
	standalone := newTeamProject("Standalone candidate search")
	personal := createProject(t, f, "Personal candidate search")
	path := func(project api.Project) string { return "/api/v1/projects/" + project.ID }
	access := requestJSON[api.ProjectDocument](t, f, http.MethodGet, path(inherited), nil, http.StatusOK).Access
	if access.DirectGrant == nil {
		t.Fatal("created project did not retain the creator grant")
	}
	removed := requestJSON[api.RemoveProjectGrantResult](t, f, http.MethodDelete, path(inherited)+"/grants/"+f.userID, map[string]any{"expectedUserId": f.userID, "version": access.DirectGrant.Version}, http.StatusOK)
	if removed.ActorAccess == nil || removed.ActorAccess.TeamRole == nil || *removed.ActorAccess.TeamRole != "admin" || removed.ActorAccess.DirectGrant != nil {
		t.Fatalf("inherited-only administrator differs: %+v", removed)
	}
	search := func(project api.Project) {
		t.Helper()
		before := requestJSON[api.ProjectDocument](t, f, http.MethodGet, path(project), nil, http.StatusOK)
		var cursor *string
		seen := map[string]api.ProjectParticipantProfile{}
		for {
			body, err := json.Marshal(map[string]any{"expectedUserId": f.userID, "query": query, "limit": 1})
			if cursor != nil {
				body, err = json.Marshal(map[string]any{"expectedUserId": f.userID, "query": query, "limit": 1, "cursor": *cursor})
			}
			if err != nil {
				t.Fatal(err)
			}
			response, data := f.request(t, http.MethodPost, path(project)+"/member-candidates/search", "application/json", body, http.StatusOK)
			var page struct {
				Items []struct {
					UserID  string                        `json:"userId"`
					Profile api.ProjectParticipantProfile `json:"profile"`
				} `json:"items"`
				NextCursor *string `json:"nextCursor"`
				ActorRole  string  `json:"actorRole"`
			}
			if err := json.Unmarshal(data, &page); err != nil {
				t.Fatal(err)
			}
			if response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Daynight-User-ID") != f.userID || page.ActorRole != "admin" || len(page.Items) != 1 {
				t.Fatalf("candidate page or headers differ: %+v", page)
			}
			item := page.Items[0]
			if _, duplicate := seen[item.UserID]; duplicate {
				t.Fatal("candidate pagination repeated an account")
			}
			seen[item.UserID] = item.Profile
			cursor = page.NextCursor
			if cursor == nil {
				break
			}
			if len(seen) >= len(candidates) {
				t.Fatal("candidate pagination did not end")
			}
		}
		if len(seen) != len(candidates) {
			t.Fatalf("candidate directory size differs: %+v", seen)
		}
		for _, candidate := range candidates {
			if profile, ok := seen[candidate.UserID]; !ok || !reflect.DeepEqual(profile, candidate.Profile) {
				t.Fatalf("candidate profile differs: %+v", seen)
			}
		}
		after := requestJSON[api.ProjectDocument](t, f, http.MethodGet, path(project), nil, http.StatusOK)
		if !reflect.DeepEqual(before, after) {
			t.Fatal("candidate search changed project or access")
		}
	}
	search(inherited)
	personalAccess := requestJSON[api.ProjectDocument](t, f, http.MethodGet, path(personal), nil, http.StatusOK).Access
	if personalAccess.OwnerTeam.Kind != "personal" {
		t.Fatal("personal administrator search did not use a Personal Team project")
	}
	search(personal)
	requestJSON[api.RemoveTeamMemberReceipt](t, f, http.MethodDelete, "/api/v1/teams/"+team.ID+"/members/"+f.userID, api.RemoveTeamMemberRequest{Version: team.Membership.Version, ExpectedUserID: f.userID}, http.StatusOK)
	standaloneAccess := requestJSON[api.ProjectDocument](t, f, http.MethodGet, path(standalone), nil, http.StatusOK).Access
	if standaloneAccess.TeamRole != nil || standaloneAccess.DirectGrant == nil || standaloneAccess.EffectiveRole != "admin" {
		t.Fatalf("standalone administrator differs: %+v", standaloneAccess)
	}
	search(standalone)
}
