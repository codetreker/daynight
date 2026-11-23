package mcp

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestRetiredStepsPreserveOtherScopedMCPCalls(t *testing.T) {
	for _, protocol := range []string{"2025-11-25", "2026-07-28"} {
		for _, tc := range []struct {
			name    string
			scopes  []scopepolicy.ScopeID
			canRead bool
		}{
			{"existing-mixed", []scopepolicy.ScopeID{"task:read", "thread:read", "step:read", "step:write"}, true},
			{"new", []scopepolicy.ScopeID{"task:read", "thread:read"}, true},
			{"existing-step-only", []scopepolicy.ScopeID{"step:read", "step:write"}, false},
		} {
			t.Run(protocol+"/"+tc.name, func(t *testing.T) {
				f := newEntryFixture(t)
				a := scopedTestAuthorization(t, tc.scopes...)
				policy, err := scopepolicy.NewPolicy(scopepolicy.MCP, a.Policy.Scopes(), a.Policy.Version())
				if err != nil {
					t.Fatal(err)
				}
				a.Policy, a.Profile, a.Principal.Kind = &policy, model.ScopedMCPProfile, model.OAuthCredential
				token := model.OAuthAccessPrefix + tc.name
				if err := f.entry.EnableScopedAuthentication(testScopedAuthenticator{policies: map[string]model.CredentialAuthorization{token: a}}); err != nil {
					t.Fatal(err)
				}
				db := scopedTaskStore{snapshot: scopedTaskSnapshot{projects: scopedTaskProjects{t: t}}}
				if err := RegisterScopedTaskReadTools(f.entry, taskservice.NewTasks(db), taskservice.NewObservations(db, nil)); err != nil {
					t.Fatal(err)
				}
				threads := &scopedThreadTestOps{t: t}
				if err := RegisterScopedThreadTools(f.entry, threads); err != nil {
					t.Fatal(err)
				}
				client := f.client(t, protocol, token)
				args := map[string]any{"projectId": testProjectID, "taskId": testTargetID}
				for _, name := range []string{"task_show", "task_thread_read"} {
					result, body := callTaskResource(t, client, name, args)
					if result.IsError == tc.canRead {
						t.Fatalf("%s authorization changed: %#v", name, body)
					}
					if !tc.canRead && object(t, body["error"])["code"] != "insufficient_scope" {
						t.Fatalf("%s refusal: %#v", name, body)
					}
					if tc.canRead && name == "task_show" && object(t, body["data"])["id"] != testTargetID {
						t.Fatalf("Task identity changed: %#v", body)
					}
				}
				if _, err := client.CallTool(t.Context(), &sdk.CallToolParams{Name: "task_step_list", Arguments: args}); err == nil {
					t.Fatal("Step scope restored a retired tool")
				}
			})
		}
	}
}
