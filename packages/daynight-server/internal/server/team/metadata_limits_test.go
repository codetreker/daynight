package team

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

func TestTeamHTTPMetadataLimitsPreserveRows(t *testing.T) {
	h := teamTestHandler(t)
	actor := h.principal.UserID
	for _, name := range []string{strings.Repeat("a", 256), strings.Repeat("😀", 256)} {
		created := decodeResponse[api.Team](t, projectRequest(h, "POST", "/api/v1/teams", jsonBody(t, api.CreateTeamRequest{Name: name, ExpectedUserID: actor})), 201)
		if created.Name == nil || *created.Name != name {
			t.Fatalf("boundary name changed: %#v", created.Name)
		}
	}
	team := decodeResponse[api.Team](t, projectRequest(h, "POST", "/api/v1/teams", jsonBody(t, api.CreateTeamRequest{Name: "Original", ExpectedUserID: actor})), 201)
	snapshot := func() string {
		t.Helper()
		var state string
		err := h.database.Pool.QueryRow(context.Background(), `SELECT jsonb_build_object('teams',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM teams t),'members',(SELECT jsonb_agg(to_jsonb(m) ORDER BY team_id,user_id) FROM team_members m))::text`).Scan(&state)
		if err != nil {
			t.Fatal(err)
		}
		return state
	}
	before := snapshot()
	for _, name := range []string{strings.Repeat("a", 257), strings.Repeat("😀", 256) + "a"} {
		assertProjectError(t, projectRequest(h, "POST", "/api/v1/teams", jsonBody(t, api.CreateTeamRequest{Name: name, ExpectedUserID: actor})), 400, "invalid_input")
		assertProjectError(t, projectRequest(h, "PATCH", "/api/v1/teams/"+team.ID, jsonBody(t, api.ChangeTeamRequest{Name: name, Version: team.Version, ExpectedUserID: actor})), 400, "invalid_input")
	}
	if after := snapshot(); after != before {
		t.Fatal("rejected Team writes changed rows or versions")
	}
	got := decodeResponse[api.Team](t, projectRequest(h, "GET", "/api/v1/teams/"+team.ID, ""), 200)
	if !reflect.DeepEqual(got, team) {
		t.Fatalf("rejected rename changed Team: %#v", got)
	}
}
