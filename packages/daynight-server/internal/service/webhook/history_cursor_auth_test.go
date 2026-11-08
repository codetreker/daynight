package webhook_test

import (
	"encoding/base64"
	"testing"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

func TestHistoryCursorsValidateScopeFiltersPositionsAndDisclosure(t *testing.T) {
	f := newCaptureFixture(t, 1)
	tasks := taskservice.NewTasks(f.db, f.capture)
	for _, title := range []string{"first", "second"} {
		if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: title}); err != nil {
			t.Fatal(err)
		}
	}
	var endpoint, id, other, team string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.endpoint_id::text,d.id::text,o.team_id::text FROM webhook_deliveries d JOIN project_ownership o ON o.project_id=d.project_id ORDER BY d.occurred_at,d.id LIMIT 1`).Scan(&endpoint, &id, &team); err != nil {
		t.Fatal(err)
	}
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text FROM webhook_deliveries WHERE id<>$1`, id).Scan(&other); err != nil {
		t.Fatal(err)
	}
	for n := 1; n <= 2; n++ {
		if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO webhook_attempts(id,delivery_id,endpoint_id,generation,sequence,trigger,lease_token,destination_revision,signing_key_ids,automatic_plan_slot,claimed_at,admitted_at) SELECT gen_random_uuid(),d.id,d.endpoint_id,$2::smallint,$2::smallint,'automatic',gen_random_uuid(),d.destination_revision,ARRAY[e.active_key_id],$2::smallint,now(),now() FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1`, id, n); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET generation=2,attempt_sequence=2,automatic_attempt_count=2 WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	owner := webhook.Owner{Kind: "personal", ID: f.principal.UserID}
	svc := &webhook.Service{DB: f.db}
	page, err := svc.ListDeliveries(f.ctx, f.principal, owner, endpoint, webhook.DeliveryQuery{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	deliveryCursor := page.(map[string]any)["nextCursor"].(string)
	page, err = svc.ListAttempts(f.ctx, f.principal, owner, endpoint, id, webhook.AttemptQuery{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	attemptCursor := page.(map[string]any)["nextCursor"].(string)
	tamper := func(v string) string {
		b, e := base64.RawURLEncoding.DecodeString(v)
		if e != nil {
			t.Fatal(e)
		}
		b[len(b)-1] ^= 1
		return base64.RawURLEncoding.EncodeToString(b)
	}
	badDelivery, badAttempt := tamper(deliveryCursor), tamper(attemptCursor)
	if _, err = svc.ListDeliveries(f.ctx, f.principal, owner, endpoint, webhook.DeliveryQuery{Limit: 1, Cursor: &badDelivery}); err == nil {
		t.Fatal("tampered delivery cursor accepted")
	}
	if _, err = svc.ListAttempts(f.ctx, f.principal, owner, endpoint, id, webhook.AttemptQuery{Limit: 1, Cursor: &badAttempt}); err == nil {
		t.Fatal("tampered attempt cursor accepted")
	}
	if _, err = svc.ListDeliveries(f.ctx, f.principal, owner, endpoint, webhook.DeliveryQuery{Limit: 1, Cursor: &deliveryCursor, State: "failed"}); err == nil {
		t.Fatal("delivery filter mismatch accepted")
	}
	generation := int64(1)
	if _, err = svc.ListAttempts(f.ctx, f.principal, owner, endpoint, id, webhook.AttemptQuery{Limit: 1, Cursor: &attemptCursor, Generation: &generation}); err == nil {
		t.Fatal("attempt generation mismatch accepted")
	}
	if _, err = svc.ListAttempts(f.ctx, f.principal, owner, endpoint, other, webhook.AttemptQuery{Limit: 1, Cursor: &attemptCursor}); err == nil {
		t.Fatal("different delivery scope accepted")
	}
	rotated := &webhook.Service{DB: f.db}
	if _, err = rotated.ListAttempts(f.ctx, f.principal, owner, endpoint, id, webhook.AttemptQuery{Limit: 1, Cursor: &attemptCursor}); err != nil {
		t.Fatalf("restarted service attempt cursor: %v", err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team, f.principal.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err = rotated.ListAttempts(f.ctx, f.principal, owner, endpoint, id, webhook.AttemptQuery{Limit: 1, Cursor: &attemptCursor}); err == nil {
		t.Fatal("attempt disclosure change accepted")
	}
}
