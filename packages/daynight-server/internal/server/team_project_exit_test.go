package server

import (
	"io"
	"net/http"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestTeamSelfExitPreservesIndependentProjectAccessHTTP(t *testing.T) {
	actor := defaultHTTPPrincipal()
	f := newProjectAccessHTTPFixture(t, actor, io.Discard)
	teams := f.teams
	handler := f.handler
	project := projectHTTPRecord("caaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Shared project", "https://example.test/independent-grant", "dbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
	teamName := "Shared team"
	team := model.Team{TeamRef: model.TeamRef{ID: project.Ownership.TeamID, Kind: "ordinary", Name: &teamName}, Version: 1, CreatedAt: project.CreatedAt, UpdatedAt: project.CreatedAt, Membership: model.TeamMember{TeamID: project.Ownership.TeamID, UserID: actor.UserID, Role: model.ProjectMemberRole, Version: 1, CreatedAt: project.CreatedAt, UpdatedAt: project.CreatedAt}}
	grant := model.ProjectGrant{ProjectID: project.ID, UserID: actor.UserID, Role: model.ProjectMemberRole, Version: 1, CreatedAt: project.CreatedAt, UpdatedAt: project.CreatedAt}
	teamRole := model.ProjectMemberRole
	beforeFacts := model.ProjectAccess{ProjectID: project.ID, UserID: actor.UserID, Role: model.ProjectMemberRole, DirectGrant: &grant, OwnerTeam: team.TeamRef, Ownership: project.Ownership, TeamRole: &teamRole}
	base := "/api/v1/projects/" + project.ID
	accessHTTPProject(t, f, actor, project, beforeFacts, "access", taskservice.TaskSyncRequest{}, nil)
	before := decodeResponse[api.ProjectAccess](t, projectRequest(handler, http.MethodGet, base+"/access", ""), http.StatusOK)
	expectedGrant := api.ProjectGrant{ProjectID: project.ID, UserID: actor.UserID, Role: "member", Version: 1, CreatedAt: project.CreatedAt, UpdatedAt: project.CreatedAt}
	if before.TeamRole == nil || *before.TeamRole != "member" || before.DirectGrant == nil || !reflect.DeepEqual(*before.DirectGrant, expectedGrant) {
		t.Fatalf("initial access does not have both sources: %+v", before)
	}
	teamHTTPExit(t, teams, actor, team)
	leave := api.RemoveTeamMemberRequest{Version: team.Membership.Version, ExpectedUserID: actor.UserID}
	receipt := decodeResponse[api.RemoveTeamMemberReceipt](t, projectRequest(handler, http.MethodDelete, "/api/v1/teams/"+team.ID+"/members/"+actor.UserID, jsonBody(t, leave)), http.StatusOK)
	if !receipt.Removed || receipt.TeamID != team.ID || receipt.UserID != actor.UserID || receipt.ActorRole != nil {
		t.Fatalf("self-exit receipt: %+v", receipt)
	}
	teamHTTPRead(t, teams, actor, team.ID, model.Team{}, projectHTTPFault("not_found", "Team was not found."))
	denial := decodeResponse[api.ErrorResponse](t, projectRequest(handler, http.MethodGet, "/api/v1/teams/"+team.ID, ""), http.StatusNotFound)
	if denial.Error.Code != "not_found" {
		t.Fatalf("Team remains visible after exit: %+v", denial)
	}
	afterFacts := model.ProjectAccess{ProjectID: project.ID, UserID: actor.UserID, Role: model.ProjectMemberRole, DirectGrant: &grant, OwnerTeam: team.TeamRef, Ownership: project.Ownership}
	accessHTTPProject(t, f, actor, project, afterFacts, "project", taskservice.TaskSyncRequest{}, nil)
	read := decodeResponse[api.ProjectDocument](t, projectRequest(handler, http.MethodGet, base, ""), http.StatusOK)
	accessHTTPProject(t, f, actor, project, afterFacts, "access", taskservice.TaskSyncRequest{}, nil)
	after := decodeResponse[api.ProjectAccess](t, projectRequest(handler, http.MethodGet, base+"/access", ""), http.StatusOK)
	if read.ID != project.ID || after.TeamRole != nil || after.EffectiveRole != "member" || !reflect.DeepEqual(after.DirectGrant, before.DirectGrant) {
		t.Fatalf("self-exit lost or changed independent Project access: %+v", after)
	}
}
