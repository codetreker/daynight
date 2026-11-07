package webhook_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func readRetainedPayload(t *testing.T, r *retentionHTTP, delivery string, want int) ([]byte, http.Header) {
	t.Helper()
	req, err := http.NewRequestWithContext(r.f.ctx, http.MethodGet, r.host.URL+"/api/v1/me/webhooks/"+r.endpoint+"/deliveries/"+delivery+"/payload", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: r.token})
	req.Header.Set("Origin", "https://daynight.example")
	res, err := r.host.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != want || res.Header.Get("Daynight-User-ID") != r.f.principal.UserID || res.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("payload status=%d headers=%v body=%s", res.StatusCode, res.Header, body)
	}
	return body, res.Header
}

func TestPayloadHTTPExactBytesAndCurrentChanges(t *testing.T) {
	r := newRetentionHTTP(t, false)
	prefix, suffix := `{"data":"`, `"}  `
	marker := "<script>alert(1)</script>"
	original := []byte(prefix + marker + strings.Repeat(" ", 65536-len(prefix)-len(marker)-len(suffix)) + suffix)
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `UPDATE webhook_deliveries SET body=$2,original_body_bytes=octet_length($2::bytea),body_sha256=sha256($2::bytea) WHERE id=$1`, r.delivery, original); err != nil {
		t.Fatal(err)
	}
	assertPayload := func() {
		t.Helper()
		body, headers := readRetainedPayload(t, r, r.delivery, 200)
		if !strings.HasPrefix(headers.Get("Content-Type"), "application/json") {
			t.Fatalf("payload not JSON: %v", headers)
		}
		var value struct {
			Owner                                                struct{ Kind, ID string }
			EndpointID, DeliveryID, EventID, MediaType, Encoding string
			Body                                                 []byte
			Bytes                                                int
			SHA256                                               string
		}
		if err := json.Unmarshal(body, &value); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(original)
		if value.Owner.Kind != "personal" || value.Owner.ID != r.f.principal.UserID || value.EndpointID != r.endpoint || value.DeliveryID != r.delivery || value.EventID == "" || value.MediaType != "application/cloudevents+json" || value.Encoding != "base64" || value.Bytes != 65536 || value.SHA256 != hex.EncodeToString(sum[:]) || !bytes.Equal(value.Body, original) {
			t.Fatalf("payload bytes or envelope differ: %+v", value)
		}
	}
	assertPayload()
	var task string
	var version int64
	if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT e.task_id::text,t.version FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id JOIN tasks t ON t.id=e.task_id WHERE d.id=$1`, r.delivery).Scan(&task, &version); err != nil {
		t.Fatal(err)
	}
	title := "Changed current task"
	if _, err := taskservice.NewTasks(r.f.db, r.f.capture).Update(r.f.ctx, r.f.principal, r.f.project, task, taskcore.UpdateTask{Version: version, Title: &title}); err != nil {
		t.Fatal(err)
	}
	name := "Changed endpoint"
	_, err := r.svc.Mutate(r.f.ctx, r.f.principal, webhook.Owner{Kind: "personal", ID: r.f.principal.UserID}, webhook.Mutation{Kind: "endpoint.update", EndpointID: r.endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: r.f.principal.UserID, IfVersion: 1, RequestSHA256: strings.Repeat("a", 64), Name: &name})
	if err != nil {
		t.Fatal(err)
	}
	assertPayload()
}

// Constraints are removed only in isolated test schemas to inject corrupt data
// that the normal PostgreSQL writers cannot produce.
func dropPayloadChecks(t *testing.T, r *retentionHTTP, maximum bool) {
	t.Helper()
	rows, err := r.f.db.Pool.Query(r.f.ctx, `SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='webhook_deliveries'::regclass AND contype='c'`)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for rows.Next() {
		var name, def string
		if err = rows.Scan(&name, &def); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(def, "octet_length(body)") || (maximum && strings.Contains(def, "original_body_bytes") && !strings.Contains(def, "octet_length")) {
			names = append(names, name)
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(names) == 0 {
		t.Fatal("payload constraint not found")
	}
	for _, name := range names {
		if _, err = r.f.db.Pool.Exec(r.f.ctx, `ALTER TABLE webhook_deliveries DROP CONSTRAINT `+pgx.Identifier{name}.Sanitize()); err != nil {
			t.Fatal(err)
		}
	}
}

func TestPayloadHTTPCorruptionFailsClosed(t *testing.T) {
	for _, kind := range []string{"bad hash", "missing body", "too large", "premature removal"} {
		t.Run(kind, func(t *testing.T) {
			r := newRetentionHTTP(t, false)
			if kind != "premature removal" {
				dropPayloadChecks(t, r, kind == "too large")
			}
			switch kind {
			case "premature removal":
				_, err := r.f.db.Pool.Exec(r.f.ctx, `UPDATE webhook_deliveries SET body=NULL,payload_removed_at=clock_timestamp(),payload_removed_reason='expired' WHERE id=$1`, r.delivery)
				if err != nil {
					t.Fatal(err)
				}
			case "bad hash":
				_, err := r.f.db.Pool.Exec(r.f.ctx, `UPDATE webhook_deliveries SET body_sha256=sha256(convert_to('wrong','UTF8')) WHERE id=$1`, r.delivery)
				if err != nil {
					t.Fatal(err)
				}
			case "missing body":
				_, err := r.f.db.Pool.Exec(r.f.ctx, `UPDATE webhook_deliveries SET body=NULL WHERE id=$1`, r.delivery)
				if err != nil {
					t.Fatal(err)
				}
			case "too large":
				b := bytes.Repeat([]byte("x"), 65537)
				_, err := r.f.db.Pool.Exec(r.f.ctx, `UPDATE webhook_deliveries SET body=$2,original_body_bytes=octet_length($2::bytea),body_sha256=sha256($2::bytea) WHERE id=$1`, r.delivery, b)
				if err != nil {
					t.Fatal(err)
				}
			}
			body, _ := readRetainedPayload(t, r, r.delivery, 500)
			if strings.Contains(string(body), "body_sha256") || strings.Contains(string(body), "wrong") {
				t.Fatalf("internal details leaked: %s", body)
			}
		})
	}
}

func TestPayloadHTTPCurrentAccessTaskAndStepDeletion(t *testing.T) {
	r := newRetentionHTTP(t, false)
	var task, team string
	var version int64
	if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT e.task_id::text,t.version,o.team_id::text FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id JOIN tasks t ON t.id=e.task_id JOIN project_ownership o ON o.project_id=e.project_id WHERE d.id=$1`, r.delivery).Scan(&task, &version, &team); err != nil {
		t.Fatal(err)
	}
	readRetainedPayload(t, r, r.delivery, 200)
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team, r.f.principal.UserID); err != nil {
		t.Fatal(err)
	}
	readRetainedPayload(t, r, r.delivery, 403)
	if _, err := r.f.db.Pool.Exec(r.f.ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, team, r.f.principal.UserID); err != nil {
		t.Fatal(err)
	}
	steps := taskservice.NewTaskSteps(r.f.db, r.f.capture)
	added, err := steps.Add(r.f.ctx, r.f.principal, r.f.project, task, taskservice.AddTaskStep{Version: version, ID: "00000001", Title: "step"})
	if err != nil {
		t.Fatal(err)
	}
	var stepDelivery string
	if err = r.f.db.Pool.QueryRow(r.f.ctx, `SELECT d.id::text FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE e.task_id=$1 AND e.event_type='task.step_updated' ORDER BY e.task_version LIMIT 1`, task).Scan(&stepDelivery); err != nil {
		t.Fatal(err)
	}
	deleted, err := steps.Delete(r.f.ctx, r.f.principal, r.f.project, task, "00000001", taskservice.DeleteTaskStep{Version: added.Resource.Version})
	if err != nil {
		t.Fatal(err)
	}
	readRetainedPayload(t, r, stepDelivery, 200)
	if err = taskservice.NewTasks(r.f.db, r.f.capture).Delete(r.f.ctx, r.f.principal, r.f.project, task, taskcore.DeleteTask{Version: deleted.Resource.Version}); err != nil {
		t.Fatal(err)
	}
	readRetainedPayload(t, r, r.delivery, 403)
	readRetainedPayload(t, r, stepDelivery, 403)
	var deletedDelivery string
	if err = r.f.db.Pool.QueryRow(r.f.ctx, `SELECT d.id::text FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE e.task_id=$1 AND e.event_type='task.deleted'`, task).Scan(&deletedDelivery); err != nil {
		t.Fatal(err)
	}
	body, _ := readRetainedPayload(t, r, deletedDelivery, 200)
	var envelope struct{ Body []byte }
	if err = json.Unmarshal(body, &envelope); err != nil || !bytes.Contains(envelope.Body, []byte(`task.deleted`)) {
		t.Fatalf("deleted event body missing: %v", err)
	}
}

func TestPayloadHTTPOriginalDeadlineWithoutGC(t *testing.T) {
	r := newRetentionHTTP(t, false)
	shiftRetentionOccurrence(t, r, "6 days 23 hours 59 minutes 55 seconds")
	readRetainedPayload(t, r, r.delivery, 200)
	waitRetentionDeadline(t, r, "payload_expires_at")
	readRetainedPayload(t, r, r.delivery, 410)
	var exists bool
	if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT body IS NOT NULL AND payload_removed_at IS NULL FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&exists); err != nil || !exists {
		t.Fatalf("fixture unexpectedly cleared payload: %v", err)
	}
}
