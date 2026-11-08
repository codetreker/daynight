package webhook_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	webhookcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	httpwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secretbox"
	"github.com/google/uuid"
)

func TestHTTPWebhookCorruptEligibilityReturnsError(t *testing.T) {
	for _, kind := range []string{"epoch", "state", "ownership", "query"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			db, err := postgres.Open(ctx, testutil.ScopedDatabaseURL(t))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			user, session, team, project := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
			token := secret.Random("dnst_")
			queries := []struct {
				sql  string
				args []any
			}{
				{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, []any{user, user}},
				{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, user, secret.Hash(token)}},
				{`INSERT INTO teams(id,name) VALUES($1,'Scope')`, []any{team}},
				{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')`, []any{team, user}},
				{`INSERT INTO projects(id,name,repo_url) VALUES($1,'Project','https://example.test/a')`, []any{project}},
				{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
			}
			for _, q := range queries {
				if _, err = db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
					t.Fatal(err)
				}
			}
			master := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
			keys, err := secretbox.Parse([]byte(`{"activeKeyId":"main","keys":{"main":"` + master + `"}}`))
			if err != nil {
				t.Fatal(err)
			}
			svc := &webhook.Service{DB: db, Keys: keys, ConfigurationExpansionAvailable: true}
			principal := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: session}
			name, enabled := "Endpoint", true
			result, err := svc.Mutate(ctx, principal, webhook.Owner{Kind: "personal", ID: user}, webhook.Mutation{Kind: "endpoint.create", OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: user, RequestSHA256: strings.Repeat("a", 64), Name: &name, Enabled: &enabled, Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: "https://example.test/hook"}, HasSubscriptions: true, Subscriptions: []webhookcore.SubscriptionInput{{ProjectID: project, EventTypes: []string{"task.created"}}}})
			if err != nil {
				t.Fatal(err)
			}
			endpoint := result.Body.(map[string]any)["endpoint"].(map[string]any)["id"].(string)
			const origin = "http://127.0.0.1:8787"
			logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
			authenticator, err := auth.NewAuthentication(identity.New(db, nil, origin+"/auth/callback"), config.AuthSettings{PublicOrigin: origin, AllowHTTPTestOrigin: true}, logger)
			if err != nil {
				t.Fatal(err)
			}
			mux := http.NewServeMux()
			httpwebhook.NewRoutes(svc, authenticator, logger).RegisterRoutes(mux)
			get := func() *httptest.ResponseRecorder {
				req := httptest.NewRequest(http.MethodGet, "/api/v1/me/webhooks/"+endpoint, nil)
				req.AddCookie(&http.Cookie{Name: "daynight_session", Value: token})
				w := httptest.NewRecorder()
				mux.ServeHTTP(w, req)
				return w
			}
			if w := get(); w.Code != http.StatusOK {
				t.Fatalf("baseline GET: %d %s", w.Code, w.Body.String())
			}
			switch kind {
			case "epoch", "state":
				field := "authorization_epoch"
				value := "0"
				if kind == "state" {
					field = "authorization_state"
					value = "'invalid'"
				}
				var constraint string
				if err = db.Pool.QueryRow(ctx, `SELECT conname FROM pg_constraint WHERE conrelid='webhook_subscriptions'::regclass AND pg_get_constraintdef(oid) LIKE $1`, "%"+field+"%").Scan(&constraint); err != nil {
					t.Fatal(err)
				}
				if _, err = db.Pool.Exec(ctx, fmt.Sprintf(`ALTER TABLE webhook_subscriptions DROP CONSTRAINT %q`, constraint)); err != nil {
					t.Fatal(err)
				}
				if _, err = db.Pool.Exec(ctx, `UPDATE webhook_subscriptions SET `+field+`=`+value+` WHERE endpoint_id=$1`, endpoint); err != nil {
					t.Fatal(err)
				}
			case "ownership":
				if _, err = db.Pool.Exec(ctx, `DELETE FROM project_ownership WHERE project_id=$1`, project); err != nil {
					t.Fatal(err)
				}
			case "query":
				if _, err = db.Pool.Exec(ctx, `ALTER TABLE project_grants RENAME TO inaccessible_project_grants`); err != nil {
					t.Fatal(err)
				}
			}
			response := get()
			if response.Code < 500 || strings.Contains(response.Body.String(), "access_revoked") || strings.Contains(response.Body.String(), "resource_unavailable") {
				t.Fatalf("corruption disguised as eligibility: %d %s", response.Code, response.Body.String())
			}
			t.Logf("%s GET returned %d and did not project revocation", kind, response.Code)
		})
	}
}
