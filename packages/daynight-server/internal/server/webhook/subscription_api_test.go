package webhook_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func subscriptionRow(project string, id any, events ...string) map[string]any {
	return map[string]any{"id": id, "projectId": project, "eventTypes": events}
}
func seedHTTPProjects(t *testing.T, f *httpFixture, admin, member, other httpActor) (string, string, string, string) {
	t.Helper()
	team, otherTeam, owned, direct, denied := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO teams(id,name) VALUES($1,'webhook owners'),($2,'external team')`, []any{team, otherTeam}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member'),($4,$5,'admin')`, []any{team, admin.id, member.id, otherTeam, other.id}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'owned',$4),($2,'shared',$5),($3,'denied',$6)`, []any{owned, direct, denied, "https://example.test/owned", "https://example.test/shared", "https://example.test/denied"}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$4),($2,$5),($3,$5)`, []any{owned, direct, denied, team, otherTeam}},
		{`INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'admin')`, []any{direct, admin.id, member.id}},
	} {
		if _, err := f.db.Pool.Exec(f.ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	return team, owned, direct, denied
}
func verifyCatalog(t *testing.T, f *httpFixture, actor httpActor) {
	t.Helper()
	status, _, data := f.request(t, actor, http.MethodGet, "/api/v1/webhook-event-types", "")
	mustStatus(t, status, 200, data)
	catalog := jsonBody(t, data)
	keys := []string{"task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"}
	items := catalog["items"].([]any)
	if len(items) != len(keys) {
		t.Fatalf("catalog=%s", data)
	}
	for i, key := range keys {
		item := items[i].(map[string]any)
		if item["key"] != key || item["wireType"] != "cc.daynight."+key+".v1" {
			t.Fatalf("catalog=%s", data)
		}
	}
	if catalog["service"].(map[string]any)["dispatchEnabled"] != false {
		t.Fatalf("catalog=%s", data)
	}
}

// T02-A01: caller-owned production mux, real auth/PG and fixed catalog exercise
// owner authorization, Team ownership and direct grant union through HTTP.
func TestHTTPSubscriptionOwnerEligibility(t *testing.T) {
	f := newHTTPFixture(t)
	admin, member, other := f.actor(t), f.actor(t), f.actor(t)
	team, owned, direct, denied := seedHTTPProjects(t, f, admin, member, other)
	verifyCatalog(t, f, admin)
	personal := createFields(admin, "Personal subscriptions", "https://receiver.example/path")
	personal["subscriptions"] = []any{subscriptionRow(owned, nil, "task.created"), subscriptionRow(direct, nil, "task.deleted")}
	base := "/api/v1/me/webhooks"
	status, _, data := f.request(t, admin, http.MethodPost, base, encoded(t, personal))
	mustStatus(t, status, 201, data)
	endpoint := jsonBody(t, data)["endpoint"].(map[string]any)
	subs := endpoint["subscriptions"].([]any)
	if len(subs) != 2 {
		t.Fatalf("personal endpoint=%s", data)
	}
	projects := map[string]bool{}
	for _, raw := range subs {
		s := raw.(map[string]any)
		if s["eligibility"] != "eligible" || s["projectName"] == nil {
			t.Fatalf("personal eligibility=%s", data)
		}
		projects[s["projectId"].(string)] = true
	}
	if !projects[owned] || !projects[direct] {
		t.Fatalf("project union=%s", data)
	}
	bad := createFields(admin, "Denied", "https://receiver.example/path")
	bad["subscriptions"] = []any{subscriptionRow(denied, nil, "task.created")}
	status, _, data = f.request(t, admin, http.MethodPost, base, encoded(t, bad))
	mustStatus(t, status, 403, data)
	teamBase := "/api/v1/teams/" + team + "/webhooks"
	own := createFields(admin, "Team subscription", "https://receiver.example/path")
	own["subscriptions"] = []any{subscriptionRow(owned, nil, "task.created")}
	status, _, data = f.request(t, admin, http.MethodPost, teamBase, encoded(t, own))
	mustStatus(t, status, 201, data)
	teamID := jsonBody(t, data)["endpoint"].(map[string]any)["id"].(string)
	foreign := createFields(admin, "Team outside scope", "https://receiver.example/path")
	foreign["subscriptions"] = []any{subscriptionRow(direct, nil, "task.created")}
	status, _, data = f.request(t, admin, http.MethodPost, teamBase, encoded(t, foreign))
	mustStatus(t, status, 403, data)
	noManage := createFields(member, "Project admin only", "https://receiver.example/path")
	noManage["subscriptions"] = []any{subscriptionRow(owned, nil, "task.created")}
	status, _, data = f.request(t, member, http.MethodPost, teamBase, encoded(t, noManage))
	mustStatus(t, status, 403, data)
	status, _, data = f.request(t, member, http.MethodGet, teamBase+"/"+teamID, "")
	mustStatus(t, status, 200, data)
	var count, receipts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_kind='team' AND owner_id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_kind='team' AND owner_id=$1)`, team).Scan(&count, &receipts); err != nil || count != 1 || receipts != 1 {
		t.Fatalf("team endpoint=%d receipt=%d err=%v", count, receipts, err)
	}
	t.Logf("T02-A01 HTTP personal membership=%s grant=%s team=%s denied=403 catalog=6", owned, direct, team)
}

// T02-A12: 51 identical project/event choices remain independently addressable
// through create and replacement, and summary counts derive from real rows.
func TestHTTPManyIndependentSubscriptionsAndSummary(t *testing.T) {
	f := newHTTPFixture(t)
	admin, member, other := f.actor(t), f.actor(t), f.actor(t)
	_, _, project, _ := seedHTTPProjects(t, f, admin, member, other)
	base := "/api/v1/me/webhooks"
	fields := createFields(admin, "51 subscriptions", "https://receiver.example/path")
	rows := make([]any, 51)
	for i := range rows {
		rows[i] = subscriptionRow(project, nil, "task.created")
	}
	fields["subscriptions"] = rows
	wire := encoded(t, fields)
	if len(wire) >= 256<<10 {
		t.Fatal("fixture exceeds body bound")
	}
	status, _, data := f.request(t, admin, http.MethodPost, base, wire)
	mustStatus(t, status, 201, data)
	result := jsonBody(t, data)
	ep := result["endpoint"].(map[string]any)
	endpoint := ep["id"].(string)
	subs := ep["subscriptions"].([]any)
	if len(subs) != 51 || ep["configVersion"] != "1" {
		t.Fatalf("creation: %s", data)
	}
	ids := map[string]bool{}
	replace := make([]any, 0, len(subs))
	for _, raw := range subs {
		s := raw.(map[string]any)
		id := s["id"].(string)
		if ids[id] || s["projectId"] != project || s["eligibility"] != "eligible" {
			t.Fatalf("invalid subscription %v", s)
		}
		ids[id] = true
		replace = append(replace, subscriptionRow(project, id, "task.created", "task.deleted"))
	}
	patch := operationFields(admin)
	patch["ifVersion"] = "1"
	patch["subscriptions"] = replace
	patchWire := encoded(t, patch)
	status, _, data = f.request(t, admin, http.MethodPatch, base+"/"+endpoint, patchWire)
	mustStatus(t, status, 200, data)
	result = jsonBody(t, data)
	ep = result["endpoint"].(map[string]any)
	if ep["configVersion"] != "2" || result["operation"].(map[string]any)["effect"] != "applied" {
		t.Fatalf("patch=%s", data)
	}
	for _, raw := range ep["subscriptions"].([]any) {
		s := raw.(map[string]any)
		if !ids[s["id"].(string)] || len(s["eventTypes"].([]any)) != 2 {
			t.Fatalf("identity/selection=%s", data)
		}
	}
	status, _, data = f.request(t, admin, http.MethodPatch, base+"/"+endpoint, patchWire)
	mustStatus(t, status, 200, data)
	if jsonBody(t, data)["endpoint"].(map[string]any)["configVersion"] != "2" {
		t.Fatalf("replay=%s", data)
	}
	status, _, data = f.request(t, admin, http.MethodGet, base, "")
	mustStatus(t, status, 200, data)
	items := jsonBody(t, data)["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("summary=%s", data)
	}
	summary := items[0].(map[string]any)
	for _, field := range []string{"lastAttemptAt", "lastResult"} {
		v, ok := summary[field]
		if !ok || v != nil {
			t.Fatalf("required nullable %s=%v present=%t", field, v, ok)
		}
	}
	if summary["projectCount"] != float64(1) || summary["eventTypeCount"] != float64(2) {
		t.Fatalf("summary=%s", data)
	}
	var subscriptions, distinctIDs, bindings, receipts int
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_subscriptions WHERE endpoint_id=$1 AND deleted_at IS NULL),(SELECT count(DISTINCT id) FROM webhook_subscriptions WHERE endpoint_id=$1 AND deleted_at IS NULL),(SELECT count(*) FROM webhook_bindings b JOIN webhook_subscriptions s ON s.id=b.subscription_id WHERE s.endpoint_id=$1 AND b.deleted_at IS NULL),(SELECT count(*) FROM webhook_operations WHERE owner_kind='personal' AND owner_id=$2),(SELECT config_version FROM webhook_endpoints WHERE id=$1)`, endpoint, admin.id).Scan(&subscriptions, &distinctIDs, &bindings, &receipts, &version); err != nil || subscriptions != 51 || distinctIDs != 51 || bindings != 102 || receipts != 2 || version != 2 {
		t.Fatalf("SQL subscriptions=%d ids=%d bindings=%d receipts=%d version=%d err=%v", subscriptions, distinctIDs, bindings, receipts, version, err)
	}
	duplicate := operationFields(admin)
	duplicate["ifVersion"] = "2"
	duplicate["subscriptions"] = []any{subscriptionRow(project, subs[0].(map[string]any)["id"], "task.created", "task.created")}
	status, _, data = f.request(t, admin, http.MethodPatch, base+"/"+endpoint, encoded(t, duplicate))
	mustStatus(t, status, 400, data)
	t.Logf("T02-A12 subscriptions=%d unique=%d bindings=%d receipts=%d version=%d nullable=true bytes=%d", subscriptions, distinctIDs, bindings, receipts, version, len(wire))
}
