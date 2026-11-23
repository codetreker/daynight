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
func githubIntegrationRemote(t *testing.T, commits reviewerFixtureCommits) (*githubFixtureConfig, func(string), func(string), func(string), func(string)) {
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
	firstBase := "trunk"
	secondBase := "release"
	secondState := "open"
	secondRevision := 0
	setTitle := func(v string) { mu.Lock(); title = v; mu.Unlock() }
	setFirstBase := func(v string) { mu.Lock(); firstBase = v; mu.Unlock() }
	setSecondBase := func(v string) { mu.Lock(); secondBase = v; mu.Unlock() }
	setSecondState := func(v string) { mu.Lock(); secondState = v; secondRevision++; mu.Unlock() }
	remote := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/app":
			fmt.Fprint(w, `{"id":13,"name":"Integration App","slug":"integration-app"}`)
		case "/app/installations":
			fmt.Fprint(w, `[{"id":99,"account":{"login":"example"}}]`)
		case "/app/installations/99":
			fmt.Fprint(w, `{"id":99,"suspended_at":null}`)
		case "/repos/example/integration/installation", "/repos/example/replacement/installation":
			fmt.Fprint(w, `{"id":99,"account":{"login":"example"}}`)
		case "/app/installations/99/access_tokens":
			w.WriteHeader(http.StatusCreated)
			fmt.Fprintf(w, `{"token":"test","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
		case "/repos/example/integration":
			fmt.Fprint(w, `{"id":42,"full_name":"example/integration","private":false,"default_branch":"trunk"}`)
		case "/repos/example/replacement":
			fmt.Fprint(w, `{"id":43,"full_name":"example/replacement","private":false,"default_branch":"trunk"}`)
		case "/repos/example/replacement/pulls":
			fmt.Fprint(w, `[]`)
		case "/installation/repositories":
			fmt.Fprint(w, `{"repositories":[{"id":42,"full_name":"example/integration","private":false,"default_branch":"trunk"},{"id":43,"full_name":"example/replacement","private":false,"default_branch":"trunk"}]}`)
		case "/repos/example/integration/pulls", "/repos/example/integration/pulls/1", "/repos/example/integration/pulls/2":
			mu.Lock()
			current, firstBranch, second, state, revision := title, firstBase, secondBase, secondState, secondRevision
			mu.Unlock()
			pull := func(number, id int, name, base string) map[string]any {
				return map[string]any{"number": number, "id": id, "html_url": fmt.Sprintf("https://github.com/example/integration/pull/%d", number), "title": name, "state": "open", "draft": false, "user": nil, "base": map[string]any{"ref": base, "sha": commits.base, "repo": map[string]any{"id": 42}}, "head": map[string]any{"ref": "branch", "sha": commits.head, "repo": nil}, "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z", "closed_at": nil, "merged_at": nil, "body": "saved"}
			}
			first, other := pull(1, 101, current, firstBranch), pull(2, 102, "Second PR", second)
			other["draft"] = true
			if revision > 0 {
				other["updated_at"] = fmt.Sprintf("2026-01-%02dT00:00:00Z", revision+2)
			}
			if state != "open" {
				other["state"] = "closed"
				other["closed_at"] = "2026-01-03T00:00:00Z"
				if state == "merged" {
					other["merged_at"] = "2026-01-05T00:00:00Z"
				}
			}
			switch r.URL.Path {
			case "/repos/example/integration/pulls/1":
				_ = json.NewEncoder(w).Encode(first)
			case "/repos/example/integration/pulls/2":
				_ = json.NewEncoder(w).Encode(other)
			default:
				page := []any{first}
				if state == "open" || r.URL.Query().Get("state") == "all" {
					page = append(page, other)
				}
				if r.URL.Query().Get("direction") == "desc" && len(page) == 2 {
					page[0], page[1] = page[1], page[0]
				}
				if r.URL.Query().Get("per_page") == "1" && len(page) > 1 {
					page = page[:1]
				}
				_ = json.NewEncoder(w).Encode(page)
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
	return &githubFixtureConfig{privateKey: keyFile, caFile: caFile, proxyURL: proxy.URL}, setTitle, setFirstBase, setSecondBase, setSecondState
}

func TestServerAPIGitHubSyncNormalFlow(t *testing.T) {
	commits := prepareReviewerFixtureGit(t)
	config, change, changeFirstBase, changeSecondBase, changeSecondState := githubIntegrationRemote(t, commits)
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
	connect := func(ownershipVersion int64, current api.GitHubProjectAppStatus, selected api.GitHubTeamGrant, repositoryID string) api.GitHubProjectAppStatus {
		t.Helper()
		selection := url.Values{"appResourceId": {appID}, "appVersion": {app.Version}, "grantId": {selected.ID}, "ownershipVersion": {strconv.FormatInt(ownershipVersion, 10)}}
		candidate := requestJSON[api.GitHubInstallationCandidate](t, f, http.MethodGet, base+"/github/installation?"+selection.Encode(), nil, http.StatusOK)
		if candidate.Installation.ID != "99" || candidate.Repository.ID != repositoryID {
			t.Fatalf("discovery: %+v", candidate)
		}
		return requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodPost, base+"/github/connect", map[string]any{"version": current.Version, "ownershipVersion": strconv.FormatInt(ownershipVersion, 10), "appResourceId": appID, "appVersion": app.Version, "grantId": selected.ID, "installationId": candidate.Installation.ID}, http.StatusOK)
	}
	status = connect(project.Ownership.Version, status, currentGrant, "42")
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
			page := requestJSON[api.PullRequestPage](t, f, http.MethodGet, base+"/pull-requests?state=all", nil, http.StatusOK)
			current := requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodGet, base+"/github", nil, http.StatusOK)
			if len(page.Items) == 2 && page.Items[1].Title == want && !current.Initializing && current.Poll.LastSuccessAt != nil {
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
	changeRepository := func(target string) {
		t.Helper()
		preview := requestJSON[api.RepositoryPreview](t, f, http.MethodPost, base+"/repository/preview", map[string]any{"repoUrl": target, "expectedUserId": f.userID}, http.StatusOK)
		receipt := requestJSON[api.RepositoryReceipt](t, f, http.MethodPatch, base+"/repository", map[string]any{
			"repoUrl": target, "expectedUserId": f.userID, "repositoryVersion": preview.RepositoryVersion,
			"ownershipVersion": preview.OwnershipVersion, "classification": preview.Classification,
			"targetGitHubRepositoryId": preview.TargetGitHubRepositoryID, "treatUnverifiedAsSwitch": preview.Classification == "unverified",
		}, http.StatusOK)
		if !receipt.Changed || !receipt.BindingsInvalidated || receipt.RepoURL != target {
			t.Fatalf("repository switch: %+v", receipt)
		}
	}
	serverAPIReviewAssignmentFlow(t, f, project.ID, commits, func() {
		changeSecondBase("trunk")
		sendPullWebhook(t, f, appBase, 2)
	}, func(branch string) {
		changeFirstBase(branch)
		sendPullWebhook(t, f, appBase, 1)
	}, func(state string) {
		changeSecondState(state)
		sendPullWebhook(t, f, appBase, 2)
	}, func(restore bool) {
		repositoryID := "43"
		if !restore {
			changeRepository("https://github.com/example/replacement")
		} else {
			changeRepository("https://github.com/example/integration")
			repositoryID = "42"
		}
		status = requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodGet, base+"/github", nil, http.StatusOK)
		status = connect(project.Ownership.Version, status, currentGrant, repositoryID)
		status = requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodPatch, base+"/github/sync", map[string]any{"version": status.Version, "syncEnabled": true}, http.StatusOK)
		if restore {
			waitTitle("Initial PR")
		}
	})
	change("Updated by webhook")
	sendPullWebhook(t, f, appBase, 1)
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		current := requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodGet, base+"/github", nil, http.StatusOK)
		page := requestJSON[api.PullRequestPage](t, f, http.MethodGet, base+"/pull-requests?state=all", nil, http.StatusOK)
		if current.Webhook.LastSuccessAt != nil && len(page.Items) == 2 && page.Items[1].Title == "Updated by webhook" {
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
	page := requestJSON[api.PullRequestPage](t, f, http.MethodGet, base+"/pull-requests?state=all", nil, http.StatusOK)
	if len(page.Items) != 2 || page.Items[1].Title != "Updated by webhook" {
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
		if _, err := tx.Exec(f.context, `DROP TABLE project_pr_review_assignments`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `DROP TABLE assistant_task_inbox_receipts, assistant_task_inboxes;
			DROP INDEX assistant_task_events_inbound_settled;
			ALTER TABLE assistant_task_events DROP COLUMN settled_at`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `ALTER TABLE workers DROP COLUMN archive_sessions, DROP COLUMN alias_value, DROP COLUMN alias_version, DROP COLUMN review_enabled, DROP COLUMN review_version`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `ALTER TABLE projects DROP COLUMN repository_identity, DROP COLUMN repository_version`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `DROP INDEX project_pull_requests_state_number, project_pull_requests_author_number;
			ALTER TABLE project_pull_requests DROP CONSTRAINT project_pull_requests_pkey;
			ALTER TABLE project_pull_requests DROP COLUMN repository_id;
			ALTER TABLE project_pull_requests ADD PRIMARY KEY (project_id,number);
			CREATE INDEX project_pull_requests_state_number ON project_pull_requests (project_id,state,number DESC);
			ALTER TABLE project_github DROP COLUMN legacy_repository_id, DROP COLUMN repository_default_branch;
			DROP TABLE project_github_repositories`); err != nil {
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
		if _, err := tx.Exec(f.context, `DROP TABLE bot_recovery_operations, bot_recovery`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `ALTER TABLE assistant_task_records DROP COLUMN outcome, DROP COLUMN action_record_id`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `ALTER TABLE webhook_events DROP COLUMN actor_kind, DROP COLUMN actor_user_id, DROP COLUMN actor_bot_id`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `DROP TABLE assistant_task_item_closures; ALTER TABLE assistant_task_items DROP COLUMN opened_at, DROP COLUMN closed_at`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `ALTER TABLE assistant_tasks DROP COLUMN last_retrospective_at`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `ALTER TABLE personal_access_tokens DROP COLUMN description, DROP COLUMN business_scopes, DROP COLUMN scope_version; ALTER TABLE device_authorizations DROP COLUMN approved_business_scopes; ALTER TABLE oauth_grants DROP COLUMN description, DROP COLUMN business_scopes, DROP COLUMN scope_version; ALTER TABLE oauth_authorizations DROP COLUMN approved_business_scopes`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `DROP TABLE assistant_task_appendix_validations; ALTER TABLE assistant_task_appendix DROP COLUMN scope_project_ids, DROP COLUMN scope_event_types, DROP COLUMN scope_item_categories, DROP COLUMN success_count, DROP COLUMN failure_count, DROP COLUMN last_validated_at`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `DROP TABLE worker_lifecycle_observations, worker_lifecycle_operations, worker_lifecycle;
			ALTER TABLE session_operations DROP COLUMN worker_id, DROP COLUMN worker_intent_version`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `DROP INDEX webhook_endpoints_live_client_key_idx; ALTER TABLE webhook_endpoints DROP COLUMN client_key`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `DROP INDEX task_properties_worker_active_claim_idx`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(f.context, `ALTER TABLE task_sessions DROP COLUMN history_content_policy, DROP COLUMN online_mode`); err != nil {
			t.Fatal(err)
		}
		// The ledger must stay an ordered prefix, so a later data-only backfill
		// is withdrawn here too even though it reconstructs no schema.
		if result, err := tx.Exec(f.context, `DELETE FROM schema_migrations WHERE version IN (77,78,79,80,81,82,83,86,87,88,89,90,91,92,93,94,95,96,97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,115,116)`); err != nil || result.RowsAffected() != 38 {
			t.Fatalf("restore migration boundary: %v %v", result, err)
		}
		if err := tx.Commit(f.context); err != nil {
			t.Fatal(err)
		}
	})
	if f.origin != origin || f.callbackURL != callback {
		t.Fatal("public origin or gateway callback changed after restart")
	}
	db, err := pgxpool.New(f.context, f.databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var repositoryVersion int64
	var migrationCount int
	var descriptionColumns int
	if err := db.QueryRow(f.context, `SELECT count(*) FROM information_schema.columns WHERE table_schema=current_schema() AND table_name IN ('personal_access_tokens','oauth_grants') AND column_name='description'`).Scan(&descriptionColumns); err != nil || descriptionColumns != 2 {
		t.Fatalf("credential description migration: columns=%d error=%v", descriptionColumns, err)
	}
	if err := db.QueryRow(f.context, `SELECT repository_version,(SELECT count(*) FROM schema_migrations WHERE version=95) FROM projects WHERE id=$1`, project.ID).Scan(&repositoryVersion, &migrationCount); err != nil || repositoryVersion != 1 || migrationCount != 1 {
		t.Fatalf("upgraded repository version: version=%d migration count=%d error=%v", repositoryVersion, migrationCount, err)
	}
	var historyPolicyColumn bool
	if err := db.QueryRow(f.context, `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='task_sessions' AND column_name='history_content_policy'), (SELECT count(*) FROM schema_migrations WHERE version=114)`).Scan(&historyPolicyColumn, &migrationCount); err != nil || !historyPolicyColumn || migrationCount != 1 {
		t.Fatalf("upgraded Session history policy: column=%t migration count=%d error=%v", historyPolicyColumn, migrationCount, err)
	}
	var assignmentTable bool
	if err := db.QueryRow(f.context, `SELECT to_regclass('project_pr_review_assignments') IS NOT NULL,(SELECT count(*) FROM schema_migrations WHERE version=96)`).Scan(&assignmentTable, &migrationCount); err != nil || !assignmentTable || migrationCount != 1 {
		t.Fatalf("upgraded review assignment: table=%t migration count=%d error=%v", assignmentTable, migrationCount, err)
	}
	var assignmentIndex, pullIndex bool
	if err := db.QueryRow(f.context, `SELECT to_regclass('project_pr_review_assignments_worker_cursor') IS NOT NULL, to_regclass('project_pull_requests_open_github_id') IS NOT NULL, (SELECT count(*) FROM schema_migrations WHERE version=107)`).Scan(&assignmentIndex, &pullIndex, &migrationCount); err != nil || !assignmentIndex || !pullIndex || migrationCount != 1 {
		t.Fatalf("upgraded review polling indexes: assignment=%t pull=%t migration count=%d error=%v", assignmentIndex, pullIndex, migrationCount, err)
	}
	status = requestJSON[api.GitHubProjectAppStatus](t, f, http.MethodGet, base+"/github", nil, http.StatusOK)
	if !status.SyncEnabled || status.Connection != "not_connected" || status.App != nil || status.Repository == nil || status.Repository.ID != "42" {
		t.Fatalf("upgraded state: %+v", status)
	}
	page = requestJSON[api.PullRequestPage](t, f, http.MethodGet, base+"/pull-requests?state=all", nil, http.StatusOK)
	if len(page.Items) != 2 || page.Items[1].Title != "Updated while off" {
		t.Fatalf("upgrade lost PR: %+v", page)
	}
	change("Updated after upgrade")
	status = connect(project.Ownership.Version, status, currentGrant, "42")
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
	page = requestJSON[api.PullRequestPage](t, f, http.MethodGet, base+"/pull-requests?state=all", nil, http.StatusOK)
	if len(page.Items) != 2 || page.Items[1].Title != "Updated after upgrade" {
		t.Fatalf("revocation lost PR: %+v", page)
	}
	currentGrant = grant(project.Ownership.TeamID)
	status = connect(project.Ownership.Version, status, currentGrant, "42")
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
	page = requestJSON[api.PullRequestPage](t, f, http.MethodGet, base+"/pull-requests?state=all", nil, http.StatusOK)
	if len(page.Items) != 2 || page.Items[1].Title != "Updated after upgrade" {
		t.Fatalf("transfer lost PR: %+v", page)
	}
	status = connect(receipt.Ownership.Version, status, targetGrant, "42")
	if status.SyncEnabled || status.Connection != "connected" || status.GrantID == nil || *status.GrantID != targetGrant.ID {
		t.Fatalf("target reconnection: %+v", status)
	}
}

func sendPullWebhook(t *testing.T, f *fixture, appBase string, number int) {
	t.Helper()
	body := []byte(fmt.Sprintf(`{"installation":{"id":99},"repository":{"id":42},"number":%d}`, number))
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
}
