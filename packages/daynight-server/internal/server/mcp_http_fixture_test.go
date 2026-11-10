package server

import (
	"context"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"net/http"
	"testing"
	"time"
)

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
		"task_session_send": true, "task_session_operation": true,
		"task_thread_read": true, "task_thread_post": true,
		"task_step_list": true, "task_step_show": true, "task_step_add": true, "task_step_update": true,
		"task_step_set_status": true, "task_step_move": true, "task_step_delete": true,
		"task_create": true, "task_show": true, "task_update": true, "task_set_status": true,
		"task_delete": true, "task_properties": true, "task_set_property": true, "task_remove_property": true,
		"task_attachment_list": true, "task_attachment_read": true, "task_attachment_remove": true, "task_attachment_put": true,
		"task_list": true, "task_ready": true, "task_graph": true, "task_work_list": true,
		"task_session_current": true, "task_session_list": true, "task_session_show": true,
		"task_session_read": true, "task_session_entry": true,
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
