package webhook_test

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
)

func TestHistoryCursorUsesRetainedSourcesWithoutSubscription(t *testing.T) {
	f := newCaptureFixture(t, 1)
	tasks := taskservice.NewTasks(f.db, f.capture)
	unrelated, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "before team subscription"})
	if err != nil {
		t.Fatal(err)
	}
	var team string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, f.project).Scan(&team); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
	owner := webhook.Owner{Kind: "team", ID: team}
	name, enabled := "team receiver", true
	_, err = svc.Mutate(f.ctx, f.principal, owner, webhook.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, RequestSHA256: strings.Repeat("a", 64), Name: &name, Enabled: &enabled, Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/hook"}, HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{{ProjectID: f.project, EventTypes: []string{"task.created"}}}})
	if err != nil {
		t.Fatal(err)
	}
	for _, title := range []string{"first team event", "second team event"} {
		if _, err = tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: title}); err != nil {
			t.Fatal(err)
		}
	}
	var endpoint string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT id::text FROM webhook_endpoints WHERE owner_kind='team'`).Scan(&endpoint); err != nil {
		t.Fatal(err)
	}
	// The format permits current subscriptions to be gone while immutable matches remain.
	if _, err = f.db.Pool.Exec(f.ctx, `DELETE FROM webhook_subscriptions WHERE endpoint_id=$1`, endpoint); err != nil {
		t.Fatal(err)
	}
	page, err := svc.ListDeliveries(f.ctx, f.principal, owner, endpoint, webhook.DeliveryQuery{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	cursor := page.(map[string]any)["nextCursor"].(string)
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(decoded), f.project) || strings.Contains(string(decoded), unrelated.ID) {
		t.Fatal("cursor exposed resource identities")
	}
	if err = tasks.Delete(f.ctx, f.principal, f.project, unrelated.ID, taskcore.DeleteTask{Version: unrelated.Version}); err != nil {
		t.Fatal(err)
	}
	if _, err = tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "new after baseline"}); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.ListDeliveries(f.ctx, f.principal, owner, endpoint, webhook.DeliveryQuery{Limit: 1, Cursor: &cursor}); err == nil {
		t.Fatal("conservative Task deletion binding did not invalidate cursor")
	}
	page, err = svc.ListDeliveries(f.ctx, f.principal, owner, endpoint, webhook.DeliveryQuery{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	cursor = page.(map[string]any)["nextCursor"].(string)
	other := uuid.NewString()
	if _, err = f.db.Pool.Exec(f.ctx, `INSERT INTO teams(id,name) VALUES($1,'new owner')`, other); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE project_ownership SET team_id=$1 WHERE project_id=$2`, other, f.project); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.ListDeliveries(f.ctx, f.principal, owner, endpoint, webhook.DeliveryQuery{Limit: 1, Cursor: &cursor}); err == nil {
		t.Fatal("cursor survived loss of source access")
	}
}

func TestHistoryCursorSurvivesExpiryPurgeAndPhysicalDeletion(t *testing.T) {
	f := newCaptureFixture(t, 1)
	tasks := taskservice.NewTasks(f.db, f.capture)
	for i := 0; i < 4; i++ {
		if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "retained source"}); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := f.db.Pool.Query(f.ctx, `SELECT endpoint_id::text,id::text,event_id::text FROM webhook_deliveries ORDER BY occurred_at,id`)
	if err != nil {
		t.Fatal(err)
	}
	type ids struct{ endpoint, delivery, event string }
	var records []ids
	for rows.Next() {
		var v ids
		if err = rows.Scan(&v.endpoint, &v.delivery, &v.event); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		records = append(records, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(records) != 4 {
		t.Fatalf("captured records=%v err=%v", records, err)
	}
	// Make one old, closed record naturally cross its metadata deadline after
	// the first page. The other records remain available for later pages.
	tx, err := f.db.Pool.Begin(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(f.ctx)
	if _, err = tx.Exec(f.ctx, `UPDATE webhook_events SET occurred_at=occurred_at-interval '31 days' WHERE id=$1`, records[0].event); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(f.ctx, `UPDATE webhook_deliveries SET occurred_at=occurred_at-interval '31 days',automatic_schedule_at=ARRAY(SELECT x-interval '31 days' FROM unnest(automatic_schedule_at) x),automatic_expires_at=automatic_expires_at-interval '31 days',payload_expires_at=payload_expires_at-interval '31 days',expires_at=expires_at-interval '31 days',state='failed',automatic_open=false,next_attempt_at=NULL,terminal_at=clock_timestamp()-interval '30 days'+interval '3 seconds',last_activity_at=clock_timestamp()-interval '30 days'+interval '3 seconds',metadata_expires_at=clock_timestamp()+interval '3 seconds' WHERE id=$1`, records[0].delivery); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(f.ctx); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db}
	owner := webhook.Owner{Kind: "personal", ID: f.principal.UserID}
	page, err := svc.ListDeliveries(f.ctx, f.principal, owner, records[0].endpoint, webhook.DeliveryQuery{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	first := page.(map[string]any)
	if first["items"].([]any)[0].(map[string]any)["id"] != records[0].delivery || first["nextCursor"] == nil {
		t.Fatalf("wrong first page: %#v", first)
	}
	cursor := first["nextCursor"].(string)
	// Add an unrelated Project and an unrelated Delivery after cursor issuance.
	project := uuid.NewString()
	var team string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, f.project).Scan(&team); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'unrelated','https://example.test/unrelated')`, project); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, project, team); err != nil {
		t.Fatal(err)
	}
	if _, err = tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "after cursor"}); err != nil {
		t.Fatal(err)
	}
	var deadline time.Time
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT metadata_expires_at FROM webhook_deliveries WHERE id=$1`, records[0].delivery).Scan(&deadline); err != nil {
		t.Fatal(err)
	}
	timer := time.NewTimer(time.Until(deadline) + 100*time.Millisecond)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-f.ctx.Done():
		t.Fatal(f.ctx.Err())
	}
	assertCursor := func() {
		t.Helper()
		page, err := svc.ListDeliveries(f.ctx, f.principal, owner, records[0].endpoint, webhook.DeliveryQuery{Limit: 1, Cursor: &cursor})
		if err != nil || len(page.(map[string]any)["items"].([]any)) != 1 {
			t.Fatalf("ordinary history change invalidated cursor: %#v %v", page, err)
		}
	}
	assertCursor()
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET purging_at=clock_timestamp() WHERE id=$1`, records[1].delivery); err != nil {
		t.Fatal(err)
	}
	assertCursor()
	if _, err = f.db.Pool.Exec(f.ctx, `DELETE FROM webhook_delivery_matches WHERE delivery_id=$1`, records[1].delivery); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `DELETE FROM webhook_deliveries WHERE id=$1`, records[1].delivery); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `DELETE FROM webhook_events WHERE id=$1`, records[1].event); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `DELETE FROM webhook_subscriptions WHERE endpoint_id=$1`, records[0].endpoint); err != nil {
		t.Fatal(err)
	}
	assertCursor()
}
