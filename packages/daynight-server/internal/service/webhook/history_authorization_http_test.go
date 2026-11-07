package webhook_test

import (
	"context"
	"encoding/base64"
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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	corewebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	webhookhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type historyActor struct{ id, token string }
type historyAuthFixture struct {
	f                                       *captureFixture
	svc                                     *webhook.Service
	host                                    *httptest.Server
	team, endpoint                          string
	admin, second, member, direct, outsider historyActor
}

func newHistoryAuthFixture(t *testing.T) *historyAuthFixture {
	t.Helper()
	f := newCaptureFixture(t, 1)
	team := ""
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT team_id::text FROM project_ownership WHERE project_id=$1`, f.project).Scan(&team); err != nil {
		t.Fatal(err)
	}
	admin := historyActor{id: f.principal.UserID, token: secret.Random("dnst_")}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE sessions SET token_hash=$1 WHERE id=$2`, secret.Hash(admin.token), f.principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	makeActor := func() historyActor {
		t.Helper()
		a := historyActor{id: uuid.NewString(), token: secret.Random("dnst_")}
		session := uuid.NewString()
		if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, a.id); err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, session, a.id, secret.Hash(a.token)); err != nil {
			t.Fatal(err)
		}
		return a
	}
	second, member, direct, outsider := makeActor(), makeActor(), makeActor(), makeActor()
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member')`, team, second.id, member.id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, f.project, direct.id); err != nil {
		t.Fatal(err)
	}
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true, DispatchEnabled: true}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	auth, err := authhttp.NewAuthentication(identityservice.New(f.db, nil, "https://daynight.example/auth/callback"), config.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	webhookhttp.NewRoutes(svc, auth, logger).RegisterRoutes(mux)
	host := httptest.NewServer(mux)
	t.Cleanup(host.Close)
	return &historyAuthFixture{f: f, svc: svc, host: host, team: team, admin: admin, second: second, member: member, direct: direct, outsider: outsider}
}
func (f *historyAuthFixture) call(t *testing.T, host *httptest.Server, a historyActor, method, path, body string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequestWithContext(f.f.ctx, method, host.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: a.token})
	req.Header.Set("Origin", "https://daynight.example")
	req.Header.Set("Content-Type", "application/json")
	resp, err := host.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Header.Get("Daynight-User-ID") != a.id || resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("auth headers: %v", resp.Header)
	}
	return resp.StatusCode, out
}
func historyIntent(a historyActor, generation string) string {
	return fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"ifVersion":"1","ifGeneration":%q}`, uuid.NewString(), time.Now().UTC().Format(time.RFC3339Nano), a.id, generation)
}
func (f *historyAuthFixture) createEndpoint(t *testing.T, projects ...string) {
	t.Helper()
	name, enabled := "team endpoint", true
	mutation := webhook.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.admin.id, RequestSHA256: strings.Repeat("a", 64), Name: &name, Enabled: &enabled, Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://receiver.example/old-private"}, HasSubscriptions: true}
	for _, project := range projects {
		mutation.Subscriptions = append(mutation.Subscriptions, corewebhook.SubscriptionInput{ProjectID: project, EventTypes: []string{"task.created"}})
	}
	result, err := f.svc.Mutate(f.f.ctx, f.f.principal, webhook.Owner{Kind: "team", ID: f.team}, mutation)
	if err != nil {
		t.Fatal(err)
	}
	f.endpoint = result.Body.(map[string]any)["endpoint"].(map[string]any)["id"].(string)
}
func TestHistoryHTTPAuthorizationAndHiddenFilters(t *testing.T) {
	f := newHistoryAuthFixture(t)
	hiddenProject, otherTeam := uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO teams(id,name) VALUES($1,'other')`, []any{otherTeam}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'hidden-project',$2)`, []any{hiddenProject, "https://example.test/" + hiddenProject}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{hiddenProject, f.team}},
	} {
		if _, err := f.f.db.Pool.Exec(f.f.ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	f.createEndpoint(t, f.f.project, hiddenProject)
	tasks := taskservice.NewTasks(f.f.db, f.f.capture)
	for _, q := range []struct{ project, title string }{{f.f.project, "visible task"}, {hiddenProject, "hidden-title-canary"}} {
		if _, err := tasks.Create(f.f.ctx, f.f.principal, q.project, taskcore.CreateTask{Title: q.title}); err != nil {
			t.Fatal(err)
		}
	}
	var visibleID, hiddenID string
	if err := f.f.db.Pool.QueryRow(f.f.ctx, `SELECT (SELECT id::text FROM webhook_deliveries WHERE endpoint_id=$1 AND project_id=$2),(SELECT id::text FROM webhook_deliveries WHERE endpoint_id=$1 AND project_id=$3)`, f.endpoint, f.f.project, hiddenProject).Scan(&visibleID, &hiddenID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.f.db.Pool.Exec(f.f.ctx, `INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, hiddenProject, f.admin.id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.f.db.Pool.Exec(f.f.ctx, `UPDATE project_ownership SET team_id=$1 WHERE project_id=$2`, otherTeam, hiddenProject); err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/teams/" + f.team + "/webhooks/" + f.endpoint + "/deliveries"
	status, body := f.call(t, f.host, f.admin, "GET", base+"/"+hiddenID, "")
	if status != 200 || !strings.Contains(string(body), `"disclosure":"full"`) {
		t.Fatalf("admin hidden project status=%d body=%s", status, body)
	}
	status, body = f.call(t, f.host, f.member, "GET", base+"/"+hiddenID, "")
	var hidden map[string]any
	if status != 200 || json.Unmarshal(body, &hidden) != nil || hidden["disclosure"] != "metadata_only" || hidden["eventType"] != nil || hidden["resourceVersion"] != nil || strings.Contains(string(body), hiddenProject) || strings.Contains(string(body), "hidden-title-canary") || strings.Contains(string(body), "old-private") {
		t.Fatalf("member redaction status=%d body=%s", status, body)
	}
	resource := hidden["resource"].(map[string]any)
	target := hidden["target"].(map[string]any)
	if resource["projectId"] != nil || resource["taskId"] != nil || resource["displayName"] != nil || target["url"] != nil || target["displayUrl"] != nil {
		t.Fatalf("hidden fields: %s", body)
	}
	for _, a := range []historyActor{f.direct, f.outsider} {
		for _, path := range []string{base, base + "/" + visibleID, base + "/" + visibleID + "/payload"} {
			if status, body = f.call(t, f.host, a, "GET", path, ""); status != 403 {
				t.Fatalf("unrelated actor status=%d path=%s body=%s", status, path, body)
			}
		}
	}
	if status, body = f.call(t, f.host, f.member, "GET", base+"/"+hiddenID+"/payload", ""); status != 403 {
		t.Fatalf("hidden payload=%d %s", status, body)
	}
	if status, body = f.call(t, f.host, f.member, "GET", base+"/"+visibleID+"/payload", ""); status != 200 {
		t.Fatalf("authorized member payload=%d %s", status, body)
	}
	for _, a := range []historyActor{f.member, f.direct, f.outsider} {
		if status, body = f.call(t, f.host, a, "POST", base+"/"+visibleID+"/redeliveries", historyIntent(a, "1")); status != 403 {
			t.Fatalf("unauthorized redelivery status=%d body=%s", status, body)
		}
	}
	if status, body = f.call(t, f.host, f.member, "GET", "/api/v1/teams/"+f.team+"/webhooks/"+f.endpoint+"/signing-secret", ""); status != 403 {
		t.Fatalf("member secret=%d %s", status, body)
	}
	if status, body = f.call(t, f.host, f.admin, "GET", "/api/v1/teams/"+otherTeam+"/webhooks/"+f.endpoint+"/deliveries", ""); status != 403 {
		t.Fatalf("other owner=%d %s", status, body)
	}
	var count, manual, sequence int
	var generation int64
	if err := f.f.db.Pool.QueryRow(f.f.ctx, `SELECT (SELECT count(*) FROM webhook_operations WHERE kind='delivery.redeliver'),generation,manual_operation_count,attempt_sequence FROM webhook_deliveries WHERE id=$1`, visibleID).Scan(&count, &generation, &manual, &sequence); err != nil || count != 0 || generation != 1 || manual != 0 || sequence != 0 {
		t.Fatalf("unauthorized effects receipts=%d generation=%d manual=%d attempts=%d err=%v", count, generation, manual, sequence, err)
	}
	for _, query := range []string{"?projectId=" + hiddenProject, "?eventType=task.created"} {
		status, body = f.call(t, f.host, f.member, "GET", base+query, "")
		if status != 200 {
			t.Fatalf("filter status=%d body=%s", status, body)
		}
		var page struct {
			Items      []struct{ ID string }
			NextCursor *string
		}
		if err := json.Unmarshal(body, &page); err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Items {
			if item.ID == hiddenID {
				t.Fatalf("hidden match revealed: %s", body)
			}
		}
		if strings.Contains(query, "projectId") && len(page.Items) != 0 {
			t.Fatalf("hidden project matched: %s", body)
		}
		if strings.Contains(query, "eventType") && (len(page.Items) != 1 || page.Items[0].ID != visibleID) {
			t.Fatalf("visible event filter: %s", body)
		}
	}
	status, body = f.call(t, f.host, f.member, "GET", base+"?limit=1", "")
	var page struct{ NextCursor *string }
	if status != 200 || json.Unmarshal(body, &page) != nil || page.NextCursor == nil {
		t.Fatalf("cursor page=%d %s", status, body)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(*page.NextCursor)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(decoded), hiddenProject) || strings.Contains(string(decoded), "hidden-title-canary") {
		t.Fatal("cursor leaked hidden data")
	}
	status, body = f.call(t, f.host, f.member, "GET", base+"?limit=1&eventType=task.created&cursor="+*page.NextCursor, "")
	if status != 400 {
		t.Fatalf("cursor filter reuse=%d %s", status, body)
	}
	if status, body = f.call(t, f.host, f.admin, "POST", base+"/"+visibleID+"/redeliveries", historyIntent(f.admin, "1")); status != 202 {
		t.Fatalf("admin redelivery=%d %s", status, body)
	}
}

type historyReplayGate struct {
	store.WebhookTransactions
	completed chan struct{}
	release   chan struct{}
}

func (g *historyReplayGate) WriteWebhook(ctx context.Context, o wm.Owner, id string, fn func(store.WebhookWriteScope) error) (store.Completion, error) {
	completion, err := g.WebhookTransactions.WriteWebhook(ctx, o, id, fn)
	close(g.completed)
	select {
	case <-g.release:
	case <-ctx.Done():
		return completion, ctx.Err()
	}
	return completion, err
}
func TestHistoryHTTPConfigurationReplayAfterDemotion(t *testing.T) {
	f := newHistoryAuthFixture(t)
	f.createEndpoint(t, f.f.project)
	base := "/api/v1/teams/" + f.team + "/webhooks/" + f.endpoint
	operation := uuid.NewString()
	issued := time.Now().UTC().Format(time.RFC3339Nano)
	original := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"ifVersion":"1","name":"original update"}`, operation, issued, f.admin.id)
	status, body := f.call(t, f.host, f.admin, "PATCH", base, original)
	if status != 200 {
		t.Fatalf("original mutation=%d %s", status, body)
	}
	var beforeHash string
	var beforeTime time.Time
	if err := f.f.db.Pool.QueryRow(f.f.ctx, `SELECT encode(request_sha256,'hex'),recorded_at FROM webhook_operations WHERE owner_kind='team' AND owner_id=$1 AND operation_id=$2`, f.team, operation).Scan(&beforeHash, &beforeTime); err != nil {
		t.Fatal(err)
	}
	cfg := f.f.db.Pool.Config().Copy()
	cfg.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(f.f.ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	gate := &historyReplayGate{WebhookTransactions: &postgres.Store{Pool: pool}, completed: make(chan struct{}), release: make(chan struct{})}
	defer func() {
		select {
		case <-gate.release:
		default:
			close(gate.release)
		}
	}()
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	auth, err := authhttp.NewAuthentication(identityservice.New(f.f.db, nil, "https://daynight.example/auth/callback"), config.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	webhookhttp.NewRoutes(&webhook.Service{DB: gate, Keys: f.f.capture.Keys, ConfigurationExpansionAvailable: true, DispatchEnabled: true}, auth, logger).RegisterRoutes(mux)
	gatedHost := httptest.NewServer(mux)
	defer gatedHost.Close()
	type reply struct {
		status int
		body   []byte
		err    error
	}
	out := make(chan reply, 1)
	go func() {
		req, e := http.NewRequestWithContext(f.f.ctx, "PATCH", gatedHost.URL+base, strings.NewReader(original))
		if e != nil {
			out <- reply{err: e}
			return
		}
		req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: f.admin.token})
		req.Header.Set("Origin", "https://daynight.example")
		req.Header.Set("Content-Type", "application/json")
		res, e := gatedHost.Client().Do(req)
		if e != nil {
			out <- reply{err: e}
			return
		}
		defer res.Body.Close()
		b, e := io.ReadAll(res.Body)
		if e == nil && (res.Header.Get("Daynight-User-ID") != f.admin.id || res.Header.Get("Cache-Control") != "no-store") {
			e = fmt.Errorf("invalid authenticated response headers")
		}
		out <- reply{res.StatusCode, b, e}
	}()
	select {
	case <-gate.completed:
	case <-f.f.ctx.Done():
		t.Fatal(f.f.ctx.Err())
	}
	ctx, cancel := context.WithTimeout(f.f.ctx, time.Second)
	var one int
	err = pool.QueryRow(ctx, `SELECT 1`).Scan(&one)
	cancel()
	if err != nil || one != 1 {
		t.Fatalf("single connection retained during gate: %v", err)
	}
	if _, err = f.f.db.Pool.Exec(f.f.ctx, `UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, f.team, f.admin.id); err != nil {
		t.Fatal(err)
	}
	privateURL := "https://receiver.example/new-secret-path?token=private-value"
	newMutation := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"ifVersion":"2","destination":{"kind":"http","adapterVersion":"1","configuration":{"url":%q}}}`, uuid.NewString(), time.Now().UTC().Format(time.RFC3339Nano), f.second.id, privateURL)
	status, body = f.call(t, f.host, f.second, "PATCH", base, newMutation)
	if status != 200 {
		t.Fatalf("second admin update=%d %s", status, body)
	}
	close(gate.release)
	select {
	case got := <-out:
		if got.err != nil || got.status != 200 || strings.Contains(string(got.body), "new-secret-path") || strings.Contains(string(got.body), "private-value") {
			t.Fatalf("replay status=%d body=%s err=%v", got.status, got.body, got.err)
		}
		var response struct {
			Endpoint struct {
				ConfigVersion string `json:"configVersion"`
				Destination   struct {
					URL *string `json:"url"`
				} `json:"destination"`
			} `json:"endpoint"`
		}
		if err = json.Unmarshal(got.body, &response); err != nil || response.Endpoint.Destination.URL != nil || response.Endpoint.ConfigVersion != "3" {
			t.Fatalf("replay exposed URL: %s (%v)", got.body, err)
		}
	case <-f.f.ctx.Done():
		t.Fatal(f.f.ctx.Err())
	}
	var afterHash string
	var afterTime time.Time
	var count int
	if err = f.f.db.Pool.QueryRow(f.f.ctx, `SELECT encode(request_sha256,'hex'),recorded_at,(SELECT count(*) FROM webhook_operations WHERE owner_kind='team' AND owner_id=$1 AND operation_id=$2) FROM webhook_operations WHERE owner_kind='team' AND owner_id=$1 AND operation_id=$2`, f.team, operation).Scan(&afterHash, &afterTime, &count); err != nil || beforeHash != afterHash || !beforeTime.Equal(afterTime) || count != 1 {
		t.Fatalf("receipt changed hash=%s/%s time=%s/%s count=%d err=%v", beforeHash, afterHash, beforeTime, afterTime, count, err)
	}
}
