package webhook_test

import (
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/google/uuid"
)

func TestHTTPSubscriptionIdentityTransferConfirmationAndCleanup(t *testing.T) {
	f := newHTTPFixture(t)
	actor := f.actor(t)
	teamA, teamB, project, other := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO teams(id,name) VALUES($1,'A'),($2,'B')`, []any{teamA, teamB}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$3,'admin'),($2,$3,'admin')`, []any{teamA, teamB, actor.id}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'P',$3),($2,'Q',$4)`, []any{project, other, "https://example.test/" + project, "https://example.test/" + other}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$3),($2,$3)`, []any{project, other, teamA}},
	} {
		if _, err := f.db.Pool.Exec(f.ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	selection := func(id any, projectID string, events ...string) map[string]any {
		return map[string]any{"id": id, "projectId": projectID, "eventTypes": events}
	}
	base := "/api/v1/teams/" + teamA + "/webhooks"
	create := createFields(actor, "transfer", "https://receiver.example/hook")
	create["subscriptions"] = []any{selection(nil, project, "task.created", "task.paused")}
	status, _, body := f.request(t, actor, http.MethodPost, base, encoded(t, create))
	mustStatus(t, status, 201, body)
	ep := jsonBody(t, body)["endpoint"].(map[string]any)
	endpoint := ep["id"].(string)
	path := base + "/" + endpoint
	sub := ep["subscriptions"].([]any)[0].(map[string]any)["id"].(string)
	binding := func(id, event string) string {
		t.Helper()
		var result string
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text FROM webhook_bindings WHERE subscription_id=$1 AND event_type=$2 AND deleted_at IS NULL`, id, event).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	original := binding(sub, "task.paused")
	patch := func(version string, changes map[string]any, expected int) map[string]any {
		t.Helper()
		fields := operationFields(actor)
		fields["ifVersion"] = version
		for k, v := range changes {
			fields[k] = v
		}
		code, _, b := f.request(t, actor, http.MethodPatch, path, encoded(t, fields))
		mustStatus(t, code, expected, b)
		if expected != http.StatusOK {
			return nil
		}
		return jsonBody(t, b)["endpoint"].(map[string]any)
	}
	ep = patch("1", map[string]any{"subscriptions": []any{selection(sub, project, "task.created")}}, 200)
	if ep["subscriptions"].([]any)[0].(map[string]any)["id"] != sub {
		t.Fatal("retained subscription changed identity")
	}
	ep = patch("2", map[string]any{"subscriptions": []any{selection(sub, project, "task.created", "task.paused")}}, 200)
	if binding(sub, "task.paused") == original {
		t.Fatal("re-added binding inherited old identity")
	}
	patch("3", map[string]any{"subscriptions": []any{selection(sub, other, "task.created")}}, 400)
	ep = patch("3", map[string]any{"subscriptions": []any{selection(nil, project, "task.created", "task.paused")}}, 200)
	next := ep["subscriptions"].([]any)[0].(map[string]any)["id"].(string)
	if next == sub {
		t.Fatal("replacement reused subscription identity")
	}
	var oldDeleted bool
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT deleted_at IS NOT NULL FROM webhook_subscriptions WHERE id=$1`, sub).Scan(&oldDeleted); err != nil || !oldDeleted {
		t.Fatalf("old subscription tombstone: %t %v", oldDeleted, err)
	}
	var sessionID string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text FROM sessions WHERE user_id=$1`, actor.id).Scan(&sessionID); err != nil {
		t.Fatal(err)
	}
	principal := model.Principal{Kind: model.SessionCredential, UserID: actor.id, CredentialID: sessionID}
	projects := projectservice.NewProjects(f.db)
	transfer := func(target string) {
		t.Helper()
		preview, err := projects.TransferPreview(f.ctx, principal, project, target)
		if err != nil {
			t.Fatal(err)
		}
		_, err = projects.Transfer(f.ctx, principal, project, coreproject.TransferInput{Ownership: preview.Ownership, TargetTeam: coreproject.TeamVersion{ID: target, Version: preview.TargetTeamVersion}, ExpectedUserID: actor.id})
		if err != nil {
			t.Fatal(err)
		}
	}
	state := func(want string, epoch int64) {
		t.Helper()
		var s string
		var e int64
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, next).Scan(&s, &e); err != nil {
			t.Fatal(err)
		}
		if s != want || e != epoch {
			t.Fatalf("state %s epoch %d", s, e)
		}
	}
	transfer(teamB)
	state("confirmation_required", 2)
	status, _, body = f.request(t, actor, http.MethodGet, path, "")
	mustStatus(t, status, 200, body)
	viewed := jsonBody(t, body)["subscriptions"].([]any)[0].(map[string]any)
	if viewed["eligibility"] != "owner_scope_changed" || viewed["projectName"] != nil {
		t.Fatalf("transferred view %#v", viewed)
	}
	ep = patch("4", map[string]any{"subscriptions": []any{selection(next, project, "task.created")}}, 200)
	patch("5", map[string]any{"subscriptions": []any{selection(next, project, "task.created", "task.paused")}}, 403)
	ep = patch("5", map[string]any{"enabled": false}, 200)
	if ep["enabled"] != false {
		t.Fatal("pause failed")
	}
	transfer(teamA)
	state("confirmation_required", 2)
	status, _, body = f.request(t, actor, http.MethodGet, path, "")
	mustStatus(t, status, 200, body)
	viewed = jsonBody(t, body)["subscriptions"].([]any)[0].(map[string]any)
	if viewed["eligibility"] != "confirmation_required" {
		t.Fatalf("restored view %#v", viewed)
	}
	ep = patch("6", map[string]any{"confirmProjectIds": []string{project}}, 200)
	state("active", 2)
	if ep["subscriptions"].([]any)[0].(map[string]any)["id"] != next {
		t.Fatal("confirmation changed identity")
	}
	patch("7", map[string]any{"enabled": true}, 200)
	transfer(teamB)
	state("confirmation_required", 3)
	ep = patch("8", map[string]any{"subscriptions": []any{}}, 200)
	if len(ep["subscriptions"].([]any)) != 0 {
		t.Fatal("revoked selection not removed")
	}
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT deleted_at IS NOT NULL FROM webhook_subscriptions WHERE id=$1`, next).Scan(&oldDeleted); err != nil || !oldDeleted {
		t.Fatalf("cleanup tombstone: %t %v", oldDeleted, err)
	}
	del := operationFields(actor)
	del["ifVersion"] = "9"
	status, _, body = f.request(t, actor, http.MethodDelete, path, encoded(t, del))
	mustStatus(t, status, 200, body)
}
