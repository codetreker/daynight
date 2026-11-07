package webhook_test

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// The fixture persists valid retained rows directly; it does not represent a
// delivery by the runner. These checks exercise the production HTTP mux and
// actual snapshot reader against PostgreSQL.
func insertSummaryDelivery(t *testing.T, f *httpFixture, endpoint, delivery, event string, purging bool) {
	t.Helper()
	_, err := f.db.Pool.Exec(f.ctx, `
INSERT INTO webhook_deliveries
(id,event_id,endpoint_id,owner_kind,owner_id,event_type,project_id,occurred_at,
 original_match_count,original_match_sha256,policy_version,destination_revision,destination_kind,
 adapter_version,render_version,configuration_schema_version,destination_origin,destination_envelope_version,
 destination_master_key_id,destination_nonce,destination_ciphertext,request_method,request_media_type,
 deterministic_headers_json,body,original_body_bytes,body_sha256,automatic_schedule_at,automatic_expires_at,
 payload_expires_at,automatic_plan_cursor,automatic_open,automatic_attempt_count,manual_operation_count,
 attempt_sequence,generation,state,trigger,expires_at,last_activity_at,metadata_expires_at,purging_at)
SELECT $1,$2,e.id,e.owner_kind,e.owner_id,'task.created',$3,now(),1,sha256('proof'::bytea),1,
 e.destination_revision,e.destination_kind,e.adapter_version,1,e.configuration_schema_version,e.destination_origin,
 e.destination_envelope_version,e.destination_master_key_id,e.destination_nonce,e.destination_ciphertext,
 'POST','application/cloudevents+json',convert_to('[]','UTF8'),convert_to('x','UTF8'),1,sha256(convert_to('x','UTF8')),
 ARRAY(SELECT now()+n*interval '1 minute' FROM generate_series(0,9) n),now()+interval '72 hours',
 now()+interval '168 hours',1,false,1,0,1,1,'failed','automatic',now()+interval '72 hours',now(),
 now()+interval '30 days',CASE WHEN $4 THEN now() ELSE NULL END
FROM webhook_endpoints e WHERE e.id=$5`, delivery, event, uuid.NewString(), purging, endpoint)
	if err != nil {
		t.Fatal(err)
	}
}

func insertSummaryAttempt(t *testing.T, f *httpFixture, endpoint, delivery, id string, sequence int, admitted time.Time, finished bool) {
	t.Helper()
	_, err := f.db.Pool.Exec(f.ctx, `
INSERT INTO webhook_attempts
(id,delivery_id,endpoint_id,generation,sequence,trigger,lease_token,destination_revision,signing_key_ids,
 automatic_plan_slot,claimed_at,admitted_at,finished_at,outcome,http_status,duration_ms)
SELECT $1,$2,e.id,1,$3,'automatic',$4,e.destination_revision,ARRAY[e.active_key_id],$3,
 $5::timestamptz,$5::timestamptz,CASE WHEN $6 THEN $5::timestamptz ELSE NULL END,CASE WHEN $6 THEN 'acknowledged' ELSE NULL END,
 CASE WHEN $6 THEN 204 ELSE NULL END,CASE WHEN $6 THEN 12 ELSE NULL END
FROM webhook_endpoints e WHERE e.id=$7`, id, delivery, sequence, uuid.NewString(), admitted, finished, endpoint)
	if err != nil {
		t.Fatal(err)
	}
}

func TestHistoryHTTPRetainedSummary(t *testing.T) {
	f := newHTTPFixture(t)
	actor := f.actor(t)
	base := "/api/v1/me/webhooks"
	status, _, body := f.request(t, actor, http.MethodPost, base, encoded(t, createFields(actor, "Summary", "https://receiver.example/private?secret=x")))
	mustStatus(t, status, http.StatusCreated, body)
	endpoint := jsonBody(t, body)["endpoint"].(map[string]any)["id"].(string)
	summary := func() map[string]any {
		t.Helper()
		status, _, b := f.request(t, actor, http.MethodGet, base, "")
		mustStatus(t, status, http.StatusOK, b)
		items := jsonBody(t, b)["items"].([]any)
		if len(items) != 1 {
			t.Fatalf("expected one summary: %s", b)
		}
		return items[0].(map[string]any)
	}
	s := summary()
	if value, ok := s["lastAttemptAt"]; !ok || value != nil {
		t.Fatalf("empty lastAttemptAt: %#v", s)
	}
	if value, ok := s["lastResult"]; !ok || value != nil {
		t.Fatalf("empty lastResult: %#v", s)
	}
	delivery := uuid.NewString()
	insertSummaryDelivery(t, f, endpoint, delivery, uuid.NewString(), false)
	at := time.Now().UTC().Truncate(time.Microsecond)
	olderID := "00000000-0000-4000-8000-000000000001"
	newerID := "00000000-0000-4000-8000-000000000002"
	insertSummaryAttempt(t, f, endpoint, delivery, olderID, 1, at, true)
	insertSummaryAttempt(t, f, endpoint, delivery, newerID, 2, at, false)
	purged := uuid.NewString()
	insertSummaryDelivery(t, f, endpoint, purged, uuid.NewString(), true)
	insertSummaryAttempt(t, f, endpoint, purged, uuid.NewString(), 1, at.Add(time.Hour), true)
	s = summary()
	gotTime, err := time.Parse(time.RFC3339Nano, fmt.Sprint(s["lastAttemptAt"]))
	if err != nil || !gotTime.Equal(at) || s["lastResult"] != nil {
		t.Fatalf("latest unfinished tie or purging selection: %#v (%v)", s, err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_attempts SET finished_at=admitted_at, outcome='http_error',http_status=500,duration_ms=7,error_code='receiver_error' WHERE id=$1`, newerID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_endpoints SET config_version=9007199254740993 WHERE id=$1`, endpoint); err != nil {
		t.Fatal(err)
	}
	s = summary()
	if s["configVersion"] != "9007199254740993" {
		t.Fatalf("summary version lost precision: %#v", s)
	}
	result, ok := s["lastResult"].(map[string]any)
	if !ok || result["category"] != "http_error" || result["code"] != "receiver_error" || result["httpStatus"] != float64(500) || result["durationMs"] != float64(7) || len(result) != 4 {
		t.Fatalf("latest result: %#v", s)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `ALTER TABLE webhook_attempts RENAME TO unavailable_webhook_attempts`); err != nil {
		t.Fatal(err)
	}
	status, _, body = f.request(t, actor, http.MethodGet, base, "")
	mustStatus(t, status, http.StatusServiceUnavailable, body)
	if jsonBody(t, body)["error"].(map[string]any)["code"] != "dependency_unavailable" || strings.Contains(string(body), "webhook_attempts") {
		t.Fatalf("reader failure leaked or fell back: %s", body)
	}
}

func TestHistoryHTTPAuthenticationIsolationAndStrictInputs(t *testing.T) {
	f := newHTTPFixture(t)
	admin, member, outsider := f.actor(t), f.actor(t), f.actor(t)
	team := uuid.NewString()
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO teams(id,name) VALUES($1,'shared')`, team); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member')`, team, admin.id, member.id); err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/teams/" + team + "/webhooks"
	status, _, body := f.request(t, admin, http.MethodPost, base, encoded(t, createFields(admin, "History", "https://receiver.example/private?secret=x")))
	mustStatus(t, status, http.StatusCreated, body)
	endpoint := jsonBody(t, body)["endpoint"].(map[string]any)["id"].(string)
	deliveries := base + "/" + endpoint + "/deliveries"
	delivery := deliveries + "/" + uuid.NewString()
	status, _, body = f.request(t, member, http.MethodGet, deliveries, "")
	mustStatus(t, status, http.StatusOK, body)
	page := jsonBody(t, body)
	if len(page["items"].([]any)) != 0 || page["nextCursor"] != nil || page["historyMayBeIncomplete"] != true {
		t.Fatalf("empty retained history: %s", body)
	}
	status, _, body = f.request(t, outsider, http.MethodGet, deliveries, "")
	mustStatus(t, status, http.StatusForbidden, body)
	status, _, body = f.request(t, outsider, http.MethodGet, "/api/v1/me/webhooks/"+endpoint+"/deliveries", "")
	mustStatus(t, status, http.StatusNotFound, body)
	status, _, body = f.request(t, httpActor{}, http.MethodGet, deliveries, "")
	mustStatus(t, status, http.StatusUnauthorized, body)
	for _, suffix := range []string{"?limit=0", "?limit=101", "?limit=1&limit=2", "?cursor=", "?unknown=x", "?eventType=unregistered", "?state=unknown", "?projectId=not-a-uuid", "?from=bad", "?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z"} {
		status, _, body = f.request(t, admin, http.MethodGet, deliveries+suffix, "")
		mustStatus(t, status, http.StatusBadRequest, body)
	}
	for _, suffix := range []string{"?generation=0", "?generation=01", "?generation=9223372036854775808", "?limit=1&limit=2", "?extra=x"} {
		status, _, body = f.request(t, admin, http.MethodGet, delivery+"/attempts"+suffix, "")
		mustStatus(t, status, http.StatusBadRequest, body)
	}
	for _, suffix := range []string{"?x=1", "?limit=1"} {
		status, _, body = f.request(t, admin, http.MethodGet, delivery+"/payload"+suffix, "")
		mustStatus(t, status, http.StatusBadRequest, body)
	}
	intent := operationFields(admin)
	intent["ifVersion"], intent["ifGeneration"] = "1", "1"
	for _, field := range []string{"generation", "configVersion", "extra"} {
		intent[field] = "1"
		status, _, body = f.request(t, admin, http.MethodPost, delivery+"/redeliveries", encoded(t, intent))
		mustStatus(t, status, http.StatusBadRequest, body)
		delete(intent, field)
	}
	for _, value := range []any{"0", "01", "9223372036854775808", float64(1), nil} {
		intent["ifGeneration"] = value
		status, _, body = f.request(t, admin, http.MethodPost, delivery+"/redeliveries", encoded(t, intent))
		mustStatus(t, status, http.StatusBadRequest, body)
	}
	var operations int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM webhook_operations WHERE owner_kind='team' AND owner_id=$1`, team).Scan(&operations); err != nil || operations != 1 {
		t.Fatalf("rejected requests changed receipts: %d %v", operations, err)
	}
}
