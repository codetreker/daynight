package server

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func newMCPHTTPServer(t *testing.T, tx store.Transactions, files filestorage.Storage, outputs ...io.Writer) (*httptest.Server, *sessionApplication) {
	t.Helper()
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	config := configuredTestConfig()
	config.PublicOrigin = origin
	config.UniAuthCallbackURL = origin + "/api/v1/auth/callback"
	config.AllowHTTPTestOrigin, config.AllowLoopbackHTTP = true, true
	output := io.Discard
	if len(outputs) > 1 {
		t.Fatal("MCP fixture accepts at most one log writer")
	}
	if len(outputs) == 1 {
		output = outputs[0]
	}
	logger := slog.New(slog.NewJSONHandler(output, nil))
	handler, err := newTestHandler(Dependencies{Store: tx, Files: files}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	app := handler.(*sessionApplication)
	server.Config.Handler = httpx.RequestLogging(logger, app)
	server.Start()
	t.Cleanup(func() {
		server.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Shutdown(ctx); err != nil {
			t.Errorf("MCP application shutdown: %v", err)
		}
	})
	return server, app
}

type mcpPATTransport struct{ token string }

func (t mcpPATTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	r := req.Clone(req.Context())
	r.Header = req.Header.Clone()
	r.Header.Set("Authorization", "Bearer "+t.token)
	return http.DefaultTransport.RoundTrip(r)
}

func mcpPATClient(t *testing.T, address, token string) *sdk.ClientSession {
	t.Helper()
	client := sdk.NewClient(&sdk.Implementation{Name: "mcp-integration", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	session, err := client.Connect(ctx, &sdk.StreamableClientTransport{Endpoint: address + "/mcp", HTTPClient: &http.Client{Transport: mcpPATTransport{token: token}}, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		t.Fatalf("connect MCP: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func assertMCPProductionTools(t *testing.T, tools []*sdk.Tool) {
	t.Helper()
	want := map[string]bool{
		"project_create": true, "project_transfer": true, "project_list": true, "project_resolve": true, "project_show": true,
		"team_create": true, "team_rename": true, "team_delete": true, "team_leave": true,
		"team_list": true, "team_show": true, "team_projects": true, "team_member_list": true,
		"team_member_set_role": true, "team_member_remove": true,
		"team_invitation_create": true, "team_invitation_list": true, "team_invitation_revoke": true,
		"invitation_inspect": true, "invitation_accept": true,
		"bot_list": true, "bot_show": true, "bot_create": true, "bot_delete": true,
		"task_thread_read": true, "task_thread_post": true,
		"task_step_list": true, "task_step_show": true, "task_step_add": true, "task_step_update": true,
		"task_step_set_status": true, "task_step_move": true, "task_step_delete": true,
		"task_create": true, "task_show": true, "task_update": true, "task_set_status": true,
		"task_delete": true, "task_properties": true, "task_set_property": true, "task_remove_property": true,
		"task_attachment_list": true, "task_attachment_read": true, "task_attachment_remove": true, "task_attachment_put": true,
		"task_list": true, "task_ready": true, "task_graph": true, "task_work_list": true,
	}
	for _, tool := range tools {
		if !want[tool.Name] {
			t.Errorf("unexpected or duplicate production tool %s", tool.Name)
			continue
		}
		delete(want, tool.Name)
	}
	for name := range want {
		t.Errorf("missing production tool %s", name)
	}
}

func configureMCPPrincipals(t *testing.T, tx *httpTestStore, supplied map[string]model.Principal) {
	t.Helper()
	type credential struct {
		principal model.Principal
		hash      []byte
	}
	credentials := make([]credential, 0, len(supplied))
	for token, principal := range supplied {
		if token == "" || principal.UserID == "" || principal.CredentialID == "" || (principal.Kind != model.PATCredential && principal.Kind != model.SessionCredential) {
			t.Fatalf("invalid declared MCP authentication fixture: %+v", principal)
		}
		prefix := "dnpat_"
		if principal.Kind == model.SessionCredential {
			prefix = "dnst_"
		}
		if !secret.Valid(token, prefix) {
			t.Fatalf("declared MCP authentication credential is not canonical: %s", principal.Kind)
		}
		credentials = append(credentials, credential{principal: principal, hash: secret.Hash(token)})
	}
	tx.WriteIdentityCall = func(ctx context.Context, callback func(store.IdentityScope) error) (store.Completion, error) {
		dao := &mcpAuthenticationDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}}
		dao.authenticate = func(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
			dao.calls++
			if dao.calls != 1 || now.IsZero() || now.Location() != time.UTC {
				unexpectedHTTPCall(t, "MCP authentication arguments/count")
			}
			for _, fixture := range credentials {
				if kind == fixture.principal.Kind && bytes.Equal(hash, fixture.hash) {
					return fixture.principal, nil
				}
			}
			unexpectedHTTPCall(t, "MCP authentication undeclared credential")
			panic("unreachable")
		}
		err := callback(httpAuthenticationScope{t: t, dao: dao})
		if dao.calls != 1 {
			t.Errorf("MCP authentication calls = %d, want 1", dao.calls)
		}
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
}

type mcpAuthenticationDAO struct {
	httpRejectedIdentityDAO
	authenticate func(context.Context, model.CredentialKind, []byte, time.Time) (model.Principal, error)
	calls        int
}

func (d *mcpAuthenticationDAO) Authenticate(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
	return d.authenticate(ctx, kind, hash, now)
}
