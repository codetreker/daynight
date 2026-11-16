package postgres

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	githubdao "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/github"
	syncgithub "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
	"github.com/google/uuid"
)

func TestAppExecutorRealProviderAndPublicationFence(t *testing.T) {
	db := isolatedStore(t)
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pemKey := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	for n, change := range []string{"normal", "credential", "grant"} {
		t.Run(change, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			project := queryProject(t, db, n+1)
			app, grant := uuid.NewString(), uuid.NewString()
			appID := int64(91 + n)
			mustQueryExec(t, db, `INSERT INTO github_apps(id,github_app_id,name,github_name,github_slug,private_key_pem,webhook_secret) VALUES($1,$2,'App','App','app',$3,'secret')`, app, appID, pemKey)
			mustQueryExec(t, db, `INSERT INTO github_app_team_grants(id,app_resource_id,team_id) VALUES($1,$2,$3)`, grant, app, project.Ownership.TeamID)
			mustQueryExec(t, db, `INSERT INTO project_github(project_id,generation,enabled,sync_enabled,app_id,installation_id,repository_id,app_resource_id,team_grant_id,credential_version,access_state,repository_full_name,installation_account_login,next_poll_at) VALUES($1,1,true,true,$2,20,30,$3,$4,1,'available','owner/repo','owner',now())`, project.ID, appID, app, grant)
			entered, release := make(chan struct{}), make(chan struct{})
			srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/app/installations/20/access_tokens":
					if r.Method != http.MethodPost {
						t.Errorf("token method: %s", r.Method)
					}
					w.WriteHeader(http.StatusCreated)
					fmt.Fprintf(w, `{"token":"installation-token","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
				case "/repos/owner/repo":
					io.WriteString(w, `{"id":30,"full_name":"owner/repo","private":true}`)
				case "/repos/owner/repo/pulls":
					if r.URL.Query().Get("per_page") == "1" {
						io.WriteString(w, `[]`)
						return
					}
					close(entered)
					select {
					case <-release:
					case <-r.Context().Done():
						return
					}
					io.WriteString(w, `[{"id":420,"number":42,"html_url":"https://github.com/owner/repo/pull/42","title":"Observed PR","state":"open","draft":false,"user":null,"base":{"ref":"main","repo":{"id":30}},"head":{"ref":"feature","sha":"current-sha","repo":null},"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:01Z","closed_at":null,"merged_at":null,"body":"Observed body"}]`)
				default:
					t.Errorf("unexpected GitHub request: %s", r.URL.Path)
					w.WriteHeader(http.StatusInternalServerError)
				}
			}))
			defer srv.Close()
			roots := x509.NewCertPool()
			roots.AddCert(srv.Certificate())
			original := http.DefaultTransport
			transport := original.(*http.Transport).Clone()
			transport.Proxy = nil
			transport.TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: "example.com", MinVersion: tls.VersionTLS12}
			transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
				if address != "api.github.com:443" {
					return nil, fmt.Errorf("unexpected destination %q", address)
				}
				return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
			}
			http.DefaultTransport = transport
			defer func() { http.DefaultTransport = original; transport.CloseIdleConnections() }()
			provider, err := syncgithub.NewClientProvider(githubdao.NewAppCredentialReader(db.Pool))
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				cancel()
				cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cleanupCancel()
				if err := provider.Close(cleanupCtx); err != nil {
					t.Error(err)
				}
			}()
			executor, err := syncgithub.NewAppExecutor(db, provider, slog.New(slog.NewTextHandler(io.Discard, nil)))
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- executor.Execute(ctx, project.ID) }()
			select {
			case <-entered:
			case err := <-done:
				t.Fatalf("execution stopped before poll: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			if change != "normal" {
				tx, err := db.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(context.Background())
				if _, err := tx.Exec(ctx, `SELECT id FROM github_apps WHERE id=$1 FOR UPDATE`, app); err != nil {
					t.Fatal(err)
				}
				if change == "credential" {
					_, err = tx.Exec(ctx, `UPDATE github_apps SET credential_version=credential_version+1 WHERE id=$1`, app)
				} else {
					_, err = tx.Exec(ctx, `UPDATE github_app_team_grants SET revoked_at=now() WHERE id=$1`, grant)
				}
				if err != nil {
					t.Fatal(err)
				}
				if err := tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
			}
			close(release)
			err = <-done
			var count int
			var success *time.Time
			var claim *string
			if queryErr := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_pull_requests WHERE project_id=$1),last_full_success_at,claim_token::text FROM project_github WHERE project_id=$1`, project.ID).Scan(&count, &success, &claim); queryErr != nil {
				t.Fatal(queryErr)
			}
			if change == "normal" {
				if err != nil || count != 1 || success == nil || claim != nil {
					t.Fatalf("normal publication: err=%v count=%d success=%v claim=%v", err, count, success, claim)
				}
				var body, sha string
				if err := db.Pool.QueryRow(ctx, `SELECT description,head_sha FROM project_pull_requests WHERE project_id=$1 AND number=42`, project.ID).Scan(&body, &sha); err != nil || body != "Observed body" || sha != "current-sha" {
					t.Fatalf("observation: %q %q %v", body, sha, err)
				}
			} else if !errors.Is(err, store.ErrGitHubAppWorkUnavailable) || count != 0 || success != nil {
				t.Fatalf("old response escaped %s fence: err=%v count=%d success=%v", change, err, count, success)
			}
		})
	}
}
