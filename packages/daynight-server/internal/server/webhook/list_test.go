package webhook

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	teamcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	webhookcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

type listResponse struct {
	Items      []endpointSummaryResponse `json:"items"`
	NextCursor *string                   `json:"nextCursor"`
}

func TestEventCatalogAndPopulatedEndpointPagination(t *testing.T) {
	h := newIntegrationHarness(t)
	catalogResponse := h.call("GET", "/api/v1/webhook-event-types", "", h.bobCookie)
	catalog := decoded[struct {
		Items   []webhookcore.EventDefinition `json:"items"`
		Service struct {
			ConfigurationExpansionAvailable bool `json:"configurationExpansionAvailable"`
			DispatchEnabled                 bool `json:"dispatchEnabled"`
		} `json:"service"`
		Limits map[string]json.RawMessage `json:"limits"`
	}](t, catalogResponse, 200)
	if len(catalog.Items) != 6 || !catalog.Service.ConfigurationExpansionAvailable || catalog.Service.DispatchEnabled || string(catalog.Limits["policyVersion"]) != `"1"` || string(catalog.Limits["endpointLimit"]) != "20" || strings.Contains(catalogResponse.Body.String(), "test-key") {
		t.Fatal("event catalog did not expose only supported definitions and public deployment limits")
	}
	errorStatus(t, h.call("GET", "/api/v1/webhook-event-types?unexpected=1", "", h.bobCookie), 400, "invalid_input")
	base := "/api/v1/me/webhooks"
	for _, name := range []string{"First", "Second", "Third"} {
		input := createBody(h, h.alice)
		input["name"] = name
		decoded[mutationResponse](t, h.call("POST", base, body(t, input), h.aliceCookie), 201)
	}
	seen := map[string]bool{}
	path := base + "?limit=1&q=receiver"
	var firstCursor string
	for i := 0; i < 3; i++ {
		page := decoded[listResponse](t, h.call("GET", path, "", h.aliceCookie), 200)
		if len(page.Items) != 1 || seen[page.Items[0].ID] || page.Items[0].ProjectCount != 1 || page.Items[0].EventTypeCount != 2 || page.Items[0].Destination.URL != nil || strings.Contains(page.Items[0].Destination.DisplayURL, "sensitive") {
			t.Fatal("populated page lost stable positions, counts or public destination disclosure")
		}
		seen[page.Items[0].ID] = true
		if i < 2 {
			if page.NextCursor == nil {
				t.Fatal("populated list lost continuation")
			}
			if i == 0 {
				firstCursor = *page.NextCursor
			}
			path = base + "?limit=1&q=receiver&cursor=" + *page.NextCursor
		} else if page.NextCursor != nil {
			t.Fatal("final populated page falsely has continuation")
		}
	}
	errorStatus(t, h.call("GET", base+"?limit=1&q=receiver&cursor="+firstCursor, "", h.bobCookie), 400, "invalid_input")
	errorStatus(t, h.call("GET", base+"?limit=1&q=other&cursor="+firstCursor, "", h.aliceCookie), 400, "invalid_input")
	if len(decoded[listResponse](t, h.call("GET", base+"?enabled=false", "", h.aliceCookie), 200).Items) != 0 {
		t.Fatal("enabled filter ignored")
	}
	if len(decoded[listResponse](t, h.call("GET", base+"?q=sensitive", "", h.aliceCookie), 200).Items) != 0 {
		t.Fatal("summary search matched unexposed URL credentials")
	}
}

func TestTeamCursorRejectsAChangedDisclosureRole(t *testing.T) {
	h := newIntegrationHarness(t)
	base := "/api/v1/teams/" + h.team.ID + "/webhooks"
	for i := 0; i < 2; i++ {
		decoded[mutationResponse](t, h.call("POST", base, body(t, createBody(h, h.alice)), h.aliceCookie), 201)
	}
	page := decoded[listResponse](t, h.call("GET", base+"?limit=1", "", h.aliceCookie), 200)
	if page.NextCursor == nil {
		t.Fatal("team list has no continuation")
	}
	if _, err := h.Database.Pool.Exec(context.Background(), `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, h.team.ID, h.charlie.UserID); err != nil {
		t.Fatal(err)
	}
	var version int64
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT version FROM team_members WHERE team_id=$1 AND user_id=$2`, h.team.ID, h.alice.UserID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if _, err := teamservice.NewTeams(h.Database).SetMemberRole(context.Background(), h.alice, h.team.ID, h.alice.UserID, teamcore.ChangeTeamMember{Version: version, Role: model.ProjectMemberRole, ExpectedUserID: h.alice.UserID}); err != nil {
		t.Fatal(err)
	}
	errorStatus(t, h.call("GET", base+"?limit=1&cursor="+*page.NextCursor, "", h.aliceCookie), 400, "invalid_input")
	if len(decoded[listResponse](t, h.call("GET", base, "", h.aliceCookie), 200).Items) != 2 {
		t.Fatal("current member cannot restart its current disclosure list")
	}
}
