package webhook

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/google/uuid"
)

func TestSubscriptionIntentValidation(t *testing.T) {
	project, id := uuid.NewString(), uuid.NewString()
	valid := core.SubscriptionInput{ID: &id, ProjectID: project, EventTypes: []string{"task.created"}}
	tests := []struct {
		name  string
		input Mutation
	}{
		{"project UUID", Mutation{Subscriptions: []core.SubscriptionInput{{ProjectID: "bad", EventTypes: []string{"task.created"}}}}},
		{"zero project", Mutation{Subscriptions: []core.SubscriptionInput{{ProjectID: "00000000-0000-0000-0000-000000000000", EventTypes: []string{"task.created"}}}}},
		{"empty events", Mutation{Subscriptions: []core.SubscriptionInput{{ProjectID: project}}}},
		{"bad subscription ID", Mutation{Subscriptions: []core.SubscriptionInput{{ID: ptrString("bad"), ProjectID: project, EventTypes: []string{"task.created"}}}}},
		{"zero subscription ID", Mutation{Subscriptions: []core.SubscriptionInput{{ID: ptrString("00000000-0000-0000-0000-000000000000"), ProjectID: project, EventTypes: []string{"task.created"}}}}},
		{"duplicate subscription", Mutation{Subscriptions: []core.SubscriptionInput{valid, valid}}},
		{"unknown event", Mutation{Subscriptions: []core.SubscriptionInput{{ProjectID: project, EventTypes: []string{"task.unknown"}}}}},
		{"duplicate event", Mutation{Subscriptions: []core.SubscriptionInput{{ProjectID: project, EventTypes: []string{"task.created", "task.created"}}}}},
		{"invalid confirmation", Mutation{ConfirmProjectIDs: []string{"bad"}}},
		{"zero confirmation", Mutation{ConfirmProjectIDs: []string{"00000000-0000-0000-0000-000000000000"}}},
		{"duplicate confirmation", Mutation{ConfirmProjectIDs: []string{project, project}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) { expectFault(t, validSubscriptionInput(tc.input), "invalid_input") })
	}
	if err := validSubscriptionInput(Mutation{Subscriptions: []core.SubscriptionInput{valid}, ConfirmProjectIDs: []string{project}}); err != nil {
		t.Fatal(err)
	}
}

func ptrString(value string) *string { return &value }

func TestSubscriptionWriteFailuresRollBackEndpointAndReceipt(t *testing.T) {
	for _, kind := range []string{"subscription_insert", "binding_insert", "binding_retire"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t, false)
			p := f.principal(t)
			team, project := uuid.NewString(), uuid.NewString()
			for _, q := range []struct {
				sql  string
				args []any
			}{
				{`INSERT INTO teams(id,name) VALUES($1,'team')`, []any{team}},
				{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, []any{team, p.UserID}},
				{`INSERT INTO projects(id,name,repo_url) VALUES($1,'Project',$2)`, []any{project, "https://example.test/" + project}},
				{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
			} {
				if _, err := f.db.Pool.Exec(f.ctx, q.sql, q.args...); err != nil {
					t.Fatal(err)
				}
			}
			owner := Owner{Kind: "personal", ID: p.UserID}
			create := createMutation(p, "failure", "https://receiver.example/hook")
			create.Subscriptions = []core.SubscriptionInput{{ProjectID: project, EventTypes: []string{"task.created", "task.paused"}}}
			result, err := f.svc.Mutate(f.ctx, p, owner, create)
			if err != nil {
				t.Fatal(err)
			}
			_, ep := body(t, result)
			endpoint := ep["id"].(string)
			sub := ep["subscriptions"].([]any)[0].(map[string]any)["id"].(string)
			if _, err = f.db.Pool.Exec(f.ctx, `CREATE FUNCTION fail_subscription_save() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected subscription save failure'; END $$`); err != nil {
				t.Fatal(err)
			}
			trigger := `CREATE TRIGGER fail_subscription_save BEFORE INSERT ON webhook_subscriptions FOR EACH ROW EXECUTE FUNCTION fail_subscription_save()`
			if kind == "binding_insert" {
				trigger = `CREATE TRIGGER fail_subscription_save BEFORE INSERT ON webhook_bindings FOR EACH ROW EXECUTE FUNCTION fail_subscription_save()`
			}
			if kind == "binding_retire" {
				trigger = `CREATE TRIGGER fail_subscription_save BEFORE UPDATE ON webhook_bindings FOR EACH ROW EXECUTE FUNCTION fail_subscription_save()`
			}
			if _, err = f.db.Pool.Exec(f.ctx, trigger); err != nil {
				t.Fatal(err)
			}
			update := mutation(p, "endpoint.update", endpoint, 1)
			update.HasSubscriptions = true
			update.Subscriptions = []core.SubscriptionInput{{ID: &sub, ProjectID: project, EventTypes: []string{"task.created", "task.paused"}}}
			if kind == "subscription_insert" {
				update.Subscriptions = append(update.Subscriptions, core.SubscriptionInput{ProjectID: project, EventTypes: []string{"task.created"}})
			}
			if kind == "binding_insert" {
				update.Subscriptions[0].EventTypes = append(update.Subscriptions[0].EventTypes, "task.deleted")
			}
			if kind == "binding_retire" {
				update.Subscriptions[0].EventTypes = []string{"task.created"}
			}
			_, err = f.svc.Mutate(f.ctx, p, owner, update)
			failed, sqlstate := store.DatabaseErrorFacts(err)
			if !failed || sqlstate != "P0001" {
				t.Fatalf("expected injected database failure: %v SQLSTATE %s", err, sqlstate)
			}
			var version int64
			var subs, active, retired, receipts int
			err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT config_version FROM webhook_endpoints WHERE id=$1), (SELECT count(*) FROM webhook_subscriptions WHERE endpoint_id=$1 AND deleted_at IS NULL), (SELECT count(*) FROM webhook_bindings WHERE subscription_id=$2 AND deleted_at IS NULL), (SELECT count(*) FROM webhook_bindings WHERE subscription_id=$2 AND deleted_at IS NOT NULL), (SELECT count(*) FROM webhook_operations WHERE operation_id=$3)`, endpoint, sub, update.OperationID).Scan(&version, &subs, &active, &retired, &receipts)
			if err != nil || version != 1 || subs != 1 || active != 2 || retired != 0 || receipts != 0 {
				t.Fatalf("rollback: version=%d subs=%d active=%d retired=%d receipts=%d err=%v", version, subs, active, retired, receipts, err)
			}
		})
	}
}
