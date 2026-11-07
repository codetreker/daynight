package webhook_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	httpwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	identity "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
)

const testOrigin = "http://127.0.0.1:8787"

type httpFixture struct {
	ctx    context.Context
	db     *postgres.Store
	server *httptest.Server
}

type httpActor struct{ id, cookie string }

func newHTTPFixture(t *testing.T) *httpFixture {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	master := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	keys, err := secretbox.Parse([]byte(`{"activeKeyId":"main","keys":{"main":"` + master + `"}}`))
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	id := identity.New(db, nil, testOrigin+"/auth/callback")
	authenticator, err := auth.NewAuthentication(id, config.AuthSettings{PublicOrigin: testOrigin, AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	httpwebhook.NewRoutes(&service.Service{DB: db, Keys: keys, ConfigurationExpansionAvailable: true, DispatchEnabled: false}, authenticator, logger).RegisterRoutes(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return &httpFixture{ctx: ctx, db: db, server: server}
}

func (f *httpFixture) actor(t *testing.T) httpActor {
	t.Helper()
	id, session, token := uuid.NewString(), uuid.NewString(), secret.Random("dnst_")
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$2,now(),now())`, id, id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO sessions (id,user_id,token_hash,created_at,expires_at) VALUES ($1,$2,$3,now(),now()+interval '1 day')`, session, id, secret.Hash(token)); err != nil {
		t.Fatal(err)
	}
	return httpActor{id: id, cookie: token}
}

func (f *httpFixture) request(t *testing.T, actor httpActor, method, path, body string) (int, http.Header, []byte) {
	t.Helper()
	r, err := http.NewRequestWithContext(f.ctx, method, f.server.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if actor.cookie != "" {
		r.AddCookie(&http.Cookie{Name: "daynight_session", Value: actor.cookie})
	}
	r.Header.Set("Origin", testOrigin)
	r.Header.Set("Content-Type", "application/json")
	resp, err := f.server.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("missing no-store for %s %s: %v", method, path, resp.Header)
	}
	if actor.cookie != "" && resp.Header.Get("Daynight-User-ID") != actor.id {
		t.Fatalf("wrong principal header: %v", resp.Header)
	}
	return resp.StatusCode, resp.Header, b
}
func mustStatus(t *testing.T, actual, expected int, body []byte) {
	t.Helper()
	if actual != expected {
		t.Fatalf("status %d expected %d; body %s", actual, expected, body)
	}
}
func jsonBody(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var result map[string]any
	if err := json.Unmarshal(b, &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func operationFields(actor httpActor) map[string]any {
	return map[string]any{"operationId": uuid.NewString(), "issuedAt": time.Now().UTC().Format(time.RFC3339Nano), "expectedUserId": actor.id}
}
func encoded(t *testing.T, m map[string]any) string {
	t.Helper()
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
func createFields(actor httpActor, name, url string) map[string]any {
	m := operationFields(actor)
	m["name"] = name
	m["enabled"] = true
	m["destination"] = map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": url}}
	m["subscriptions"] = []any{}
	return m
}

// A01 exercises actual cookie authentication, HTTP parsing/response, service and
// isolated PostgreSQL for both owner kinds and current Team membership.
func TestHTTPPostgresOwnerCRUDAndAuthorization(t *testing.T) {
	f := newHTTPFixture(t)
	admin, member, outsider := f.actor(t), f.actor(t), f.actor(t)
	team := uuid.NewString()
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO teams (id,name) VALUES ($1,'shared')`, team); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		actor httpActor
		role  string
	}{{admin, "admin"}, {member, "member"}} {
		if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,$3)`, team, row.actor.id, row.role); err != nil {
			t.Fatal(err)
		}
	}
	status, _, b := f.request(t, admin, "GET", "/api/v1/webhook-event-types", "")
	mustStatus(t, status, 200, b)
	catalog := jsonBody(t, b)
	items := catalog["items"].([]any)
	keys := []string{"task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"}
	if len(items) != len(keys) {
		t.Fatalf("catalog items: %s", b)
	}
	for i, key := range keys {
		item := items[i].(map[string]any)
		if item["key"] != key || item["wireType"] != "cc.daynight."+key+".v1" || item["schemaVersion"] != float64(1) || item["resourceKind"] != "project" {
			t.Fatalf("catalog item: %v", item)
		}
	}
	capabilities := catalog["service"].(map[string]any)
	limits := catalog["limits"].(map[string]any)
	if capabilities["configurationExpansionAvailable"] != true || capabilities["dispatchEnabled"] != false || limits["policyVersion"] != "1" || limits["requestBytes"] != float64(256<<10) || limits["maxAutomaticAttempts"] != float64(10) || limits["automaticWindowSeconds"] != float64(259200) || limits["operationMaxAgeSeconds"] != float64(300) || limits["operationFutureSkewSeconds"] != float64(60) {
		t.Fatalf("catalog capabilities or limits: %s", b)
	}
	base := "/api/v1/me/webhooks"
	fields := createFields(admin, "  Release  ", "https://receiver.example/Private?token=secret")
	wire := encoded(t, fields)
	status, _, b = f.request(t, admin, "POST", base, wire)
	mustStatus(t, status, 201, b)
	result := jsonBody(t, b)
	ep := result["endpoint"].(map[string]any)
	op := result["operation"].(map[string]any)
	id := ep["id"].(string)
	sum := sha256.Sum256([]byte(wire))
	if ep["name"] != "Release" || ep["configVersion"] != "1" || op["requestSha256"] != hex.EncodeToString(sum[:]) {
		t.Fatalf("creation: %s", b)
	}
	for _, field := range []any{ep["createdAt"], ep["updatedAt"], op["recordedAt"], op["expiresAt"]} {
		value, ok := field.(string)
		if !ok || !strings.HasSuffix(value, "Z") {
			t.Fatalf("timestamp is not UTC: %v", field)
		}
		if _, err := time.Parse(time.RFC3339Nano, value); err != nil {
			t.Fatalf("invalid timestamp %q: %v", value, err)
		}
	}
	var ciphertext []byte
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT destination_ciphertext FROM webhook_endpoints WHERE id=$1`, id).Scan(&ciphertext); err != nil || bytes.Contains(ciphertext, []byte("Private")) {
		t.Fatalf("destination was not encrypted: %v", err)
	}
	status, _, b = f.request(t, admin, "POST", base, " \n"+wire)
	mustStatus(t, status, 200, b)
	replay := jsonBody(t, b)
	if replay["operation"].(map[string]any)["requestSha256"] != hex.EncodeToString(sum[:]) || replay["endpoint"].(map[string]any)["id"] != id {
		t.Fatal("replay lost original effect or request hash")
	}
	status, _, b = f.request(t, outsider, "GET", base+"/"+id, "")
	mustStatus(t, status, 404, b)
	status, _, b = f.request(t, admin, "GET", base+"/"+id+"/signing-secret", "")
	mustStatus(t, status, 200, b)
	if !strings.HasPrefix(jsonBody(t, b)["secret"].(string), "whsec_") {
		t.Fatal("secret format")
	}
	patch := operationFields(admin)
	patch["ifVersion"] = "1"
	patch["name"] = "New name"
	status, _, b = f.request(t, admin, "PATCH", base+"/"+id, encoded(t, patch))
	mustStatus(t, status, 200, b)
	if jsonBody(t, b)["endpoint"].(map[string]any)["configVersion"] != "2" {
		t.Fatal("patch version")
	}
	old := operationFields(admin)
	old["ifVersion"] = "1"
	old["name"] = "New name"
	status, _, b = f.request(t, admin, "PATCH", base+"/"+id, encoded(t, old))
	mustStatus(t, status, 409, b)
	deleteRequest := operationFields(admin)
	deleteRequest["ifVersion"] = "2"
	status, _, b = f.request(t, admin, "DELETE", base+"/"+id, encoded(t, deleteRequest))
	mustStatus(t, status, 200, b)
	if jsonBody(t, b)["endpoint"].(map[string]any)["lifecycle"] != "deleted" {
		t.Fatal("delete did not return tombstone")
	}
	teamBase := "/api/v1/teams/" + team + "/webhooks"
	teamFields := createFields(admin, "Team", "https://receiver.example/TeamSecret?token=x")
	status, _, b = f.request(t, admin, "POST", teamBase, encoded(t, teamFields))
	mustStatus(t, status, 201, b)
	teamID := jsonBody(t, b)["endpoint"].(map[string]any)["id"].(string)
	status, _, b = f.request(t, member, "GET", teamBase, "")
	mustStatus(t, status, 200, b)
	summary := jsonBody(t, b)["items"].([]any)[0].(map[string]any)
	if v, ok := summary["lastAttemptAt"]; !ok || v != nil {
		t.Fatalf("missing nullable lastAttemptAt: %s", b)
	}
	if v, ok := summary["lastResult"]; !ok || v != nil {
		t.Fatalf("missing nullable lastResult: %s", b)
	}
	if strings.Contains(string(b), "TeamSecret") {
		t.Fatal("member summary disclosed hidden destination")
	}
	status, _, b = f.request(t, member, "GET", teamBase+"/"+teamID, "")
	mustStatus(t, status, 200, b)
	dest := jsonBody(t, b)["destination"].(map[string]any)
	if dest["url"] != nil || strings.Contains(fmt.Sprint(dest["displayUrl"]), "TeamSecret") {
		t.Fatal("team member saw destination secret")
	}
	status, _, b = f.request(t, member, "GET", teamBase+"/"+teamID+"/signing-secret", "")
	mustStatus(t, status, 403, b)
	status, _, b = f.request(t, member, "POST", teamBase, encoded(t, createFields(member, "denied", "https://example.test/")))
	mustStatus(t, status, 403, b)
	probe := createFields(member, "different intent", "https://example.test/")
	probe["operationId"] = teamFields["operationId"]
	status, _, b = f.request(t, member, "POST", teamBase, encoded(t, probe))
	mustStatus(t, status, 403, b)
	if code := jsonBody(t, b)["error"].(map[string]any)["code"]; code != "forbidden" {
		t.Fatalf("other actor receipt leaked through conflict: %s", b)
	}
	expired := createFields(admin, "expired", "https://example.test/")
	expired["issuedAt"] = time.Now().UTC().Add(-301 * time.Second).Format(time.RFC3339Nano)
	status, _, b = f.request(t, admin, "POST", teamBase, encoded(t, expired))
	mustStatus(t, status, 410, b)
	if code := jsonBody(t, b)["error"].(map[string]any)["code"]; code != "operation_expired" {
		t.Fatalf("wrong expiration code: %s", b)
	}
	var endpoints, receipts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_id=$1)`, team).Scan(&endpoints, &receipts); err != nil || endpoints != 1 || receipts != 1 {
		t.Fatalf("rejected request left effects: endpoints=%d receipts=%d err=%v", endpoints, receipts, err)
	}
	status, _, b = f.request(t, outsider, "GET", teamBase+"/"+teamID, "")
	mustStatus(t, status, 403, b)
	identityMismatch := createFields(admin, "Mismatch", "https://example.test/")
	identityMismatch["expectedUserId"] = member.id
	status, _, b = f.request(t, admin, "POST", base, encoded(t, identityMismatch))
	mustStatus(t, status, 409, b)
	status, _, b = f.request(t, httpActor{}, "GET", base, "")
	mustStatus(t, status, 401, b)
	oversized := createFields(admin, "long time", "https://example.test/")
	oversized["issuedAt"] = time.Now().UTC().Format("2006-01-02T15:04:05") + "." + strings.Repeat("0", 5000) + "Z"
	status, _, b = f.request(t, admin, "POST", base, encoded(t, oversized))
	mustStatus(t, status, 201, b)
	if jsonBody(t, b)["operation"].(map[string]any)["issuedAt"] != oversized["issuedAt"] {
		t.Fatal("receipt did not preserve the original valid timestamp lexeme")
	}
	status, _, b = f.request(t, admin, "POST", base, `{"name":"a","name":"b"}`)
	mustStatus(t, status, 400, b)
	status, _, b = f.request(t, admin, "GET", base+"?limit=1&limit=2", "")
	mustStatus(t, status, 400, b)
	status, _, b = f.request(t, admin, "POST", base, `{"name":"\ud800"}`)
	mustStatus(t, status, 400, b)
	status, _, b = f.request(t, admin, "POST", base, `{"name":"`+strings.Repeat("x", 256<<10)+`"}`)
	mustStatus(t, status, 413, b)
	unavailable := createFields(admin, "subscription", "https://example.test/")
	unavailable["subscriptions"] = []any{map[string]any{"projectId": uuid.NewString()}}
	status, _, b = f.request(t, admin, "POST", base, encoded(t, unavailable))
	mustStatus(t, status, 400, b)
	status, _, b = f.request(t, admin, "HEAD", base+"/"+id, "")
	mustStatus(t, status, 200, b)
	if len(b) != 0 {
		t.Fatal("HEAD returned a response body")
	}
	status, _, b = f.request(t, admin, "PUT", base+"/"+id, "")
	mustStatus(t, status, 405, b)
}

// The request, Unicode name and URL limits are independent byte boundaries.
// This sends the exact serialized body through the authenticated production mux.
func TestHTTPConfigurationByteBoundaries(t *testing.T) {
	f := newHTTPFixture(t)
	actor := f.actor(t)
	base := "/api/v1/me/webhooks"
	prefix := "https://example.test/"
	url := prefix + strings.Repeat("a", 4096-len(prefix))
	fields := createFields(actor, strings.Repeat("界", 120), url)
	body := encoded(t, fields)
	body += strings.Repeat(" ", (256<<10)-len(body))
	status, _, response := f.request(t, actor, "POST", base, body)
	mustStatus(t, status, 201, response)
	receipt := jsonBody(t, response)["operation"].(map[string]any)
	sum := sha256.Sum256([]byte(body))
	if receipt["requestSha256"] != hex.EncodeToString(sum[:]) {
		t.Fatal("receipt did not hash the exact accepted body")
	}
	status, _, response = f.request(t, actor, "POST", base, body+" ")
	mustStatus(t, status, 413, response)
	tooLongName := createFields(actor, strings.Repeat("界", 121), url)
	status, _, response = f.request(t, actor, "POST", base, encoded(t, tooLongName))
	mustStatus(t, status, 400, response)
	tooLongURL := createFields(actor, "valid", url+"a")
	status, _, response = f.request(t, actor, "POST", base, encoded(t, tooLongURL))
	mustStatus(t, status, 400, response)
	var endpoints, receipts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_id=$1)`, actor.id).Scan(&endpoints, &receipts); err != nil || endpoints != 1 || receipts != 1 {
		t.Fatalf("boundary rejection changed persisted state: endpoints=%d receipts=%d err=%v", endpoints, receipts, err)
	}
}

func TestHTTPCatalogFailsWhenPolicyQueryFails(t *testing.T) {
	f := newHTTPFixture(t)
	actor := f.actor(t)
	if _, err := f.db.Pool.Exec(f.ctx, `ALTER TABLE webhook_policies RENAME TO unavailable_webhook_policies`); err != nil {
		t.Fatal(err)
	}
	status, headers, body := f.request(t, actor, "GET", "/api/v1/webhook-event-types", "")
	if status != http.StatusServiceUnavailable || headers.Get("Daynight-User-ID") != actor.id || headers.Get("Cache-Control") != "no-store" {
		t.Fatalf("catalog failure status=%d headers=%v body=%s", status, headers, body)
	}
	result := jsonBody(t, body)
	if result["error"].(map[string]any)["code"] != "dependency_unavailable" || result["items"] != nil || strings.Contains(string(body), "webhook_policies") {
		t.Fatalf("policy query failure returned an invalid response: %s", body)
	}
}
