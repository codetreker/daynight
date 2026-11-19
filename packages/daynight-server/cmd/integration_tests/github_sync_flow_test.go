//go:build integration

package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The process uses its production fixed-origin client through a controlled TLS
// proxy. This keeps the complete server, worker and database path in the flow.
func githubIntegrationRemote(t *testing.T) (*githubFixtureConfig, func(string)) {
	t.Helper()
	dir := filepath.Join(integrationRunRoot(t), "github-fixture")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Integration CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), DNSNames: []string{"api.github.com"}, NotBefore: ca.NotBefore, NotAfter: ca.NotAfter, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	caFile, keyFile := filepath.Join(dir, "ca.pem"), filepath.Join(dir, "app.pem")
	if err := os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}), 0600); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	title := "Initial PR"
	setTitle := func(v string) { mu.Lock(); title = v; mu.Unlock() }
	remote := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/app":
			fmt.Fprint(w, `{"id":13,"name":"Integration App","slug":"integration-app"}`)
		case "/app/installations":
			fmt.Fprint(w, `[{"id":99,"account":{"login":"example"}}]`)
		case "/app/installations/99":
			fmt.Fprint(w, `{"id":99,"suspended_at":null}`)
		case "/repos/example/integration/installation":
			fmt.Fprint(w, `{"id":99,"account":{"login":"example"}}`)
		case "/app/installations/99/access_tokens":
			w.WriteHeader(http.StatusCreated)
			fmt.Fprintf(w, `{"token":"test","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
		case "/repos/example/integration":
			fmt.Fprint(w, `{"id":42,"full_name":"example/integration","private":false}`)
		case "/installation/repositories":
			fmt.Fprint(w, `{"repositories":[{"id":42,"full_name":"example/integration","private":false}]}`)
		case "/repos/example/integration/pulls", "/repos/example/integration/pulls/1":
			mu.Lock()
			current := title
			mu.Unlock()
			pr := map[string]any{"number": 1, "id": 101, "html_url": "https://github.com/example/integration/pull/1", "title": current, "state": "open", "draft": false, "user": nil, "base": map[string]any{"ref": "main", "repo": map[string]any{"id": 42}}, "head": map[string]any{"ref": "branch", "sha": "abc", "repo": nil}, "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z", "closed_at": nil, "merged_at": nil, "body": "saved"}
			if r.URL.Path == "/repos/example/integration/pulls/1" {
				_ = json.NewEncoder(w).Encode(pr)
			} else {
				_ = json.NewEncoder(w).Encode([]any{pr})
			}
		default:
			http.Error(w, "unexpected GitHub request", http.StatusNotFound)
		}
	}))
	remote.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{leafDER}, PrivateKey: key}}}
	remote.StartTLS()
	t.Cleanup(remote.Close)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || r.Host != "api.github.com:443" {
			http.Error(w, "unexpected proxy target", http.StatusBadRequest)
			return
		}
		upstream, err := net.DialTimeout("tcp", remote.Listener.Addr().String(), 2*time.Second)
		if err != nil {
			http.Error(w, "upstream unavailable", http.StatusBadGateway)
			return
		}
		client, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			upstream.Close()
			return
		}
		_, _ = buf.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = buf.Flush()
		done := make(chan struct{})
		go func() { _, _ = io.Copy(upstream, buf); _ = upstream.Close(); close(done) }()
		_, _ = io.Copy(client, upstream)
		_ = client.Close()
		<-done
	}))
	t.Cleanup(proxy.Close)
	return &githubFixtureConfig{privateKey: keyFile, caFile: caFile, proxyURL: proxy.URL}, setTitle
}

func TestServerAPIGitHubSyncNormalFlow(t *testing.T) {
	config, change := githubIntegrationRemote(t)
	f := newFixtureConfigured(t, false, config)
	project := createProjectAtRepository(t, f, "GitHub sync", "https://github.com/example/integration")
	base := "/api/v1/projects/" + project.ID
	key, err := os.ReadFile(config.privateKey)
	if err != nil {
		t.Fatal(err)
	}
	appID := uuid.NewString()
	appBase := "/api/v1/github/apps/" + appID
	app := requestJSON[api.GitHubApp](t, f, http.MethodPost, "/api/v1/github/apps", map[string]any{"id": appID, "name": "Integration App", "githubAppId": "13", "privateKeyPem": string(key), "webhookSecret": "integration-only-secret", "expectedUserId": f.userID}, http.StatusCreated)
	if app.ID != appID || app.GitHubAppID != "13" || app.GitHubSlug != "integration-app" {
		t.Fatalf("registered app: %+v", app)
	}
	readApp := requestJSON[api.GitHubApp](t, f, http.MethodGet, appBase, nil, http.StatusOK)
	if readApp.ID != appID || readApp.Version != app.Version {
		t.Fatalf("app read: %+v", readApp)
	}
	grant := func(teamID string) api.GitHubTeamGrant {
		t.Helper()
		preview := requestJSON[api.GitHubGrantPreview](t, f, http.MethodPost, appBase+"/team-grant-preview", map[string]any{"teamId": teamID}, http.StatusOK)
		id := uuid.NewString()
		created := requestJSON[api.GitHubTeamGrant](t, f, http.MethodPost, appBase+"/team-grants", map[string]any{"id": id, "version": preview.Version, "teamId": teamID, "teamVersion": preview.TargetTeam.Version, "expectedUserId": f.userID}, http.StatusCreated)
		if created.ID != id || created.Team.ID != teamID {
			t.Fatalf("grant: %+v", created)
		}
		apps := requestJSON[api.GitHubTeamAppPage](t, f, http.MethodGet, "/api/v1/teams/"+teamID+"/github/apps", nil, http.StatusOK)
		if len(apps.Items) != 1 || apps.Items[0].GrantID != id || apps.Items[0].App.ID != appID {
			t.Fatalf("team projection: %+v", apps)
		}
		return created
	}
	currentGrant := grant(project.Ownership.TeamID)
	status := requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodGet, base+"/github", nil, http.StatusOK)
	if status.SyncEnabled || !status.ServiceAvailable || !status.CanManageConnection {
		t.Fatalf("initial: %+v", status)
	}
	connect := func(ownershipVersion int64, current api.GitHubProjectAppStatus, selected api.GitHubTeamGrant) api.GitHubProjectAppStatus {
		t.Helper()
		selection := url.Values{"appResourceId": {appID}, "appVersion": {app.Version}, "grantId": {selected.ID}, "ownershipVersion": {strconv.FormatInt(ownershipVersion, 10)}}
		candidate := requestJSON[api.GitHubInstallationCandidate](t, f, http.MethodGet, base+"/github/installation?"+selection.Encode(), nil, http.StatusOK)
		if candidate.Installation.ID != "99" || candidate.Repository.ID != "42" {
			t.Fatalf("discovery: %+v", candidate)
		}
		return requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodPost, base+"/github/connect", map[string]any{"version": current.Version, "ownershipVersion": strconv.FormatInt(ownershipVersion, 10), "appResourceId": appID, "appVersion": app.Version, "grantId": selected.ID, "installationId": candidate.Installation.ID}, http.StatusOK)
	}
	status = connect(project.Ownership.Version, status, currentGrant)
	if status.SyncEnabled || status.Connection != "connected" || status.Poll.NextAttemptAt != nil {
		t.Fatalf("connected: %+v", status)
	}
	status = requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodPatch, base+"/github/sync", map[string]any{"version": status.Version, "syncEnabled": true}, http.StatusOK)
	if !status.SyncEnabled {
		t.Fatalf("enable: %+v", status)
	}
	waitTitle := func(want string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(f.context, 20*time.Second)
		defer cancel()
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			page := requestJSON[api.PullRequestPage](t, f, http.MethodGet, base+"/pull-requests", nil, http.StatusOK)
			current := requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodGet, base+"/github", nil, http.StatusOK)
			if len(page.Items) == 1 && page.Items[0].Title == want && !current.Initializing && current.Poll.LastSuccessAt != nil {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatalf("waiting for %q: page=%+v status=%+v", want, page, current)
			case <-ticker.C:
			}
		}
	}
	waitTitle("Initial PR")
	change("Updated by webhook")
	body := []byte(`{"installation":{"id":99},"repository":{"id":42},"number":1}`)
	mac := hmac.New(sha256.New, []byte("integration-only-secret"))
	_, _ = mac.Write(body)
	request, err := http.NewRequestWithContext(f.context, http.MethodPost, f.origin+appBase+"/webhook", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	request.Header.Set("X-GitHub-Event", "pull_request")
	request.Header.Set("X-GitHub-Delivery", uuid.NewString())
	response, err := f.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	data, readErr := io.ReadAll(response.Body)
	if closeErr := response.Body.Close(); readErr != nil || closeErr != nil {
		t.Fatalf("webhook response read: %v %v", readErr, closeErr)
	}
	if response.StatusCode != http.StatusAccepted {
		t.Fatalf("webhook response: %d %s", response.StatusCode, data)
	}
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		current := requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodGet, base+"/github", nil, http.StatusOK)
		page := requestJSON[api.PullRequestPage](t, f, http.MethodGet, base+"/pull-requests", nil, http.StatusOK)
		if current.Webhook.LastSuccessAt != nil && len(page.Items) == 1 && page.Items[0].Title == "Updated by webhook" {
			break
		}
		select {
		case <-deadline.C:
			t.Fatalf("webhook publication: status=%+v page=%+v", current, page)
		case <-ticker.C:
		}
	}
	status = requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodGet, base+"/github", nil, http.StatusOK)
	status = requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodPatch, base+"/github/sync", map[string]any{"version": status.Version, "syncEnabled": false}, http.StatusOK)
	if status.SyncEnabled || status.Poll.Running || status.Poll.NextAttemptAt != nil {
		t.Fatalf("disable: %+v", status)
	}
	change("Updated while off")
	page := requestJSON[api.PullRequestPage](t, f, http.MethodGet, base+"/pull-requests", nil, http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].Title != "Updated by webhook" {
		t.Fatalf("retained: %+v", page)
	}
	status = requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodPatch, base+"/github/sync", map[string]any{"version": status.Version, "syncEnabled": true}, http.StatusOK)
	if !status.SyncEnabled {
		t.Fatalf("re-enable: %+v", status)
	}
	waitTitle("Updated while off")
	// With every old process drained, restore the version 76 schema, ledger
	// and a real legacy binding before restarting Server.
	origin, callback := f.origin, f.callbackURL
	f.restart(func() {
		if f.origin != origin || f.callbackURL != callback || callback != origin+"/api/v1/auth/callback" {
			t.Fatal("public origin or gateway callback changed during restart")
		}
		listener, err := net.Listen("tcp", strings.TrimPrefix(origin, "http://"))
		if err == nil {
			listener.Close()
			t.Fatal("public listener was released during restart")
		}
		response, err := f.client.Get(origin + "/readyz")
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("restart routed to old backend: %d", response.StatusCode)
		}
		db, err := pgxpool.New(f.context, f.databaseURL)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		tx, err := db.Begin(f.context)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(f.context)
		if _, err = tx.Exec(f.context, `UPDATE project_github SET enabled=true, sync_enabled=true, app_id=13, installation_id=99, app_resource_id=NULL, team_grant_id=NULL, credential_version=NULL, installation_account_login='example', access_state='available' WHERE project_id=$1`, project.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `ALTER TABLE workers DROP COLUMN archive_sessions, DROP COLUMN alias_value, DROP COLUMN alias_version`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `ALTER TABLE projects DROP COLUMN repository_identity`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `DROP INDEX project_pull_requests_author_number`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `DROP TABLE usage_records`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `UPDATE task_properties SET name='paused' WHERE name='blocked'`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `DROP TABLE project_github_coverage`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `DROP TABLE session_archive_retention`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `DROP TABLE goal_dependency_revisions; DROP INDEX goal_dependencies_predecessor, goal_dependencies_edge_id`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `ALTER TABLE task_dependencies DROP COLUMN dependency_type, DROP COLUMN goal_edge_id`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `ALTER TABLE assistant_task_records DROP COLUMN outcome, DROP COLUMN action_record_id`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `DROP TABLE assistant_task_item_closures; ALTER TABLE assistant_task_items DROP COLUMN opened_at, DROP COLUMN closed_at`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `ALTER TABLE assistant_tasks DROP COLUMN last_retrospective_at`); err != nil {
			t.Fatal(err)
		}
		if result, err := tx.Exec(f.context, `DELETE FROM schema_migrations WHERE version IN (77,78,79,80,81,82,83,86,87,88,89,90,91,92,94,98,99)`); err != nil || result.RowsAffected() != 17 {
			t.Fatalf("restore migration boundary: %v %v", result, err)
		}
		if err := tx.Commit(f.context); err != nil {
			t.Fatal(err)
		}
	})
	if f.origin != origin || f.callbackURL != callback {
		t.Fatal("public origin or gateway callback changed after restart")
	}
	status = requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodGet, base+"/github", nil, http.StatusOK)
	if !status.SyncEnabled || status.Connection != "not_connected" || status.App != nil || status.Repository == nil || status.Repository.ID != "42" {
		t.Fatalf("upgraded state: %+v", status)
	}
	page = requestJSON[api.PullRequestPage](t, f, http.MethodGet, base+"/pull-requests", nil, http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].Title != "Updated while off" {
		t.Fatalf("upgrade lost PR: %+v", page)
	}
	change("Updated after upgrade")
	status = connect(project.Ownership.Version, status, currentGrant)
	if !status.SyncEnabled || status.Connection != "connected" {
		t.Fatalf("upgraded reconnect: %+v", status)
	}
	waitTitle("Updated after upgrade")
	impact := requestJSON[api.GitHubAppImpact](t, f, http.MethodGet, appBase+"/team-grants/"+currentGrant.ID+"/revocation-preview", nil, http.StatusOK)
	if impact.TotalProjects != "1" {
		t.Fatalf("revocation impact: %+v", impact)
	}
	revoked := requestJSON[api.GitHubGrantRevoked](t, f, http.MethodPost, appBase+"/team-grants/"+currentGrant.ID+"/revoke", map[string]any{"version": impact.Version, "impactVersion": impact.ImpactVersion, "expectedUserId": f.userID}, http.StatusOK)
	if !revoked.Revoked || revoked.GrantID != currentGrant.ID {
		t.Fatalf("revoked: %+v", revoked)
	}
	status = requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodGet, base+"/github", nil, http.StatusOK)
	if status.SyncEnabled || status.Connection != "not_connected" || status.App != nil || status.GrantID != nil {
		t.Fatalf("after revocation: %+v", status)
	}
	page = requestJSON[api.PullRequestPage](t, f, http.MethodGet, base+"/pull-requests", nil, http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].Title != "Updated after upgrade" {
		t.Fatalf("revocation lost PR: %+v", page)
	}
	currentGrant = grant(project.Ownership.TeamID)
	status = connect(project.Ownership.Version, status, currentGrant)
	if status.SyncEnabled || status.Connection != "connected" || status.GrantID == nil || *status.GrantID != currentGrant.ID {
		t.Fatalf("reconnected: %+v", status)
	}
	status = requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodPatch, base+"/github/sync", map[string]any{"version": status.Version, "syncEnabled": true}, http.StatusOK)
	if !status.SyncEnabled {
		t.Fatalf("sync after regrant: %+v", status)
	}
	target := requestJSON[api.Team](t, f, http.MethodPost, "/api/v1/teams", api.CreateTeamRequest{Name: "GitHub transfer target", ExpectedUserID: f.userID}, http.StatusCreated)
	targetGrant := grant(target.ID)
	preview := requestJSON[api.TransferPreview](t, f, http.MethodPost, base+"/transfer-preview", map[string]any{"targetTeamId": target.ID}, http.StatusOK)
	receipt := requestJSON[api.TransferReceipt](t, f, http.MethodPost, base+"/transfer", map[string]any{"ownership": preview.Ownership, "targetTeam": map[string]any{"id": target.ID, "version": preview.TargetTeam.Version}, "expectedUserId": f.userID}, http.StatusOK)
	if !receipt.Changed || receipt.OwnerTeam.ID != target.ID {
		t.Fatalf("transfer: %+v", receipt)
	}
	status = requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodGet, base+"/github", nil, http.StatusOK)
	if status.SyncEnabled || status.Connection != "not_connected" || status.App != nil || status.GrantID != nil {
		t.Fatalf("after transfer: %+v", status)
	}
	page = requestJSON[api.PullRequestPage](t, f, http.MethodGet, base+"/pull-requests", nil, http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].Title != "Updated after upgrade" {
		t.Fatalf("transfer lost PR: %+v", page)
	}
	status = connect(receipt.Ownership.Version, status, targetGrant)
	if status.SyncEnabled || status.Connection != "connected" || status.GrantID == nil || *status.GrantID != targetGrant.ID {
		t.Fatalf("target reconnection: %+v", status)
	}
}
