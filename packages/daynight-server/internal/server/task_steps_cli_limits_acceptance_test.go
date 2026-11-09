package server

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

// The CLI is built separately; the ordinary server suite does not require its
// build artifacts. Set DAYNIGHT_TEST_CLI_MAIN to run this cross-process check.
func TestStepsCLITextAdmissionAcceptance(t *testing.T) {
	cli := os.Getenv("DAYNIGHT_TEST_CLI_MAIN")
	if cli == "" {
		t.Skip("DAYNIGHT_TEST_CLI_MAIN is not set")
	}
	integration := newDatabaseIdentityIntegration(t)
	browser := identityBrowser(t)
	user := integration.login(t, browser, "alice")
	origin := map[string]string{"Origin": integration.server.URL}
	request := func(method, path string, body any, status int) []byte {
		t.Helper()
		text := ""
		if body != nil {
			text = jsonBody(t, body)
		}
		_, data := identityRequest(t, browser, method, integration.server.URL+path, text, origin, status)
		return data
	}
	project := identityDecode[api.Project](t, request("POST", "/api/v1/projects", api.CreateProjectRequest{Name: "CLI limits", RepoURL: "https://example.com/cli-limits", ExpectedUserID: user.ID}, 201))
	parent := identityDecode[api.Task](t, request("POST", taskCollection(project.ID), map[string]any{"title": "Step limits"}, 201))
	token := identityDecode[api.CreatedPersonalAccessToken](t, request("POST", "/api/v1/me/tokens", map[string]any{"name": "CLI limits", "expiresAt": nil}, 201))
	config := t.TempDir()
	if err := os.WriteFile(filepath.Join(config, "config.yml"), []byte("serverUrl: "+integration.server.URL+"\nserverToken: "+token.Token+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	version := int64(1)
	invoke := func(wantError bool, args ...string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
		defer cancel()
		args = append([]string{cli, "task", "step"}, args...)
		args = append(args, "--project", project.ID, "--if-version", strconv.FormatInt(version, 10), "--json")
		cmd := exec.CommandContext(ctx, "node", args...)
		for _, entry := range os.Environ() {
			if !strings.HasPrefix(entry, "DN_") && !strings.HasPrefix(entry, "DAYNIGHT_") {
				cmd.Env = append(cmd.Env, entry)
			}
		}
		cmd.Env = append(cmd.Env, "DN_CONFIG_DIR="+config, "NO_COLOR=1")
		output, err := cmd.CombinedOutput()
		if wantError {
			if err == nil || !strings.Contains(string(output), "code=invalid_input") || !strings.Contains(string(output), "outcome=refused") {
				t.Fatalf("expected confirmed field refusal: %v %s", err, output)
			}
		} else {
			if err != nil {
				t.Fatalf("CLI write: %v %s", err, output)
			}
			version++
			resource := identityDecode[api.StepsResource](t, output)
			if resource.Version != version {
				t.Fatalf("CLI receipt version: %d != %d", resource.Version, version)
			}
		}
	}
	path := taskPath(parent) + "/steps"
	for i, tc := range []struct{ field, valid, excess string }{
		{"title", strings.Repeat("é", 512), strings.Repeat("é", 512) + "x"},
		{"description", strings.Repeat("\x01", 65536), strings.Repeat("\x01", 65536) + "x"},
	} {
		id := fmt.Sprintf("%08x", i+1)
		before := string(request("GET", path, nil, 200))
		add := []string{"add", parent.ID, "--id", id, "--title", "x"}
		if tc.field == "title" {
			add = []string{"add", parent.ID, "--id", id}
		}
		invoke(true, append(append([]string{}, add...), "--"+tc.field, tc.excess)...)
		if string(request("GET", path, nil, 200)) != before {
			t.Fatal("rejected CLI add changed collection")
		}
		invoke(false, append(append([]string{}, add...), "--"+tc.field, tc.valid)...)
		before = string(request("GET", path, nil, 200))
		invoke(true, "update", parent.ID, id, "--"+tc.field, tc.excess)
		if string(request("GET", path, nil, 200)) != before {
			t.Fatal("rejected CLI update changed collection")
		}
		invoke(false, "update", parent.ID, id, "--"+tc.field, "short")
		invoke(false, "update", parent.ID, id, "--"+tc.field, tc.valid)
	}
}
