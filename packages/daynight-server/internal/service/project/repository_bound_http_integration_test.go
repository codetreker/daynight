package project_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	githubstore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	githubhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/github"
	projecthttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/project"
	githubservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type boundHTTPProvider struct {
	client *remote.Client
	appID  string
}

func (p boundHTTPProvider) Acquire(_ context.Context, id string, version int64) (*remote.Client, func(), error) {
	if id != p.appID || version != 1 {
		return nil, nil, fmt.Errorf("unexpected App selection")
	}
	return p.client, func() {}, nil
}

func boundHTTPGitHubClient(t *testing.T) *remote.Client {
	t.Helper()
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/installations/20/access_tokens":
			w.WriteHeader(http.StatusCreated)
			fmt.Fprintf(w, `{"token":"token","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
		case "/installation/repositories":
			fmt.Fprint(w, `{"repositories":[{"id":31,"full_name":"acme/reused","private":true}]}`)
		case "/repos/acme/reused":
			fmt.Fprint(w, `{"id":31,"full_name":"acme/reused","private":true}`)
		case "/repos/acme/reused/pulls":
			fmt.Fprint(w, `[]`)
		case "/repos/acme/reused/installation":
			fmt.Fprint(w, `{"id":20,"account":{"login":"acme"}}`)
		default:
			t.Errorf("unexpected GitHub request %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)
	original := http.DefaultTransport
	transport := original.(*http.Transport).Clone()
	transport.Proxy = nil
	roots := x509.NewCertPool()
	roots.AddCert(upstream.Certificate())
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: "example.com", MinVersion: tls.VersionTLS12}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "api.github.com:443" {
			return nil, fmt.Errorf("unexpected upstream %s", address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, upstream.Listener.Addr().String())
	}
	key, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	http.DefaultTransport = transport
	client, err := remote.NewClient(91, key)
	http.DefaultTransport = original
	transport.CloseIdleConnections()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.CloseIdleConnections)
	return client
}

func TestRepositoryHTTPBoundSwitchAndManualReconnect(t *testing.T) {
	ctx := t.Context()
	db := testutil.OpenStore(t, postgres.Open)
	_, actor, _ := testutil.AuthRecords(t, db)
	projects := projectservice.NewAppProjects(db)
	project, err := projects.Create(ctx, actor, coreproject.CreateProject{Name: "Bound repository", RepoURL: "https://github.com/acme/original", ExpectedUserID: actor.UserID})
	if err != nil {
		t.Fatal(err)
	}
	appID, grantID := uuid.NewString(), uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,91,'App','App','app','key','secret')`, appID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, grantID, appID, project.Ownership.TeamID); err != nil {
		t.Fatal(err)
	}
	selection := coregithub.ProjectAppSelection{AppResourceID: appID, GrantID: grantID, AppVersion: 1, OwnershipVersion: project.Ownership.Version}
	connect := func(version, repoVersion, repositoryID int64, address, name string) {
		t.Helper()
		proof := coregithub.InstallationCandidate{Installation: githubpr.InstallationObservation{ID: 20, AccountLogin: "acme"}, Repository: githubpr.RepositoryObservation{ID: repositoryID, FullName: name}}
		in := coregithub.ProjectAppConnect{ProjectAppSelection: selection, Version: version, InstallationID: 20, RepositoryVersion: repoVersion}
		var out coregithub.ProjectAppStatus
		c, err := db.WriteGitHubProjectApp(ctx, project.ID, actor.UserID, appID, func(d store.GitHubProjectAppWriteDAO) error {
			var e error
			out, e = coregithub.ManageProjectApp(ctx, d, actor, "connect", in, 0, false, address, proof)
			return e
		})
		if err != nil || c.Outcome != store.TransactionCommitted || !out.Connection.Enabled || out.Connection.RepositoryID == nil || *out.Connection.RepositoryID != repositoryID {
			t.Fatalf("connect: %+v %+v %v", out, c, err)
		}
	}
	sync := func(version int64) {
		t.Helper()
		c, err := db.WriteGitHubProjectApp(ctx, project.ID, actor.UserID, "", func(d store.GitHubProjectAppWriteDAO) error {
			_, e := coregithub.ManageProjectApp(ctx, d, actor, "sync", coregithub.ProjectAppConnect{Version: version}, 0, true, "", coregithub.InstallationCandidate{})
			return e
		})
		if err != nil || c.Outcome != store.TransactionCommitted {
			t.Fatalf("sync: %+v %v", c, err)
		}
	}
	connect(1, 1, 30, "https://github.com/acme/original", "acme/original")
	sync(2)
	if _, err := db.Pool.Exec(ctx, `UPDATE project_github_coverage SET started_at=date_trunc('second',now())-interval '1 hour' WHERE project_id=$1 AND repository_id=30`, project.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,30,7,70,'old-url','old','open',false,'main','sha',now(),now(),now(),1)`, project.ID); err != nil {
		t.Fatal(err)
	}
	identity := store.GitHubAppWorkIdentity{AppResourceID: appID, GrantID: grantID, TeamID: project.Ownership.TeamID, AppID: 91, CredentialVersion: 1, OwnershipVersion: project.Ownership.Version}
	lease := store.GitHubLease{Generation: 2, Token: uuid.NewString()}
	c, err := db.WriteGitHubAppWork(ctx, project.ID, &identity, func(d store.GitHubAppWorkDAO) error {
		now, e := d.ObservedAt(ctx)
		if e != nil {
			return e
		}
		ok, e := d.Claim(ctx, store.GitHubClaim{AppID: 91, Generation: lease.Generation, Token: lease.Token, Kind: coregithub.WorkPoll, Until: now.Add(5 * time.Minute)})
		if e == nil && !ok {
			t.Fatal("old lease was not acquired")
		}
		return e
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("claim: %+v %v", c, err)
	}
	signal := func() int64 {
		t.Helper()
		var count int64
		now := time.Now().UTC()
		c, e := db.WriteGitHubAppSignals(ctx, appID, 1, func(d store.GitHubAppSignalWriter) error {
			var e error
			count, e = d.SignalPullRequest(ctx, store.GitHubAppPRSignal{InstallationID: 20, RepositoryID: 30, Number: 7, RequestID: uuid.NewString(), DeliveryID: uuid.NewString(), ReceivedAt: now, NextAttemptAt: now})
			return e
		})
		if e != nil || c.Outcome != store.TransactionCommitted {
			t.Fatalf("signal: %+v %v", c, e)
		}
		return count
	}
	if n := signal(); n != 1 {
		t.Fatalf("old signal before switch=%d", n)
	}
	projects.SetRepositoryObserver(&repositoryObserver{target: 31})
	const origin = "http://127.0.0.1:8787"
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, secret string) (model.Principal, error) {
		if kind == model.SessionCredential && secret == "admin" {
			return actor, nil
		}
		return model.Principal{}, authhttp.Failure()
	}, authconfig.AuthSettings{PublicOrigin: origin, AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	projecthttp.RegisterRoutes(mux, projects, auth, logger)
	githubClient := boundHTTPGitHubClient(t)
	manager := githubservice.NewProjectAppManager(db, boundHTTPProvider{client: githubClient, appID: appID}, logger)
	githubhttp.RegisterProjectAppRoutes(mux, manager, auth, logger)
	server := httptest.NewServer(mux)
	defer server.Close()
	client := server.Client()
	client.Timeout = 10 * time.Second
	path := server.URL + "/api/v1/projects/" + project.ID + "/repository"
	request := func(method, url string, body any, output any) {
		t.Helper()
		b, e := json.Marshal(body)
		if e != nil {
			t.Fatal(e)
		}
		req, e := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(b))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "daynight_session", Value: "admin"})
		res, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		raw, e := io.ReadAll(res.Body)
		if e != nil || res.StatusCode != http.StatusOK {
			t.Fatalf("%s: %d %s %v", method, res.StatusCode, raw, e)
		}
		if e = json.Unmarshal(raw, output); e != nil {
			t.Fatal(e)
		}
	}
	var preview api.RepositoryPreview
	request("POST", path+"/preview", map[string]any{"repoUrl": "https://github.com/acme/reused", "expectedUserId": actor.UserID}, &preview)
	if preview.Classification != "different_repository" || preview.TargetGitHubRepositoryID == nil || *preview.TargetGitHubRepositoryID != "31" {
		t.Fatalf("preview: %+v", preview)
	}
	var receipt api.RepositoryReceipt
	request("PATCH", path, map[string]any{"repoUrl": preview.RepoURL, "expectedUserId": actor.UserID, "repositoryVersion": preview.RepositoryVersion, "ownershipVersion": preview.OwnershipVersion, "classification": preview.Classification, "targetGitHubRepositoryId": preview.TargetGitHubRepositoryID, "treatUnverifiedAsSwitch": false}, &receipt)
	if !receipt.Changed || !receipt.BindingsInvalidated || receipt.RepositoryVersion != "2" {
		t.Fatalf("receipt: %+v", receipt)
	}
	var retired bool
	err = db.Pool.QueryRow(ctx, `SELECT NOT enabled AND NOT sync_enabled AND repository_id=31 AND app_resource_id IS NULL AND claim_token IS NULL AND (SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1)=0 AND EXISTS(SELECT 1 FROM project_github_coverage WHERE project_id=$1 AND repository_id=30 AND ended_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM project_github_coverage WHERE project_id=$1 AND repository_id=31) FROM project_github WHERE project_id=$1`, project.ID).Scan(&retired)
	if err != nil || !retired {
		t.Fatalf("retired=%v err=%v", retired, err)
	}
	if n := signal(); n != 0 {
		t.Fatalf("old signal during disconnect=%d", n)
	}
	var githubStatus api.GitHubProjectAppStatus
	githubPath := server.URL + "/api/v1/projects/" + project.ID + "/github"
	request("POST", githubPath+"/connect", map[string]any{"version": "4", "ownershipVersion": fmt.Sprint(project.Ownership.Version), "appResourceId": appID, "appVersion": "1", "grantId": grantID, "installationId": "20"}, &githubStatus)
	if githubStatus.Version != "5" || githubStatus.Repository == nil || githubStatus.Repository.ID != "31" || githubStatus.SyncEnabled || githubStatus.App == nil || githubStatus.App.ID != appID {
		t.Fatalf("HTTP reconnect: %+v", githubStatus)
	}
	var newCoverage int
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_github_coverage WHERE project_id=$1 AND repository_id=31`, project.ID).Scan(&newCoverage); err != nil || newCoverage != 0 {
		t.Fatalf("coverage after connect=%d %v", newCoverage, err)
	}
	request("PATCH", githubPath+"/sync", map[string]any{"version": "5", "syncEnabled": true}, &githubStatus)
	if githubStatus.Version != "6" || !githubStatus.SyncEnabled {
		t.Fatalf("HTTP sync: %+v", githubStatus)
	}
	if n := signal(); n != 0 {
		t.Fatalf("old signal after reconnect=%d", n)
	}
	c, err = db.WriteGitHubAppWork(ctx, project.ID, &identity, func(d store.GitHubAppWorkDAO) error {
		valid, e := d.ValidLease(ctx, lease)
		if valid {
			t.Error("old lease remained valid after reconnect")
		}
		return e
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("check old lease: %+v %v", c, err)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM project_github_coverage WHERE project_id=$1 AND repository_id=31 AND ended_at IS NULL`, project.ID).Scan(&newCoverage); err != nil || newCoverage != 1 {
		t.Fatalf("new coverage=%d %v", newCoverage, err)
	}
	if _, err = db.Pool.Exec(ctx, `INSERT INTO project_pull_requests(project_id,repository_id,number,github_id,url,title,state,draft,base_ref,head_sha,github_created_at,github_updated_at,observed_at,revision) VALUES($1,31,7,71,'new-url','new','open',false,'main','sha',now(),now(),now(),1)`, project.ID); err != nil {
		t.Fatal(err)
	}
	readTx, err := db.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer readTx.Rollback(context.Background())
	reader := githubstore.NewReader(readTx)
	newID := int64(31)
	for _, tc := range []struct {
		id     *int64
		title  string
		source int64
	}{{nil, "old", 30}, {&newID, "new", 31}} {
		pr, e := reader.PullRequest(ctx, project.ID, 7, tc.id)
		if e != nil || pr.Title != tc.title || pr.RepositoryID != tc.source {
			t.Fatalf("PR source %d: %+v %v", tc.source, pr, e)
		}
	}
}
