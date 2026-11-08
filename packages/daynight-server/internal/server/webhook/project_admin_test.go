package webhook_test

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// T01-A01: a direct Project administrator grant never conveys Team webhook
// management, whether the grantee is a Team member or not a Team member.
func TestHTTPProjectAdminCannotManageTeamWebhook(t *testing.T) {
	f := newHTTPFixture(t)
	admin, member, outsider := f.actor(t), f.actor(t), f.actor(t)
	team, project := uuid.NewString(), uuid.NewString()
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO teams(id,name) VALUES($1,'webhook team')`, team); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member')`, team, admin.id, member.id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'webhook project',$2)`, project, fmt.Sprintf("https://example.test/%s", project)); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, team); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'admin')`, project, member.id, outsider.id); err != nil {
		t.Fatal(err)
	}
	var directAdmins, teamMemberAdmins int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM project_grants WHERE project_id=$1 AND role='admin' AND user_id IN ($2,$3)), (SELECT count(*) FROM team_members WHERE team_id=$4 AND role='admin' AND user_id IN ($2,$3))`, project, member.id, outsider.id, team).Scan(&directAdmins, &teamMemberAdmins); err != nil || directAdmins != 2 || teamMemberAdmins != 0 {
		t.Fatalf("fixture roles: Project admins=%d Team admins=%d err=%v", directAdmins, teamMemberAdmins, err)
	}
	base := "/api/v1/teams/" + team + "/webhooks"
	status, _, body := f.request(t, admin, http.MethodPost, base, encoded(t, createFields(admin, "team endpoint", "https://receiver.example/secret-path")))
	mustStatus(t, status, 201, body)
	id := jsonBody(t, body)["endpoint"].(map[string]any)["id"].(string)
	status, _, body = f.request(t, member, http.MethodGet, base+"/"+id, "")
	mustStatus(t, status, 200, body)
	if destination := jsonBody(t, body)["destination"].(map[string]any); destination["url"] != nil {
		t.Fatal("Team member received full URL")
	}
	status, _, body = f.request(t, outsider, http.MethodGet, base+"/"+id, "")
	mustStatus(t, status, 403, body)
	for _, actor := range []httpActor{member, outsider} {
		patch := operationFields(actor)
		patch["ifVersion"] = "1"
		patch["name"] = "unauthorized change"
		remove := operationFields(actor)
		remove["ifVersion"] = "1"
		rotate := operationFields(actor)
		rotate["ifVersion"] = "1"
		rotate["mode"] = "immediate"
		cases := []struct{ method, path, body string }{
			{http.MethodPost, base, encoded(t, createFields(actor, "unauthorized", "https://example.test/"))},
			{http.MethodPatch, base + "/" + id, encoded(t, patch)},
			{http.MethodDelete, base + "/" + id, encoded(t, remove)},
			{http.MethodGet, base + "/" + id + "/signing-secret", ""},
			{http.MethodPost, base + "/" + id + "/signing-secret/rotations", encoded(t, rotate)},
		}
		for _, tc := range cases {
			status, _, body = f.request(t, actor, tc.method, tc.path, tc.body)
			if status != 403 || jsonBody(t, body)["error"].(map[string]any)["code"] != "forbidden" {
				t.Fatalf("%s %s status=%d body=%s", tc.method, tc.path, status, body)
			}
		}
	}
	var endpoints, receipts int
	var version int64
	var name string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_kind='team' AND owner_id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_kind='team' AND owner_id=$1),config_version,name FROM webhook_endpoints WHERE id=$2`, team, id).Scan(&endpoints, &receipts, &version, &name); err != nil || endpoints != 1 || receipts != 1 || version != 1 || name != "team endpoint" {
		t.Fatalf("unauthorized effects: endpoints=%d receipts=%d version=%d name=%s err=%v", endpoints, receipts, version, name, err)
	}
}
