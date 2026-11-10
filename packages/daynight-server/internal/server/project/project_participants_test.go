package project

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
)

func TestProjectParticipantHTTPContractGrantWritesAndIdentity(t *testing.T) {
	h := newHTTPHarness(t)
	memberID := "00000000-0000-4000-8000-000000000058"
	check := membershipExpectation(t, h, h.Project.ID)
	grant := membershipGrant(h, 9007199254740993, model.ProjectMemberRole)
	grant.UserID = memberID
	name, email, avatar := "Member", "member@example.test", "https://example.test/member.png"
	teamRole := model.ProjectMemberRole
	people := []model.ProjectParticipant{
		{UserID: h.Principal.UserID, EffectiveRole: model.ProjectAdmin, InheritedFrom: &model.ProjectInheritance{Team: model.TeamRef{ID: h.Project.Ownership.TeamID, Kind: "personal"}, Role: model.ProjectAdmin}, Profile: model.ProjectParticipantProfile{Name: &name, Email: &email, AvatarURL: &avatar}},
		{UserID: memberID, EffectiveRole: model.ProjectMemberRole, DirectGrant: &grant},
	}
	access := membershipAccess(h, nil)
	access.TeamRole = &teamRole
	h.Memberships.ListWithAccessFunc = func(ctx context.Context, p model.Principal, id string) (coreproject.ProjectParticipants, error) {
		check(ctx, p, id)
		return coreproject.ProjectParticipants{Items: people, ActorAccess: access}, nil
	}
	response := membershipCall(t, h, "GET", "/api/v1/projects/"+h.Project.ID+"/members", "")
	result := decodeResponse[api.ProjectParticipantList](t, response, 200)
	if len(result.Items) != 2 || response.Header().Get("Daynight-User-ID") != h.Principal.UserID || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("participants: %s %v", response.Body, response.Header())
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || len(envelope) != 2 || envelope["items"] == nil || envelope["actorAccess"] == nil {
		t.Fatalf("roster envelope: %s %v", response.Body, err)
	}
	var raw []map[string]json.RawMessage
	if err := json.Unmarshal(envelope["items"], &raw); err != nil {
		t.Fatal(err)
	}
	for index, participant := range result.Items {
		fields := raw[index]
		if len(fields) != 5 || fields["userId"] == nil || fields["profile"] == nil || fields["effectiveRole"] == nil || fields["directGrant"] == nil || fields["inheritedFrom"] == nil {
			t.Fatalf("participant fields: %#v", fields)
		}
		var profile map[string]json.RawMessage
		if err := json.Unmarshal(fields["profile"], &profile); err != nil || len(profile) != 3 || profile["name"] == nil || profile["email"] == nil || profile["avatarUrl"] == nil {
			t.Fatalf("profile: %#v %v", profile, err)
		}
		if participant.UserID == memberID {
			if participant.Profile.Name != nil || participant.Profile.Email != nil || participant.Profile.AvatarURL != nil || participant.EffectiveRole != "member" || participant.DirectGrant == nil || participant.DirectGrant.Version != 9007199254740993 || participant.DirectGrant.ProjectID != h.Project.ID || participant.DirectGrant.UserID != memberID || participant.InheritedFrom != nil {
				t.Fatalf("nullable profile and grant: %+v", participant)
			}
			if string(profile["name"]) != "null" || string(profile["email"]) != "null" || string(profile["avatarUrl"]) != "null" || !strings.Contains(string(fields["directGrant"]), `"version":9007199254740993`) {
				t.Fatalf("exact wire: %#v", fields)
			}
		} else if participant.DirectGrant != nil || participant.EffectiveRole != "admin" || participant.InheritedFrom == nil || participant.InheritedFrom.Team.ID != h.Project.Ownership.TeamID || participant.InheritedFrom.Role != "admin" || participant.Profile.Name == nil || *participant.Profile.Name != name || participant.Profile.Email == nil || *participant.Profile.Email != email || participant.Profile.AvatarURL == nil || *participant.Profile.AvatarURL != avatar {
			t.Fatalf("inherited profile: %+v", participant)
		}
	}
	if strings.Contains(response.Body.String(), "github:") || strings.Contains(response.Body.String(), "uniAuth") {
		t.Fatal("participant response disclosed identity internals")
	}
	h.assertCalls(map[string]int{"ListWithAccess": 1})
}

func TestProjectParticipantHTTPExactGrantVersionAndUTC(t *testing.T) {
	h := newHTTPHarness(t)
	check := membershipExpectation(t, h, h.Project.ID)
	grant := membershipGrant(h, 9007199254740993, model.ProjectMemberRole)
	h.Memberships.SetRoleFunc = func(ctx context.Context, p model.Principal, project, user string, input coreproject.SetProjectMemberRole) (model.ProjectGrant, error) {
		check(ctx, p, project)
		if user != p.UserID || input != (coreproject.SetProjectMemberRole{Version: 9007199254740993, Role: model.ProjectMemberRole, ExpectedUserID: p.UserID}) {
			t.Fatalf("exact role input: %q %+v", user, input)
		}
		return grant, nil
	}
	response := membershipCall(t, h, "PATCH", "/api/v1/projects/"+h.Project.ID+"/members/"+h.Principal.UserID, memberRoleBody(t, 9007199254740993, "member", h.Principal.UserID))
	result := decodeResponse[api.ProjectGrant](t, response, 200)
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields) != 6 || string(fields["version"]) != "9007199254740993" || result.ProjectID != h.Project.ID || result.UserID != h.Principal.UserID || result.Role != "member" || result.CreatedAt.Location() != time.UTC || result.UpdatedAt.Location() != time.UTC || !result.CreatedAt.Equal(grant.CreatedAt) || !result.UpdatedAt.Equal(grant.UpdatedAt) {
		t.Fatalf("exact grant: %s %v", response.Body, err)
	}
	h.assertCalls(map[string]int{"SetRole": 1})
}
