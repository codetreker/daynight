package webhook

import (
	"fmt"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/google/uuid"
)

func TestSubscriptionConfigurationIdentityAndConfirmation(t *testing.T) {
	f := newFixture(t, false)
	p := f.principal(t)
	team, project := uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO teams(id,name) VALUES($1,'Scope')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, []any{team, p.UserID}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'Project',$2)`, []any{project, "https://example.test/" + project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err := f.db.Pool.Exec(f.ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	m := createMutation(p, "Subscriptions", "https://example.test/hook")
	for i := 0; i < 51; i++ {
		m.Subscriptions = append(m.Subscriptions, core.SubscriptionInput{ProjectID: project, EventTypes: []string{"task.created", "task.paused"}})
	}
	result, err := f.svc.Mutate(f.ctx, p, Owner{Kind: "personal", ID: p.UserID}, m)
	if err != nil {
		t.Fatal(err)
	}
	_, ep := body(t, result)
	endpoint := ep["id"].(string)
	subs := ep["subscriptions"].([]any)
	if len(subs) != 51 {
		t.Fatalf("got %d subscriptions", len(subs))
	}
	list, err := f.svc.List(f.ctx, p, Owner{Kind: "personal", ID: p.UserID}, ListQuery{})
	if err != nil {
		t.Fatal(err)
	}
	summary := list.(map[string]any)["items"].([]any)[0].(map[string]any)
	if summary["projectCount"] != 1 || summary["eventTypeCount"] != 2 || summary["lastAttemptAt"] != nil || summary["lastResult"] != nil {
		t.Fatalf("summary %#v", summary)
	}
	ids := map[string]bool{}
	for _, v := range subs {
		id := v.(map[string]any)["id"].(string)
		if ids[id] {
			t.Fatal("duplicate ID")
		}
		ids[id] = true
	}
	var oldBinding string
	first := subs[0].(map[string]any)["id"].(string)
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT id::text FROM webhook_bindings WHERE subscription_id=$1 AND event_type='task.paused' AND deleted_at IS NULL`, first).Scan(&oldBinding); err != nil {
		t.Fatal(err)
	}
	update := mutation(p, "endpoint.update", endpoint, 1)
	update.HasSubscriptions = true
	for _, v := range subs {
		id := v.(map[string]any)["id"].(string)
		events := []string{"task.created", "task.paused"}
		if id == first {
			events = []string{"task.created"}
		}
		update.Subscriptions = append(update.Subscriptions, core.SubscriptionInput{ID: &id, ProjectID: project, EventTypes: events})
	}
	if _, err = f.svc.Mutate(f.ctx, p, Owner{Kind: "personal", ID: p.UserID}, update); err != nil {
		t.Fatal(err)
	}
	update.OperationID = uuid.NewString()
	update.IfVersion = 2
	for i := range update.Subscriptions {
		if *update.Subscriptions[i].ID == first {
			update.Subscriptions[i].EventTypes = append(update.Subscriptions[i].EventTypes, "task.paused")
		}
	}
	if _, err = f.svc.Mutate(f.ctx, p, Owner{Kind: "personal", ID: p.UserID}, update); err != nil {
		t.Fatal(err)
	}
	var newBinding string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT id::text FROM webhook_bindings WHERE subscription_id=$1 AND event_type='task.paused' AND deleted_at IS NULL`, first).Scan(&newBinding); err != nil {
		t.Fatal(err)
	}
	if newBinding == oldBinding {
		t.Fatal("re-added binding reused identity")
	}
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_subscriptions SET authorization_state='confirmation_required',authorization_epoch=2 WHERE id=$1`, first); err != nil {
		t.Fatal(err)
	}
	confirm := mutation(p, "endpoint.update", endpoint, 3)
	confirm.ConfirmProjectIDs = []string{project}
	result, err = f.svc.Mutate(f.ctx, p, Owner{Kind: "personal", ID: p.UserID}, confirm)
	if err != nil {
		t.Fatal(err)
	}
	op, _ := body(t, result)
	if op["effect"] != "applied" {
		t.Fatalf("confirm effect %v", op["effect"])
	}
	var state string
	var epoch int64
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, first).Scan(&state, &epoch); err != nil {
		t.Fatal(err)
	}
	if state != "active" || epoch != 2 {
		t.Fatal(fmt.Sprintf("state=%s epoch=%d", state, epoch))
	}
	invalid := mutation(p, "endpoint.update", endpoint, 4)
	invalid.ConfirmProjectIDs = []string{uuid.NewString()}
	_, err = f.svc.Mutate(f.ctx, p, Owner{Kind: "personal", ID: p.UserID}, invalid)
	expectFault(t, err, "invalid_input")
	if _, err = f.db.Pool.Exec(f.ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team, p.UserID); err != nil {
		t.Fatal(err)
	}
	view, err := f.svc.Get(f.ctx, p, Owner{Kind: "personal", ID: p.UserID}, endpoint)
	if err != nil {
		t.Fatal(err)
	}
	visible := view.(map[string]any)["subscriptions"].([]any)
	if visible[0].(map[string]any)["eligibility"] != "access_revoked" || visible[0].(map[string]any)["projectName"].(*string) != nil {
		t.Fatal("revoked project leaked or misclassified")
	}
	add := mutation(p, "endpoint.update", endpoint, 4)
	add.HasSubscriptions = true
	for _, v := range visible {
		item := v.(map[string]any)
		id := item["id"].(string)
		add.Subscriptions = append(add.Subscriptions, core.SubscriptionInput{ID: &id, ProjectID: project, EventTypes: item["eventTypes"].([]string)})
	}
	add.Subscriptions = append(add.Subscriptions, core.SubscriptionInput{ProjectID: project, EventTypes: []string{"task.created"}})
	_, err = f.svc.Mutate(f.ctx, p, Owner{Kind: "personal", ID: p.UserID}, add)
	expectFault(t, err, "forbidden")
	var receipts int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_operations WHERE operation_id=$1`, add.OperationID).Scan(&receipts); err != nil || receipts != 0 {
		t.Fatalf("failed expansion receipt %d: %v", receipts, err)
	}
	cleanup := mutation(p, "endpoint.update", endpoint, 4)
	cleanup.HasSubscriptions = true
	cleanup.Subscriptions = add.Subscriptions[:1]
	cleanup.Subscriptions[0].EventTypes = []string{"task.created"}
	result, err = f.svc.Mutate(f.ctx, p, Owner{Kind: "personal", ID: p.UserID}, cleanup)
	if err != nil {
		t.Fatal(err)
	}
	_, ep = body(t, result)
	if len(ep["subscriptions"].([]any)) != 1 {
		t.Fatal("cleanup did not remove retained subscriptions")
	}
}
