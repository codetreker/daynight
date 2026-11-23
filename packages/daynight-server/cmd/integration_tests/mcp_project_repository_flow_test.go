//go:build integration

package main

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

// Exercise the published repository tools through the assembled Server and
// verify that their receipt corresponds to the subsequently persisted Project.
func serverAPIMCPProjectRepositoryNormalFlow(t *testing.T, f *fixture) {
	t.Helper()
	project := createProject(t, f, "MCP repository change")
	target := project.RepoURL + "-replacement"
	client := sdk.NewClient(&sdk.Implementation{Name: "daynight-repository-integration", Version: "1"}, nil)
	session, err := client.Connect(f.context, &sdk.StreamableClientTransport{Endpoint: f.origin + "/mcp", HTTPClient: f.client, DisableStandaloneSSE: true, MaxRetries: -1}, &sdk.ClientSessionOptions{ProtocolVersion: "2026-07-28"})
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	listing, err := session.ListTools(f.context, nil)
	if err != nil || listing == nil {
		t.Fatalf("list tools: %+v %v", listing, err)
	}
	wanted := map[string]bool{"project_preview_repository": false, "project_set_repository": false}
	for _, tool := range listing.Tools {
		if _, ok := wanted[tool.Name]; ok && tool.InputSchema != nil {
			wanted[tool.Name] = true
		}
	}
	for name, found := range wanted {
		if !found {
			t.Fatalf("tool %s missing from discovery", name)
		}
	}
	call := func(name string, args map[string]any) map[string]any {
		t.Helper()
		result, err := session.CallTool(f.context, &sdk.CallToolParams{Name: name, Arguments: args})
		if err != nil || result == nil || result.IsError {
			t.Fatalf("%s: result=%+v error=%v", name, result, err)
		}
		encoded, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		var envelope map[string]any
		if err := json.Unmarshal(encoded, &envelope); err != nil {
			t.Fatalf("%s envelope: %s (%v)", name, encoded, err)
		}
		return envelope
	}
	previewEnvelope := call("project_preview_repository", map[string]any{"projectId": project.ID, "repoUrl": target})
	preview, ok := previewEnvelope["data"].(map[string]any)
	if !ok || preview["projectId"] != project.ID || preview["projectName"] != project.Name || preview["currentRepoUrl"] != project.RepoURL || preview["repoUrl"] != target || preview["classification"] != "unverified" || preview["bindingsInvalidated"] != true {
		t.Fatalf("repository preview: %+v", previewEnvelope)
	}
	repositoryVersion, repositoryOK := preview["repositoryVersion"].(string)
	ownershipVersion, ownershipOK := preview["ownershipVersion"].(string)
	targetID, targetPresent := preview["targetGitHubRepositoryId"]
	if !repositoryOK || repositoryVersion == "" || !ownershipOK || ownershipVersion == "" || !targetPresent {
		t.Fatalf("preview missing exact conditions: %+v", preview)
	}
	result := call("project_set_repository", map[string]any{
		"projectId": project.ID, "repoUrl": target, "repositoryVersion": repositoryVersion,
		"ownershipVersion": ownershipVersion, "classification": preview["classification"],
		"targetGitHubRepositoryId": targetID, "treatUnverifiedAsSwitch": true, "confirm": true,
	})
	data, ok := result["data"].(map[string]any)
	meta, metaOK := result["meta"].(map[string]any)
	refs, refsOK := meta["refs"].(map[string]any)
	savedVersion, versionOK := data["repositoryVersion"].(string)
	if !ok || data["projectId"] != project.ID || data["repoUrl"] != target || data["changed"] != true || data["bindingsInvalidated"] != true || !versionOK || savedVersion == "" || savedVersion == repositoryVersion || !metaOK || meta["writeOutcome"] != "confirmed" || !refsOK || refs["projectId"] != project.ID {
		t.Fatalf("repository receipt: %+v", result)
	}
	read := requestJSON[api.Project](t, f, http.MethodGet, "/api/v1/projects/"+project.ID, nil, http.StatusOK)
	if read.ID != project.ID || read.RepoURL != target {
		t.Fatalf("persisted Project: %+v", read)
	}
	mcpRead := call("project_show", map[string]any{"projectId": project.ID})
	shown, ok := mcpRead["data"].(map[string]any)
	if !ok || shown["id"] != project.ID || shown["repoUrl"] != target {
		t.Fatalf("MCP readback: %+v", mcpRead)
	}
}
