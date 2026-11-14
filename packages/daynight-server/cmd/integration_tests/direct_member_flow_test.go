//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
)

func serverAPIDirectMemberNormalFlow(t *testing.T, f *fixture) {
	t.Helper()
	team := requestJSON[api.Team](t, f, http.MethodPost, "/api/v1/teams", api.CreateTeamRequest{Name: "Direct member integration", ExpectedUserID: f.userID}, http.StatusCreated)
	if team.ID == "" || team.Kind != "ordinary" || team.Membership.UserID != f.userID || team.Membership.Role != "admin" {
		t.Fatalf("created Team or actor membership differs: %+v", team)
	}
	name, avatar := "  External target  ", "data:image/png;base64,dGFyZ2V0"
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
