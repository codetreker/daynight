package server

import (
	"bytes"
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/google/uuid"
)

func TestTeamHTTPProductionCompositionAndLifecycle(t *testing.T) {
	db := newHTTPTestStore(t)
	var logs bytes.Buffer
	handler := resourceTestServerForPrincipal(t, db, attachmentTestFiles(t), &logs, defaultHTTPPrincipal())
	actor := handler.principal.UserID
	rawName := " \t研发😀\u2003 " + strings.Repeat("x", 180)
	body := jsonBody(t, api.CreateTeamRequest{Name: rawName, ExpectedUserID: actor})
	expected := teamHTTPCreate(t, db, handler.principal, rawName)
	response := projectRequest(handler, "POST", "/api/v1/teams", body)
	team := decodeResponse[api.Team](t, response, 201)
	if team.Name == nil || *team.Name != rawName || team.ID != expected.ID || team.Kind != "ordinary" || team.Membership.UserID != actor || team.Membership.TeamID != team.ID || team.Membership.Role != "admin" || team.Membership.Version < 1 || team.Version != 1 {
		t.Fatalf("Team DTO %#v", team)
	}
	if response.Header().Get("Location") != "/api/v1/teams/"+team.ID || response.Header().Get("Daynight-User-ID") != actor || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Team headers %v", response.Header())
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &fields); err != nil || len(fields) != 7 {
		t.Fatalf("Team shape %s %v", response.Body, err)
	}
	teamHTTPRead(t, db, handler.principal, team.ID, *expected, nil)
	got := decodeResponse[api.Team](t, projectRequest(handler, "GET", "/api/v1/teams/"+team.ID, ""), 200)
	if !reflect.DeepEqual(got, team) {
		t.Fatal("Team GET differs")
	}
	change := api.ChangeTeamRequest{Name: *team.Name, Version: team.Version, ExpectedUserID: actor}
	teamHTTPWrite(t, db, handler.principal, *expected, nil, false)
	same := decodeResponse[api.Team](t, projectRequest(handler, "PATCH", "/api/v1/teams/"+team.ID, jsonBody(t, change)), 200)
	if !reflect.DeepEqual(same, team) {
		t.Fatal("no-op changed Team")
	}
	change.Version = 2
	teamHTTPWrite(t, db, handler.principal, *expected, nil, false)
	assertProjectError(t, projectRequest(handler, "PATCH", "/api/v1/teams/"+team.ID, jsonBody(t, change)), 409, "version_conflict")
	change.Version = 1
	change.Name = " Renamed "
	renamedName := " Renamed "
	renamedExpected := *expected
	renamedExpected.Name = &renamedName
	renamedExpected.Version = 2
	renamedExpected.UpdatedAt = expected.UpdatedAt.Add(time.Second)
	teamHTTPWrite(t, db, handler.principal, *expected, &renamedExpected, false)
	renamed := decodeResponse[api.Team](t, projectRequest(handler, "PATCH", "/api/v1/teams/"+team.ID, jsonBody(t, change)), 200)
	if renamed.Version != 2 || *renamed.Name != change.Name || !reflect.DeepEqual(renamed.Membership, team.Membership) {
		t.Fatalf("renamed %#v", renamed)
	}
	change.Version = renamed.Version
	change.Name = "Renamed"
	teamHTTPWrite(t, db, handler.principal, renamedExpected, nil, false)
	assertProjectError(t, projectRequest(handler, "DELETE", "/api/v1/teams/"+team.ID, jsonBody(t, change)), 409, "version_conflict")
	change.Name = *renamed.Name
	teamHTTPWrite(t, db, handler.principal, renamedExpected, nil, true)
	deleted := projectRequest(handler, "DELETE", "/api/v1/teams/"+team.ID, jsonBody(t, change))
	receipt := decodeResponse[api.DeleteTeamReceipt](t, deleted, 200)
	if receipt.TeamID != team.ID || !receipt.Deleted {
		t.Fatalf("delete receipt %#v", receipt)
	}
	fields = nil
	if err := json.Unmarshal(deleted.Body.Bytes(), &fields); err != nil || len(fields) != 2 {
		t.Fatalf("delete leaked other resource %s %v", deleted.Body, err)
	}
	teamHTTPRead(t, db, handler.principal, team.ID, model.Team{}, model.ErrNotFound)
	assertProjectError(t, projectRequest(handler, "GET", "/api/v1/teams/"+team.ID, ""), 404, "not_found")
	personal := model.Team{TeamRef: model.TeamRef{ID: "c3333333-3333-4333-8333-333333333333", Kind: "personal"}, Version: 1, CreatedAt: expected.CreatedAt, UpdatedAt: expected.CreatedAt, Membership: model.TeamMember{TeamID: "c3333333-3333-4333-8333-333333333333", UserID: actor, Role: model.ProjectAdmin, Version: 1, CreatedAt: expected.CreatedAt, UpdatedAt: expected.CreatedAt}}
	teamHTTPList(t, db, handler.principal, []model.Team{personal})
	page := decodeResponse[api.TeamPage](t, projectRequest(handler, "GET", "/api/v1/teams?limit=1", ""), 200)
	if page.Items == nil || len(page.Items) != 1 || page.Items[0].Kind != "personal" || page.Items[0].Name != nil || page.NextCursor != nil {
		t.Fatalf("Personal list %#v", page)
	}
	change.Name = "Personal"
	change.Version = page.Items[0].Version
	for _, method := range []string{"PATCH", "DELETE"} {
		teamHTTPWrite(t, db, handler.principal, personal, nil, false)
		assertProjectError(t, projectRequest(handler, method, "/api/v1/teams/"+page.Items[0].ID, jsonBody(t, change)), 409, "personal_team_immutable")
	}
}

func TestTeamHTTPReservedIdentityCallbackPaths(t *testing.T) {
	for _, path := range []string{"/api/v1/teams", "/api/v1/teams/" + uuid.NewString(), "/teams", "/teams/" + uuid.NewString()} {
		_, _, err := configpkg.ValidateAuthSettings(configpkg.AuthSettings{PublicOrigin: "https://example.com"}, "https://example.com"+path)
		if err == nil {
			t.Fatalf("identity callback captured Team path %s", path)
		}
	}
}
