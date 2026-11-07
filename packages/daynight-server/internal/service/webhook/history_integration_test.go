package webhook_test

import (
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
)

func TestHistorySnapshotCapturePayloadAndPagination(t *testing.T) {
	f := newCaptureFixture(t, 1)
	tasks := taskservice.NewTasks(f.db, f.capture)
	for _, title := range []string{"one", "two"} {
		if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: title}); err != nil {
			t.Fatal(err)
		}
	}
	var endpoint, id string
	var body []byte
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT endpoint_id::text,id::text,body FROM webhook_deliveries ORDER BY occurred_at,id LIMIT 1`).Scan(&endpoint, &id, &body); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys}
	owner := webhook.Owner{Kind: "personal", ID: f.principal.UserID}
	value, err := svc.GetDelivery(f.ctx, f.principal, owner, endpoint, id)
	if err != nil {
		t.Fatal(err)
	}
	v := value.(map[string]any)
	if v["disclosure"] != "full" || v["state"] != "pending" || v["payloadAvailable"] != true {
		t.Fatalf("unexpected view: %#v", v)
	}
	value, err = svc.Payload(f.ctx, f.principal, owner, endpoint, id)
	if err != nil {
		t.Fatal(err)
	}
	p := value.(map[string]any)
	decoded, err := base64.StdEncoding.DecodeString(p["body"].(string))
	if err != nil || !bytes.Equal(decoded, body) || p["bytes"] != len(body) {
		t.Fatal("payload did not preserve original bytes")
	}
	value, err = svc.ListDeliveries(f.ctx, f.principal, owner, endpoint, webhook.DeliveryQuery{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	first := value.(map[string]any)
	if len(first["items"].([]any)) != 1 || first["nextCursor"] == nil {
		t.Fatalf("first page: %#v", first)
	}
	cursor := first["nextCursor"].(string)
	value, err = svc.ListDeliveries(f.ctx, f.principal, owner, endpoint, webhook.DeliveryQuery{Limit: 1, Cursor: &cursor})
	if err != nil {
		t.Fatal(err)
	}
	second := value.(map[string]any)
	if len(second["items"].([]any)) != 1 || second["nextCursor"] != nil {
		t.Fatalf("second page: %#v", second)
	}
	if _, err = svc.ListDeliveries(f.ctx, f.principal, owner, endpoint, webhook.DeliveryQuery{Limit: 1, Cursor: &cursor, State: "failed"}); err == nil {
		t.Fatal("cursor filter mismatch accepted")
	}
	value, err = svc.ListAttempts(f.ctx, f.principal, owner, endpoint, id, webhook.AttemptQuery{})
	if err != nil {
		t.Fatal(err)
	}
	if len(value.(map[string]any)["items"].([]any)) != 0 {
		t.Fatal("unexpected attempt")
	}
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_events SET fact_bytes=NULL,fact_removed_at=now() WHERE id=(SELECT event_id FROM webhook_deliveries WHERE id=$1)`, id); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.GetDelivery(f.ctx, f.principal, owner, endpoint, id); err == nil {
		t.Fatal("missing open fact accepted")
	}
}

func TestHistoryCursorSurvivesNewDeliveryAndKeyRotation(t *testing.T) {
	f := newCaptureFixture(t, 1)
	tasks := taskservice.NewTasks(f.db, f.capture)
	firstTask, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "first"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "second"}); err != nil {
		t.Fatal(err)
	}
	var endpoint string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT endpoint_id::text FROM webhook_deliveries LIMIT 1`).Scan(&endpoint); err != nil {
		t.Fatal(err)
	}
	owner := webhook.Owner{Kind: "personal", ID: f.principal.UserID}
	first := &webhook.Service{DB: f.db, Keys: f.capture.Keys}
	page, err := first.ListDeliveries(f.ctx, f.principal, owner, endpoint, webhook.DeliveryQuery{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	cursor := page.(map[string]any)["nextCursor"].(string)
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(decoded), f.project) || strings.Contains(string(decoded), firstTask.ID) || strings.Contains(string(decoded), "true:") {
		t.Fatal("cursor exposed disclosure state")
	}
	if _, err = tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "new after first page"}); err != nil {
		t.Fatal(err)
	}
	newProject, newSubscription := uuid.NewString(), uuid.NewString()
	var team string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, f.project).Scan(&team); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'new project','https://example.test/other')`, newProject); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, newProject, team); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `INSERT INTO webhook_subscriptions(id,endpoint_id,project_id,owner_kind,owner_id,authorization_state,authorization_epoch,created_at,updated_at) VALUES($1,$2,$3,'personal',$4,'active',1,clock_timestamp(),clock_timestamp())`, newSubscription, endpoint, newProject, f.principal.UserID); err != nil {
		t.Fatal(err)
	}
	primary := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{1}, 32))
	next := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{2}, 32))
	keys, err := secretbox.Parse([]byte(`{"activeKeyId":"next","keys":{"primary":"` + primary + `","next":"` + next + `"}}`))
	if err != nil {
		t.Fatal(err)
	}
	rotated := &webhook.Service{DB: f.db, Keys: keys}
	page, err = rotated.ListDeliveries(f.ctx, f.principal, owner, endpoint, webhook.DeliveryQuery{Limit: 1, Cursor: &cursor})
	if err != nil || len(page.(map[string]any)["items"].([]any)) != 1 || page.(map[string]any)["nextCursor"] == nil {
		t.Fatalf("new record or rotation invalidated cursor: %#v %v", page, err)
	}
	if err = tasks.Delete(f.ctx, f.principal, f.project, firstTask.ID, taskcore.DeleteTask{Version: firstTask.Version}); err != nil {
		t.Fatal(err)
	}
	if _, err = rotated.ListDeliveries(f.ctx, f.principal, owner, endpoint, webhook.DeliveryQuery{Limit: 1, Cursor: &cursor}); err == nil {
		t.Fatal("cursor survived a task disclosure change")
	}
}

func TestHistoryRevocationAndRetention(t *testing.T) {
	f := newCaptureFixture(t, 1)
	tasks := taskservice.NewTasks(f.db, f.capture)
	for _, title := range []string{"one", "two"} {
		if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: title}); err != nil {
			t.Fatal(err)
		}
	}
	var endpoint, id, team string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT d.endpoint_id::text,d.id::text,o.team_id::text FROM webhook_deliveries d JOIN project_ownership o ON o.project_id=d.project_id ORDER BY d.occurred_at,d.id LIMIT 1`).Scan(&endpoint, &id, &team); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys}
	owner := webhook.Owner{Kind: "personal", ID: f.principal.UserID}
	value, err := svc.ListDeliveries(f.ctx, f.principal, owner, endpoint, webhook.DeliveryQuery{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	cursor := value.(map[string]any)["nextCursor"].(string)
	if _, err = f.db.Pool.Exec(f.ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team, f.principal.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.ListDeliveries(f.ctx, f.principal, owner, endpoint, webhook.DeliveryQuery{Limit: 1, Cursor: &cursor}); err == nil {
		t.Fatal("cursor survived disclosure change")
	}
	value, err = svc.GetDelivery(f.ctx, f.principal, owner, endpoint, id)
	if err != nil {
		t.Fatal(err)
	}
	if v := value.(map[string]any); v["disclosure"] != "metadata_only" || v["state"] != "suppressed" {
		t.Fatalf("revoked view: %#v", v)
	}
	if _, err = svc.Payload(f.ctx, f.principal, owner, endpoint, id); err == nil {
		t.Fatal("payload available after access loss")
	}
	if _, err = f.db.Pool.Exec(f.ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, team, f.principal.UserID); err != nil {
		t.Fatal(err)
	}
	// The fixture sets a terminal deadline directly to exercise logical expiry before GC.
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET state='suppressed',next_attempt_at=NULL,terminal_at=now()-interval '31 days',last_activity_at=now()-interval '31 days',metadata_expires_at=now()-interval '1 day' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.GetDelivery(f.ctx, f.principal, owner, endpoint, id); err == nil {
		t.Fatal("expired metadata was exposed before GC")
	}
	// A real observation extending retained history remains visible before maintenance.
	if _, err = f.db.Pool.Exec(f.ctx, `INSERT INTO webhook_attempts(id,delivery_id,endpoint_id,generation,sequence,trigger,lease_token,destination_revision,signing_key_ids,automatic_plan_slot,claimed_at,admitted_at,finished_at,outcome) SELECT gen_random_uuid(),d.id,d.endpoint_id,d.generation,1,'automatic',gen_random_uuid(),d.destination_revision,ARRAY[e.active_key_id],1,now()-interval '31 days',now()-interval '31 days',now(),'acknowledged' FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE webhook_deliveries SET attempt_sequence=1,automatic_attempt_count=1 WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.GetDelivery(f.ctx, f.principal, owner, endpoint, id); err != nil {
		t.Fatalf("recent observation did not retain history: %v", err)
	}
}

func TestHistoryProjectReadIndependentOfSendEligibility(t *testing.T) {
	f := newCaptureFixture(t, 1)
	var team string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, f.project).Scan(&team); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true}
	owner := webhook.Owner{Kind: "team", ID: team}
	name, enabled := "team receiver", true
	_, err := svc.Mutate(f.ctx, f.principal, owner, webhook.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, RequestSHA256: strings.Repeat("a", 64), Name: &name, Enabled: &enabled, Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/hook"}, HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{{ProjectID: f.project, EventTypes: []string{"task.created"}}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "source"}); err != nil {
		t.Fatal(err)
	}
	var endpoint, id string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT endpoint_id::text,id::text FROM webhook_deliveries WHERE owner_kind='team'`).Scan(&endpoint, &id); err != nil {
		t.Fatal(err)
	}
	other := uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO teams(id,name) VALUES($1,'new owner')`, []any{other}},
		{`INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, []any{f.project, f.principal.UserID}},
		{`UPDATE project_ownership SET team_id=$1 WHERE project_id=$2`, []any{other, f.project}},
	} {
		if _, err = f.db.Pool.Exec(f.ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	value, err := svc.GetDelivery(f.ctx, f.principal, owner, endpoint, id)
	if err != nil {
		t.Fatal(err)
	}
	view := value.(map[string]any)
	if view["disclosure"] != "full" || view["state"] != "suppressed" {
		t.Fatalf("independent access: %#v", view)
	}
	if _, err = svc.Payload(f.ctx, f.principal, owner, endpoint, id); err != nil {
		t.Fatalf("direct project access lost: %v", err)
	}
}
