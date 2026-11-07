package webhook

import (
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/google/uuid"
)

func TestConfirmationRespectsConfigurationExpansionSwitch(t *testing.T) {
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
	owner := Owner{Kind: "personal", ID: p.UserID}
	create := createMutation(p, "Endpoint", "https://example.test/hook")
	create.Subscriptions = []core.SubscriptionInput{{ProjectID: project, EventTypes: []string{"task.created"}}}
	result, err := f.svc.Mutate(f.ctx, p, owner, create)
	if err != nil {
		t.Fatal(err)
	}
	_, ep := body(t, result)
	endpoint := ep["id"].(string)
	sub := ep["subscriptions"].([]any)[0].(map[string]any)["id"].(string)
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_subscriptions SET authorization_state='confirmation_required',authorization_epoch=2 WHERE id=$1`, sub); err != nil {
		t.Fatal(err)
	}
	f.svc.ConfigurationExpansionAvailable = false
	confirm := mutation(p, "endpoint.update", endpoint, 1)
	confirm.ConfirmProjectIDs = []string{project}
	_, err = f.svc.Mutate(f.ctx, p, owner, confirm)
	expectFault(t, err, "webhooks_unavailable")
	var state string
	var epoch, version int64
	var receipts int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT s.authorization_state,s.authorization_epoch,e.config_version,(SELECT count(*) FROM webhook_operations WHERE operation_id=$2) FROM webhook_subscriptions s JOIN webhook_endpoints e ON e.id=s.endpoint_id WHERE s.id=$1`, sub, confirm.OperationID).Scan(&state, &epoch, &version, &receipts); err != nil {
		t.Fatal(err)
	}
	if state != "confirmation_required" || epoch != 2 || version != 1 || receipts != 0 {
		t.Fatalf("rejected confirmation changed state: %s %d %d %d", state, epoch, version, receipts)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_subscriptions SET authorization_state='active' WHERE id=$1`, sub); err != nil {
		t.Fatal(err)
	}
	confirm.OperationID = uuid.NewString()
	result, err = f.svc.Mutate(f.ctx, p, owner, confirm)
	if err != nil {
		t.Fatal(err)
	}
	op, _ := body(t, result)
	if op["effect"] != "unchanged" || op["configVersionAfter"] != "1" {
		t.Fatalf("redundant confirmation: %#v", op)
	}
}
