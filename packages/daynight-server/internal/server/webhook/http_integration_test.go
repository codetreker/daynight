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
	httpwebhook.RegisterRoutes(mux, httpwebhook.Adapter{Service: &service.Service{DB: db, Keys: keys}}, authenticator, logger)
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
	base := "/api/v1/me/webhooks"
	fields := createFields(admin, "  Release  ", "https://receiver.example/Private?token=secret")
	wire := encoded(t, fields)
	status, _, b := f.request(t, admin, "POST", base, wire)
	mustStatus(t, status, 201, b)
	result := jsonBody(t, b)
	ep := result["endpoint"].(map[string]any)
	op := result["operation"].(map[string]any)
	id := ep["id"].(string)
	sum := sha256.Sum256([]byte(wire))
	if ep["name"] != "Release" || ep["configVersion"] != "1" || op["requestSha256"] != hex.EncodeToString(sum[:]) {
		t.Fatalf("creation: %s", b)
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
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_quota_owners SET operations=1024 WHERE owner_kind='team' AND owner_id=$1`, team); err != nil {
		t.Fatal(err)
	}
	full := createFields(admin, "capacity", "https://example.test/")
	status, _, b = f.request(t, admin, "POST", teamBase, encoded(t, full))
	mustStatus(t, status, 429, b)
	if code := jsonBody(t, b)["error"].(map[string]any)["code"]; code != "operation_capacity" {
		t.Fatalf("wrong capacity code: %s", b)
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
	var before string
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT row_to_json(o)::text || row_to_json(q)::text FROM webhook_quota_owners o JOIN webhook_quota_buckets q USING(bucket) WHERE owner_kind='user' AND owner_id=$1`, admin.id).Scan(&before); err != nil {
		t.Fatal(err)
	}
	oversized := createFields(admin, "long time", "https://example.test/")
	oversized["issuedAt"] = time.Now().UTC().Format("2006-01-02T15:04:05") + "." + strings.Repeat("0", 5000) + "Z"
	status, _, b = f.request(t, admin, "POST", base, encoded(t, oversized))
	mustStatus(t, status, 400, b)
	var after string
	var personalEndpoints, personalReceipts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT row_to_json(o)::text || row_to_json(q)::text, (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1), (SELECT count(*) FROM webhook_operations WHERE owner_id=$1) FROM webhook_quota_owners o JOIN webhook_quota_buckets q USING(bucket) WHERE owner_kind='user' AND owner_id=$1`, admin.id).Scan(&after, &personalEndpoints, &personalReceipts); err != nil || after != before || personalEndpoints != 1 || personalReceipts != 3 {
		t.Fatalf("oversized receipt left effect: endpoints=%d receipts=%d err=%v", personalEndpoints, personalReceipts, err)
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
