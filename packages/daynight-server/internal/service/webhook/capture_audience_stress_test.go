//go:build stress

package webhook_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
)

func TestCaptureCompleteAudienceBeyondFormerLimitsStress(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Fatal("stress tests are prohibited in CI")
	}
	f := newCaptureFixture(t, 51)
	svc := &webhook.Service{DB: f.db, ConfigurationExpansionAvailable: true}
	name, enabled := "Another receiver", true
	for i := 0; i < 256; i++ {
		m := webhook.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID,
			RequestSHA256: strings.Repeat("b", 64), Name: &name, Enabled: &enabled, Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/hook"},
			HasSubscriptions: true, Subscriptions: []corewebhook.SubscriptionInput{{ProjectID: f.project, EventTypes: []string{"task.created"}}}}
		if _, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, m); err != nil {
			t.Fatalf("endpoint %d: %v", i, err)
		}
	}
	created, err := taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "large audience"})
	if err != nil {
		t.Fatal(err)
	}
	var events, deliveries, matches, maxProof int
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_events WHERE task_id=$1), (SELECT count(*) FROM webhook_deliveries), (SELECT count(*) FROM webhook_delivery_matches), (SELECT max(original_match_count) FROM webhook_deliveries)`, created.ID).Scan(&events, &deliveries, &matches, &maxProof); err != nil {
		t.Fatal(err)
	}
	if events != 1 || deliveries != 257 || matches != 307 || maxProof != 51 {
		t.Fatalf("audience events=%d deliveries=%d matches=%d largest=%d", events, deliveries, matches, maxProof)
	}
	type responsibility struct {
		id                   string
		count                int64
		hash, body, bodyHash []byte
	}
	rows, err := f.db.Pool.Query(f.ctx, `SELECT id::text,original_match_count,original_match_sha256,body,body_sha256 FROM webhook_deliveries ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	var all []responsibility
	for rows.Next() {
		var x responsibility
		if err = rows.Scan(&x.id, &x.count, &x.hash, &x.body, &x.bodyHash); err != nil {
			t.Fatal(err)
		}
		all = append(all, x)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	var eventBody []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT fact_bytes FROM webhook_events WHERE task_id=$1`, created.ID).Scan(&eventBody); err != nil {
		t.Fatal(err)
	}

	load := func(query string, args ...any) [][5]string {
		t.Helper()
		rows, err := f.db.Pool.Query(f.ctx, query, args...)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var result [][5]string
		for rows.Next() {
			var a, b, c, d string
			var epoch int64
			if err = rows.Scan(&a, &b, &c, &d, &epoch); err != nil {
				t.Fatal(err)
			}
			result = append(result, [5]string{a, b, c, d, fmt.Sprint(epoch)})
		}
		if err = rows.Err(); err != nil {
			t.Fatal(err)
		}
		return result
	}
	for _, d := range all {
		actual := load(`SELECT subscription_id::text,binding_id::text,project_id::text,event_type,authorization_epoch FROM webhook_delivery_matches WHERE delivery_id=$1 ORDER BY subscription_id,binding_id`, d.id)
		expected := load(`SELECT s.id::text,b.id::text,s.project_id::text,b.event_type,s.authorization_epoch FROM webhook_subscriptions s JOIN webhook_bindings b ON b.subscription_id=s.id JOIN webhook_deliveries d ON d.endpoint_id=s.endpoint_id WHERE d.id=$1 AND s.deleted_at IS NULL AND b.deleted_at IS NULL AND b.event_type='task.created' ORDER BY s.id,b.id`, d.id)
		actualJSON, err := json.Marshal(actual)
		if err != nil {
			t.Fatal(err)
		}
		expectedJSON, err := json.Marshal(expected)
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(actualJSON)
		bodyDigest := sha256.Sum256(d.body)
		if int64(len(actual)) != d.count || !bytes.Equal(actualJSON, expectedJSON) || !bytes.Equal(d.hash, digest[:]) || !bytes.Equal(d.body, eventBody) || !bytes.Equal(d.bodyHash, bodyDigest[:]) {
			t.Fatalf("delivery %s: original tuple/body/hash mismatch", d.id)
		}
	}
}
