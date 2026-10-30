package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

type acceptanceCLIReceipt struct {
	SchemaVersion  int    `json:"schemaVersion"`
	Root           string `json:"root"`
	PackageVersion string `json:"packageVersion"`
	TarballPath    string `json:"tarballPath"`
	TarballSHA256  string `json:"tarballSha256"`
	NodePath       string `json:"nodePath"`
	EntryPath      string `json:"entryPath"`
	EntrySHA256    string `json:"entrySha256"`
	LauncherPath   string `json:"launcherPath"`
	Source         struct {
		GitSHA     string `json:"gitSha"`
		GitTreeSHA string `json:"gitTreeSha"`
		Dirty      bool   `json:"dirty"`
	} `json:"source"`
}

type acceptanceCLIRequest struct {
	RequestID string `json:"requestId"`
	Status    int    `json:"status"`
}

func readAcceptanceCLI(t *testing.T) acceptanceCLIReceipt {
	t.Helper()
	receiptPath := os.Getenv("DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT")
	if receiptPath == "" {
		t.Fatal("DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT is required for installed CLI acceptance; run scripts/check.sh")
	}
	data, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal("cannot read installed CLI receipt")
	}
	var receipt acceptanceCLIReceipt
	if err := json.Unmarshal(data, &receipt); err != nil || receipt.SchemaVersion != 1 || receipt.PackageVersion == "" || receipt.Source.GitSHA != binaryAcceptance.GitSHA || receipt.Source.GitTreeSHA != binaryAcceptance.GitTreeSHA || receipt.Source.Dirty != binaryAcceptance.Dirty {
		t.Fatal("installed CLI receipt does not match this source revision")
	}
	root, err := filepath.EvalSymlinks(receipt.Root)
	if err != nil || !filepath.IsAbs(root) {
		t.Fatal("installed CLI receipt has no absolute owned root")
	}
	projectTemporary, err := filepath.Abs(filepath.Join("..", "..", "..", "..", ".tmp"))
	if err != nil || !acceptanceCLIWithin(projectTemporary, root) {
		t.Fatal("installed CLI fixture is outside the project temporary directory")
	}
	for _, name := range []string{receipt.TarballPath, receipt.EntryPath, receipt.LauncherPath} {
		actual, err := filepath.EvalSymlinks(name)
		if err != nil || !filepath.IsAbs(name) || !acceptanceCLIWithin(root, actual) {
			t.Fatal("installed CLI artifact is outside its owned root")
		}
		info, err := os.Stat(actual)
		if err != nil || !info.Mode().IsRegular() {
			t.Fatal("installed CLI artifact is not a regular file")
		}
	}
	for _, artifact := range []struct{ path, digest string }{{receipt.TarballPath, receipt.TarballSHA256}, {receipt.EntryPath, receipt.EntrySHA256}} {
		content, err := os.ReadFile(artifact.path)
		if err != nil || fmt.Sprintf("%x", sha256.Sum256(content)) != artifact.digest {
			t.Fatal("installed CLI artifact hash differs from its receipt")
		}
	}
	if !filepath.IsAbs(receipt.NodePath) {
		t.Fatal("installed CLI receipt has no absolute Node executable")
	}
	info, err := os.Stat(receipt.NodePath)
	if err != nil || !info.Mode().IsRegular() {
		t.Fatal("installed CLI Node executable is unavailable")
	}
	manifestPath := filepath.Join(filepath.Dir(filepath.Dir(receipt.EntryPath)), "package.json")
	manifestData, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal("cannot read installed CLI package manifest")
	}
	var manifest struct {
		Name    string            `json:"name"`
		Version string            `json:"version"`
		Bin     map[string]string `json:"bin"`
	}
	if err := json.Unmarshal(manifestData, &manifest); err != nil || manifest.Name != "@codetreker/daynight" || manifest.Version != receipt.PackageVersion || manifest.Bin["daynight"] != "dist/main.js" {
		t.Fatal("installed CLI manifest differs from its receipt or public entry")
	}
	if filepath.Clean(filepath.Join(filepath.Dir(manifestPath), manifest.Bin["daynight"])) != filepath.Clean(receipt.EntryPath) {
		t.Fatal("installed CLI receipt does not identify its public manifest entry")
	}
	sourceData, err := os.ReadFile(filepath.Join(filepath.Dir(projectTemporary), "packages", "daynight", "package.json"))
	var sourceManifest struct {
		Version string `json:"version"`
	}
	if err != nil || json.Unmarshal(sourceData, &sourceManifest) != nil || sourceManifest.Version != receipt.PackageVersion {
		t.Fatal("installed CLI version differs from the source package")
	}
	if err := binaryAcceptance.update(func() { binaryAcceptance.InstalledCLI = &receipt }); err != nil {
		t.Fatal("cannot persist installed CLI identity")
	}
	return receipt
}

func acceptanceCLIWithin(root, name string) bool {
	relative, err := filepath.Rel(root, name)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

type acceptanceCLI struct {
	receipt  acceptanceCLIReceipt
	root     string
	home     string
	repo     string
	caller   string
	scenario *acceptanceScenario
}

func newAcceptanceCLI(t *testing.T, receipt acceptanceCLIReceipt, scenario *acceptanceScenario) *acceptanceCLI {
	t.Helper()
	root, err := os.MkdirTemp(filepath.Dir(binaryAcceptance.path), "installed CLI 中文 ")
	if err != nil {
		t.Fatal("cannot create owned installed CLI workspace")
	}
	fixture := &acceptanceCLI{receipt: receipt, root: root, home: filepath.Join(root, "home 中文"), repo: filepath.Join(root, "repository 中文"), caller: filepath.Join(root, "outside Git 中文"), scenario: scenario}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error("cannot remove owned installed CLI workspace")
		} else if err := binaryAcceptance.update(func() { scenario.CLIWorkspaceRemoved = true }); err != nil {
			t.Error("cannot persist installed CLI workspace cleanup")
		}
	})
	for _, directory := range []string{filepath.Join(fixture.home, ".daynight"), filepath.Join(fixture.repo, "source"), fixture.caller} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal("cannot create installed CLI fixture directories")
		}
	}
	fixture.git(t, "init", "--quiet", fixture.repo)
	fixture.git(t, "-C", fixture.repo, "remote", "add", "origin", "git@git.example:Org/Repo.git")
	return fixture
}

func (c *acceptanceCLI) configure(t *testing.T, process *acceptanceProcess) {
	t.Helper()
	if process.origin == "" || process.token == "" {
		t.Fatal("installed CLI requires an authenticated acceptance process")
	}
	if err := os.WriteFile(filepath.Join(c.home, ".daynight", "config.yml"), []byte("serverUrl: "+process.origin+"\nserverToken: "+process.token+"\n"), 0o600); err != nil {
		t.Fatal("cannot configure isolated authenticated CLI")
	}
}

func (c *acceptanceCLI) environment() []string {
	values := map[string]string{
		"HOME": c.home, "USERPROFILE": c.home, "XDG_CONFIG_HOME": filepath.Join(c.home, "config"),
		"XDG_CACHE_HOME": filepath.Join(c.home, "cache"), "APPDATA": filepath.Join(c.home, "AppData", "Roaming"),
		"LOCALAPPDATA": filepath.Join(c.home, "AppData", "Local"), "GIT_CONFIG_NOSYSTEM": "1",
		"GIT_CONFIG_GLOBAL": filepath.Join(c.root, "gitconfig"), "GIT_TERMINAL_PROMPT": "0", "NO_COLOR": "1",
	}
	var environment []string
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		upper := strings.ToUpper(key)
		_, replaced := values[upper]
		if !replaced && !strings.HasPrefix(upper, "GIT_") && !strings.HasPrefix(upper, "DAYNIGHT_") && !strings.HasPrefix(upper, "GH_") && !strings.HasPrefix(upper, "GITHUB_") && !strings.HasPrefix(upper, "COPILOT_") && upper != "NODE_OPTIONS" {
			environment = append(environment, entry)
		}
	}
	for key, value := range values {
		environment = append(environment, key+"="+value)
	}
	return environment
}

func (c *acceptanceCLI) git(t *testing.T, arguments ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "git", arguments...)
	command.Dir, command.Env = c.root, c.environment()
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("owned Git fixture failed: %v: %s", err, output)
	}
	return strings.TrimSpace(string(output))
}

type acceptanceCLIOutput struct{ bytes.Buffer }

func (b *acceptanceCLIOutput) Write(value []byte) (int, error) {
	if b.Len()+len(value) > 4<<20 {
		return 0, errors.New("installed CLI output exceeded its acceptance capture bound")
	}
	return b.Buffer.Write(value)
}

type acceptanceCLIResult struct {
	status         int
	stdout, stderr string
	err            error
}

func (c *acceptanceCLI) start(t *testing.T, cwd string, arguments ...string) <-chan acceptanceCLIResult {
	t.Helper()
	return c.startProgram(t, cwd, c.receipt.EntryPath, nil, arguments...)
}

func (c *acceptanceCLI) startProgram(t *testing.T, cwd, program string, input io.Reader, arguments ...string) <-chan acceptanceCLIResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	command := exec.CommandContext(ctx, c.receipt.NodePath, append([]string{program}, arguments...)...)
	command.Dir, command.Env, command.WaitDelay, command.Stdin = cwd, c.environment(), time.Second, input
	command.Cancel = func() error { return command.Process.Signal(os.Interrupt) }
	stdout, stderr := &acceptanceCLIOutput{}, &acceptanceCLIOutput{}
	command.Stdout, command.Stderr = stdout, stderr
	if err := command.Start(); err != nil {
		cancel()
		t.Fatal("cannot start installed CLI")
	}
	done, result := make(chan struct{}), make(chan acceptanceCLIResult, 1)
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("installed CLI process was not reaped during cleanup")
		}
	})
	if err := binaryAcceptance.update(func() { c.scenario.CLIProcessesStarted++ }); err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		close(done)
		t.Fatal("cannot persist installed CLI start receipt")
	}
	go func() {
		defer close(done)
		defer cancel()
		err := command.Wait()
		status := command.ProcessState.ExitCode()
		var exitError *exec.ExitError
		if err != nil && errors.As(err, &exitError) {
			err = nil
		}
		if updateError := binaryAcceptance.update(func() { c.scenario.CLIProcessesReaped++ }); updateError != nil {
			err = errors.Join(err, errors.New("cannot persist installed CLI reap receipt"))
		}
		result <- acceptanceCLIResult{status: status, stdout: stdout.String(), stderr: stderr.String(), err: err}
	}()
	return result
}

func acceptanceCLIReceive(t *testing.T, pending <-chan acceptanceCLIResult) acceptanceCLIResult {
	t.Helper()
	select {
	case result := <-pending:
		if result.err != nil {
			t.Fatalf("installed CLI execution failed: %v", result.err)
		}
		return result
	case <-time.After(18 * time.Second):
		t.Fatal("installed CLI exceeded its operation bound")
		return acceptanceCLIResult{}
	}
}

func (c *acceptanceCLI) run(t *testing.T, cwd string, arguments ...string) string {
	t.Helper()
	result := acceptanceCLIReceive(t, c.start(t, cwd, arguments...))
	if result.status != 0 || result.stderr != "" {
		t.Fatalf("installed CLI operation failed (%d): %s", result.status, result.stderr)
	}
	return result.stdout
}

func acceptanceCLIJSON[T any](t *testing.T, text string) T {
	t.Helper()
	var result T
	decoder := json.NewDecoder(strings.NewReader(text))
	if err := decoder.Decode(&result); err != nil {
		t.Fatalf("installed CLI did not return valid JSON: %v", err)
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		t.Fatal("installed CLI JSON output contains trailing data")
	}
	return result
}

func acceptanceCLIProjectResource(t *testing.T, text string) api.Project {
	t.Helper()
	fields := acceptanceCLIJSON[map[string]json.RawMessage](t, text)
	raw, exists := fields["settings"]
	if !exists || bytes.Equal(raw, []byte("null")) {
		t.Fatal("installed CLI project omitted its saved settings")
	}
	settings := acceptanceCLIJSON[map[string]json.RawMessage](t, string(raw))
	for _, name := range []string{"version", "executionWarningMinutes"} {
		if value, exists := settings[name]; !exists || bytes.Equal(value, []byte("null")) {
			t.Fatalf("installed CLI project omitted required settings field %s", name)
		}
	}
	project := acceptanceCLIJSON[api.Project](t, text)
	if project.Settings.Version < 1 || project.Settings.ExecutionWarningMinutes < 1 {
		t.Fatal("installed CLI project lost its saved settings values")
	}
	return project
}

func acceptanceCLIProjectsResource(t *testing.T, text string) []api.Project {
	t.Helper()
	items := acceptanceCLIJSON[[]json.RawMessage](t, text)
	if items == nil {
		t.Fatal("installed CLI project inventory is not a concrete array")
	}
	projects := make([]api.Project, 0, len(items))
	for _, item := range items {
		projects = append(projects, acceptanceCLIProjectResource(t, string(item)))
	}
	return projects
}

func acceptanceSettingsSave(t *testing.T, process *acceptanceProcess, before api.Project, minutes int32) api.Project {
	t.Helper()
	after := acceptanceDecode[api.Project](t, process.request(context.Background(), http.MethodPatch,
		"/api/v1/projects/"+before.ID+"/settings", map[string]any{"version": before.Settings.Version, "executionWarningMinutes": minutes}, "settings-save"), http.StatusOK)
	preserved := after
	preserved.Settings, preserved.UpdatedAt = before.Settings, before.UpdatedAt
	if after.Settings.Version != before.Settings.Version+1 || after.Settings.ExecutionWarningMinutes != minutes ||
		!after.UpdatedAt.After(before.UpdatedAt) || !reflect.DeepEqual(preserved, before) {
		t.Fatal("settings save did not preserve project metadata or advance the saved settings exactly once")
	}
	return after
}

func acceptanceCLITaskResource(t *testing.T, text string) api.Task {
	t.Helper()
	fields := acceptanceCLIJSON[map[string]json.RawMessage](t, text)
	for _, name := range []string{"startedAt", "completedAt", "allowAgents", "requiredPlatform", "externalDependsOn"} {
		if _, exists := fields[name]; !exists {
			t.Fatalf("installed CLI task omitted required task field %s", name)
		}
	}
	return acceptanceCLIJSON[api.Task](t, text)
}

func acceptanceCLIGraphResource(t *testing.T, text string) api.TaskGraph {
	t.Helper()
	var fields struct {
		Project    json.RawMessage              `json:"project"`
		ObservedAt json.RawMessage              `json:"observedAt"`
		Tasks      []map[string]json.RawMessage `json:"tasks"`
	}
	if err := json.Unmarshal([]byte(text), &fields); err != nil || len(fields.ObservedAt) == 0 || bytes.Equal(fields.ObservedAt, []byte("null")) {
		t.Fatal("installed CLI graph omitted its observed server time")
	}
	acceptanceCLIProjectResource(t, string(fields.Project))
	for _, task := range fields.Tasks {
		for _, name := range []string{"startedAt", "completedAt", "allowAgents", "requiredPlatform", "externalDependsOn"} {
			if _, exists := task[name]; !exists {
				t.Fatalf("installed CLI graph omitted required task field %s", name)
			}
		}
	}
	graph := acceptanceCLIJSON[api.TaskGraph](t, text)
	if graph.ObservedAt.IsZero() || graph.ObservedAt.Location() != time.UTC {
		t.Fatal("installed CLI graph lost the UTC database clock sample")
	}
	return graph
}

func acceptanceCLITaskListJSON(t *testing.T, text string, expected []api.Task) {
	t.Helper()
	for _, task := range acceptanceCLIJSON[[]map[string]json.RawMessage](t, text) {
		if _, included := task["description"]; included {
			t.Fatal("installed CLI list JSON included description")
		}
		for _, name := range []string{"startedAt", "completedAt", "allowAgents", "requiredPlatform", "externalDependsOn"} {
			if _, exists := task[name]; !exists {
				t.Fatalf("installed CLI list omitted required task field %s", name)
			}
		}
	}
	projected := slices.Clone(expected)
	for index := range projected {
		projected[index].Description = ""
	}
	if listed := acceptanceCLIJSON[[]api.Task](t, text); !reflect.DeepEqual(listed, projected) {
		t.Fatal("installed CLI list JSON changed the selected task membership, order or fields other than description")
	}
}

func acceptanceCLIResourceID(t *testing.T, text string) string {
	t.Helper()
	for _, line := range strings.Split(text, "\n") {
		if id, found := strings.CutPrefix(line, "ID: "); found && len(id) == 36 {
			return id
		}
	}
	t.Fatal("installed CLI mutation did not return a resource ID")
	return ""
}

func (c *acceptanceCLI) task(t *testing.T, id string) api.Task {
	t.Helper()
	return acceptanceCLITaskResource(t, c.run(t, filepath.Join(c.repo, "source"), "task", "show", id, "--json"))
}

func acceptanceCLIMutations(process *acceptanceProcess) []acceptanceCLIRequest {
	process.logs.mu.Lock()
	defer process.logs.mu.Unlock()
	var requests []acceptanceCLIRequest
	for _, event := range process.logs.events {
		route, _ := event["route"].(string)
		lifecycle := event["method"] == "PUT" && strings.HasSuffix(route, "/status")
		if event["type"] == "http_request" && (event["method"] == "PATCH" || lifecycle) {
			id, _ := event["request_id"].(string)
			status, _ := event["status"].(float64)
			requests = append(requests, acceptanceCLIRequest{RequestID: id, Status: int(status)})
		}
	}
	return requests
}

func acceptanceCLIWaitMutations(t *testing.T, process *acceptanceProcess, count int) []acceptanceCLIRequest {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := acceptanceEventually(ctx, func() (bool, error) { return len(acceptanceCLIMutations(process)) >= count, nil }); err != nil {
		t.Fatal("installed CLI mutations did not complete their server request logs")
	}
	return acceptanceCLIMutations(process)
}

func (c *acceptanceCLI) refuse(t *testing.T, process *acceptanceProcess, code, taskID string, arguments ...string) acceptanceCLIResult {
	t.Helper()
	before := len(acceptanceCLIMutations(process))
	result := acceptanceCLIReceive(t, c.start(t, c.repo, arguments...))
	if result.status != 1 || result.stdout != "" || !strings.Contains(result.stderr, code) || taskID != "" && !strings.Contains(result.stderr, taskID) {
		t.Fatalf("installed CLI refusal lost its code, task ID or exit behavior: %+v", result)
	}
	requests := acceptanceCLIWaitMutations(t, process, before+1)
	if len(requests) != before+1 || requests[before].Status != 409 || requests[before].RequestID == "" || !strings.Contains(result.stderr, "requestId="+requests[before].RequestID) {
		t.Fatal("installed CLI refusal retried or lost the actual server request identity")
	}
	if err := binaryAcceptance.update(func() {
		c.scenario.CLIRefusalRequestIDs = append(c.scenario.CLIRefusalRequestIDs, requests[before].RequestID)
	}); err != nil {
		t.Fatal("cannot persist installed CLI refusal identity")
	}
	return result
}

func acceptanceCLITaskChainGraph(t *testing.T, cli *acceptanceCLI, process *acceptanceProcess) {
	t.Helper()
	project := process.project(t, "Scoped graph dependency audit")
	ordinaryPre := process.task(t, project, "External ordinary prerequisite")
	externalPre := process.task(t, project, "External prerequisite")
	x := process.task(t, project, "Direct external context", ordinaryPre.ID, externalPre.ID)
	x = acceptanceDecode[api.Task](t, process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(x), map[string]any{"version": x.Version, "externalDependsOn": []string{externalPre.ID}}, ""), http.StatusOK)
	a := process.task(t, project, "Chain root")
	b := process.task(t, project, "Chain B", a.ID, x.ID)
	b = acceptanceDecode[api.Task](t, process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(b), map[string]any{"version": b.Version, "externalDependsOn": []string{x.ID}}, ""), http.StatusOK)
	c := process.task(t, project, "Chain C", a.ID)
	d := process.task(t, project, "Chain join", b.ID, c.ID)
	reverse := process.task(t, project, "Outside external dependent", b.ID)
	acceptanceDecode[api.Task](t, process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(reverse), map[string]any{"version": reverse.Version, "externalDependsOn": []string{b.ID}}, ""), http.StatusOK)
	want := []api.Task{x, a, b, c, d}
	for _, seed := range []api.Task{b, c} {
		graph := acceptanceCLIGraphResource(t, cli.run(t, cli.caller, "task", "graph", seed.ID, "--project", project.ID, "--json"))
		if len(graph.Tasks) != len(want) {
			t.Fatalf("installed graph expanded external relationships: %#v", graph)
		}
		for index, task := range graph.Tasks {
			if task.ID != want[index].ID || !slices.Equal(task.DependsOn, want[index].DependsOn) || !slices.Equal(task.ExternalDependsOn, want[index].ExternalDependsOn) || !slices.Equal(task.BlockedBy, want[index].BlockedBy) {
				t.Fatalf("installed graph changed raw context relations: %#v", task)
			}
		}
	}
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal([]byte(cli.run(t, cli.caller, "task", "graph", b.ID, "--project", project.ID, "--depends-only", "--json")), &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) != len(want) {
		t.Fatalf("installed dependency audit changed scoped membership: %#v", rows)
	}
	var text strings.Builder
	for index, row := range rows {
		var id string
		var depends, external []string
		if len(row) != 3 || json.Unmarshal(row["id"], &id) != nil || json.Unmarshal(row["dependsOn"], &depends) != nil || json.Unmarshal(row["externalDependsOn"], &external) != nil || id != want[index].ID || !slices.Equal(depends, want[index].DependsOn) || !slices.Equal(external, want[index].ExternalDependsOn) {
			t.Fatalf("installed audit lost raw or unexpanded dependency IDs: %#v", row)
		}
		names := func(ids []string) string {
			if len(ids) == 0 {
				return "none"
			}
			return strings.Join(ids, ", ")
		}
		if index > 0 {
			text.WriteString("\n")
		}
		fmt.Fprintf(&text, "ID: %s\nDepends on: %s\nExternal dependencies: %s\n", id, names(depends), names(external))
	}
	if got := cli.run(t, cli.caller, "task", "graph", b.ID, "--project", project.ID, "--depends-only"); got != text.String() {
		t.Fatalf("installed text dependency audit changed fields or raw dependency IDs: got %q want %q", got, text.String())
	}
}

func TestInstalledCLIProjectTaskAcceptance(t *testing.T) {
	receipt := readAcceptanceCLI(t)
	acceptanceCase(t, "installed_cli_project_task_workflow", []string{"PT.V1", "PT.V3", "PT.V5", "PT.V6", "PT.V7", "PT.V8", "PT.V9", "PT.V10", "TP-V1", "TP-V3", "TP-V6", "TP-V8"}, func(t *testing.T, scenario *acceptanceScenario) {
		fixture := newAcceptanceFixture(t, scenario)
		// This journey launches over a hundred CLI processes; their individual deadlines remain independent.
		fixture.serverLifetime = 2 * time.Minute
		cli := newAcceptanceCLI(t, receipt, scenario)
		if version := cli.run(t, cli.caller, "--version"); version != receipt.PackageVersion+"\n" {
			t.Fatal("fresh installed CLI version differs from its validated manifest")
		}
		process := fixture.launch(t, nil).started(t)
		cli.configure(t, process)
		projectID := acceptanceCLIResourceID(t, cli.run(t, filepath.Join(cli.repo, "source"), "project", "create", "Installed CLI 项目"))
		for _, arguments := range [][]string{
			{"project", "create", "Preserve existing name"},
			{"project", "create", "Explicit existing project", "--repo", "https://Git.Example/Org/Repo.git"},
		} {
			output := cli.run(t, cli.repo, arguments...)
			if !strings.HasPrefix(output, "Project already exists.\n") || acceptanceCLIResourceID(t, output) != projectID {
				t.Fatal("installed project creation did not return the existing repository project")
			}
		}
		project := acceptanceCLIProjectResource(t, cli.run(t, cli.caller, "project", "show", projectID, "--json"))
		projects := acceptanceCLIProjectsResource(t, cli.run(t, cli.caller, "project", "list", "--json"))
		if len(projects) != 1 || !reflect.DeepEqual(projects[0], project) || project.Name != "Installed CLI 项目" || project.RepoURL != "git@git.example:Org/Repo.git" {
			t.Fatal("installed project commands disagree with the created resource")
		}
		if project.Settings != (api.ProjectSettings{Version: 1, ExecutionWarningMinutes: 60}) {
			t.Fatal("new project did not expose the persistent default warning threshold")
		}
		isolatedProject := process.project(t, "Independent warning settings")
		originalProject := project
		project = acceptanceSettingsSave(t, process, project, 90)
		settingsPath := "/api/v1/projects/" + project.ID + "/settings"
		unchanged := acceptanceDecode[api.Project](t, process.request(context.Background(), http.MethodPatch, settingsPath,
			map[string]any{"version": project.Settings.Version, "executionWarningMinutes": project.Settings.ExecutionWarningMinutes}, "settings-current-noop"), http.StatusOK)
		if !reflect.DeepEqual(unchanged, project) {
			t.Fatal("current same-value settings save changed the settings version or project timestamp")
		}
		acceptanceError(t, process.request(context.Background(), http.MethodPatch, settingsPath,
			map[string]any{"version": originalProject.Settings.Version, "executionWarningMinutes": project.Settings.ExecutionWarningMinutes}, "settings-stale-noop"), http.StatusConflict, "version_conflict")
		if after := acceptanceCLIProjectResource(t, cli.run(t, cli.caller, "project", "show", project.ID, "--json")); !reflect.DeepEqual(after, project) {
			t.Fatal("packed installed CLI did not read the settings saved through the real API")
		}
		if after := acceptanceDecode[api.Project](t, process.request(context.Background(), http.MethodGet, "/api/v1/projects/"+isolatedProject.ID, nil, "settings-isolation"), http.StatusOK); !reflect.DeepEqual(after, isolatedProject) {
			t.Fatal("saving one project's warning threshold changed another project")
		}
		if _, err := os.Stat(filepath.Join(cli.repo, ".daynight")); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("installed project creation wrote repository binding metadata")
		}
		references := api.TaskProperties{PullRequests: []api.PullRequestProperty{
			{URL: "", Title: ""},
			{URL: "-arbitrary=地址, text", Title: "  标题\n\x1b[2J  "},
			{URL: "-arbitrary=地址, text", Title: "  标题\n\x1b[2J  "},
		}}
		pairs := []string{"--pull-request-url=", "--pull-request-title=", "--pull-request-title", references.PullRequests[1].Title, "--pull-request-url=" + references.PullRequests[1].URL, "--pull-request-url=" + references.PullRequests[2].URL, "--pull-request-title", references.PullRequests[2].Title}
		created := cli.run(t, filepath.Join(cli.repo, "source"), append([]string{"task", "create", "--title", "前置 Task", "--description", "Persistent description"}, pairs...)...)
		first := acceptanceCLIResourceID(t, created)
		if !strings.Contains(created, "Pull requests: 3\n  1. Title: \n     URL: \n") || !strings.Contains(created, "3. Title:   标题\\n\\u001b[2J  \n     URL: -arbitrary=地址, text") || !reflect.DeepEqual(cli.task(t, first).Properties, references) || cli.task(t, first).Status != "todo" || !cli.task(t, first).Ready {
			t.Fatal("installed CLI create changed raw PR strings, order, duplicates or text output")
		}
		bindingPath := filepath.Join(cli.repo, ".daynight", "project.yml")
		binding, err := os.ReadFile(bindingPath)
		if err != nil || !bytes.Contains(binding, []byte("repoIdentity: git.example/Org/Repo\n")) || !bytes.Contains(binding, []byte("projectId: "+projectID+"\n")) || !bytes.Contains(binding, []byte("serverUrl: "+process.origin+"\n")) || bytes.Contains(binding, []byte(process.token)) {
			t.Fatal("installed CLI did not persist its discovered repository association")
		}
		cli.git(t, "-C", cli.repo, "check-ignore", "--quiet", ".daynight/project.yml")
		if entries, err := os.ReadDir(filepath.Dir(bindingPath)); err != nil || len(entries) != 1 || entries[0].Name() != "project.yml" {
			t.Fatal("installed discovery left an unexpected metadata file or lock")
		}
		second := acceptanceCLIResourceID(t, cli.run(t, cli.repo, "task", "create", "--title", "Alternate"))
		if task := cli.task(t, second); task.Properties.PullRequests == nil || len(task.Properties.PullRequests) != 0 {
			t.Fatal("installed CLI creation without PR options did not read a concrete empty list")
		}
		target := acceptanceCLIResourceID(t, cli.run(t, cli.repo, "task", "create", "--title", "Dependent", "--depends-on", first))
		blocked := cli.task(t, target)
		if blocked.Version != 1 || blocked.Status != "todo" || blocked.Ready || !slices.Equal(blocked.DependsOn, []string{first}) || !slices.Equal(blocked.BlockedBy, []string{first}) {
			t.Fatal("installed task creation lost its server dependency projection")
		}
		cli.run(t, cli.repo, "task", "set-status", target, "todo", "--if-version", "1")
		if confirmed := cli.task(t, target); !reflect.DeepEqual(confirmed, blocked) {
			t.Fatal("installed same-status confirmation changed blocked todo work")
		}
		cli.refuse(t, process, "dependency_unsatisfied", first, "task", "set-status", target, "in_progress")
		beforeFirstClaim := cli.task(t, first)
		cli.run(t, cli.repo, "task", "set-status", first, "in_progress")
		firstRunning := cli.task(t, first)
		acceptanceTaskTimingTransition(t, beforeFirstClaim, firstRunning, "in_progress")
		cli.run(t, cli.repo, "task", "set-status", first, "done")
		firstCompleted := cli.task(t, first)
		acceptanceTaskTimingTransition(t, firstRunning, firstCompleted, "done")
		acceptanceCLITaskListJSON(t, cli.run(t, cli.repo, "task", "list", "--status", "todo", "--ready", "--json"), []api.Task{cli.task(t, second), cli.task(t, target)})
		cli.run(t, cli.repo, "task", "update", target, "--description", "Completed description")
		beforeTargetClaim := cli.task(t, target)
		cli.run(t, cli.repo, "task", "set-status", target, "in_progress")
		targetRunning := cli.task(t, target)
		acceptanceTaskTimingTransition(t, beforeTargetClaim, targetRunning, "in_progress")
		cli.refuse(t, process, "dependency_unsatisfied", target, "task", "set-status", first, "in_progress")
		cli.run(t, cli.repo, "task", "update", target, "--description", "")
		targetEdited := cli.task(t, target)
		if !reflect.DeepEqual(targetEdited.StartedAt, targetRunning.StartedAt) || !reflect.DeepEqual(targetEdited.CompletedAt, targetRunning.CompletedAt) {
			t.Fatal("installed running-task metadata edit changed execution timing")
		}
		cli.run(t, cli.repo, "task", "set-status", target, "done")
		acceptanceTaskTimingTransition(t, targetEdited, cli.task(t, target), "done")
		if task := cli.task(t, target); task.Version != 5 || task.Description != "" || task.Status != "done" {
			t.Fatal("installed update did not clear description or advance the expected version")
		}
		editable := acceptanceCLIResourceID(t, cli.run(t, cli.repo, "task", "create", "--title", "Editable", "--depends-on", first))
		cli.run(t, cli.repo, "task", "update", editable, "--depends-on", second)
		if task := cli.task(t, editable); !slices.Equal(task.DependsOn, []string{second}) || task.Ready {
			t.Fatal("installed dependency update did not replace the full set")
		}
		cli.refuse(t, process, "dependency_cycle", editable, "task", "update", second, "--depends-on", editable)
		cli.run(t, cli.repo, "task", "update", editable, "--clear-dependencies")
		if task := cli.task(t, editable); len(task.DependsOn) != 0 || !task.Ready || task.Status != "todo" {
			t.Fatal("installed dependency clear changed todo readiness or left a dependency")
		}
		beforeLegacy := len(acceptanceCLIMutations(process))
		for _, arguments := range [][]string{{"task", "approve", editable}, {"task", "unapprove", editable}, {"task", "claim", editable}, {"task", "complete", editable}, {"task", "set-status", editable, "proposed"}, {"task", "list", "--status", "proposed"}} {
			result := acceptanceCLIReceive(t, cli.start(t, cli.repo, arguments...))
			if result.status != 2 || result.stdout != "" || result.stderr == "" || len(acceptanceCLIMutations(process)) != beforeLegacy {
				t.Fatal("installed deleted command or state reached a mutation or lost its usage failure")
			}
		}
		legacy := acceptanceCLIReceive(t, cli.start(t, cli.repo, "task", "update", editable, "--status", "done"))
		if legacy.status != 2 || legacy.stdout != "" || !strings.Contains(legacy.stderr, "--status") || len(acceptanceCLIMutations(process)) != beforeLegacy {
			t.Fatal("installed legacy status option was not rejected before a mutation")
		}
		beforeProperties := cli.task(t, editable)
		cli.run(t, cli.repo, append([]string{"task", "update", editable}, pairs...)...)
		replaced := cli.task(t, editable)
		if replaced.Version != beforeProperties.Version+1 || !reflect.DeepEqual(replaced.Properties, references) || !slices.Equal(replaced.DependsOn, beforeProperties.DependsOn) || replaced.Title != beforeProperties.Title {
			t.Fatal("installed property-only update did not replace the list in one version")
		}
		cli.run(t, cli.repo, append([]string{"task", "update", editable, "--if-version", strconv.FormatInt(replaced.Version, 10)}, pairs...)...)
		if task := cli.task(t, editable); !reflect.DeepEqual(task, replaced) {
			t.Fatal("installed identical PR update changed the task version, time or data")
		}
		cli.refuse(t, process, "version_conflict", editable, "task", "update", editable, "--clear-pull-requests", "--if-version", strconv.FormatInt(beforeProperties.Version, 10))
		if task := cli.task(t, editable); !reflect.DeepEqual(task, replaced) {
			t.Fatal("installed stale PR clear changed the persisted task")
		}
		cli.run(t, cli.repo, "task", "update", editable, "--description", "Keep PR references")
		preserved := cli.task(t, editable)
		if !reflect.DeepEqual(preserved.Properties, references) || preserved.Version != replaced.Version+1 {
			t.Fatal("installed update without PR options discarded properties")
		}
		cli.run(t, cli.caller, "task", "update", editable, "--project", projectID, "--if-version", strconv.FormatInt(preserved.Version, 10), "--clear-pull-requests")
		cleared := cli.task(t, editable)
		if cleared.Properties.PullRequests == nil || len(cleared.Properties.PullRequests) != 0 || cleared.Version != preserved.Version+1 || cleared.Description != preserved.Description {
			t.Fatal("installed explicit-version PR clear changed other fields or lost the empty list")
		}
		cli.run(t, cli.repo, "task", "update", editable, "--clear-pull-requests")
		if task := cli.task(t, editable); !reflect.DeepEqual(task, cleared) {
			t.Fatal("installed empty PR clear changed the task version, time or data")
		}
		fixture.exec(t, "UPDATE tasks SET version=$1 WHERE id=$2", int64(9_007_199_254_740_993), editable)
		cli.run(t, cli.caller, "task", "update", editable, "--project", projectID, "--if-version", "9007199254740993", "--title", "Exact version 中文")
		cli.run(t, cli.repo, "task", "update", editable, "--title", "Read exact version")
		if task := cli.task(t, editable); task.Version != 9_007_199_254_740_995 {
			t.Fatal("installed CLI rounded an explicit or read Go int64 version")
		}
		exactProject := process.project(t, "Exact lifecycle versions")
		fixture.exec(t, "UPDATE projects SET settings_version=$1 WHERE id=$2", int64(9_007_199_254_740_992), exactProject.ID)
		exactProject.Settings.Version = 9_007_199_254_740_992
		exactProject = acceptanceSettingsSave(t, process, exactProject, 135)
		if exactProject.Settings.Version != 9_007_199_254_740_993 {
			t.Fatal("real settings save did not retain its exact int64 result")
		}
		if read := acceptanceCLIProjectResource(t, cli.run(t, cli.caller, "project", "show", exactProject.ID, "--json")); !reflect.DeepEqual(read, exactProject) {
			t.Fatal("installed project show rounded the nested settings version above the safe integer range")
		}
		foundExactSettings := false
		for _, read := range acceptanceCLIProjectsResource(t, cli.run(t, cli.caller, "project", "list", "--json")) {
			if read.ID == exactProject.ID {
				foundExactSettings = true
				if !reflect.DeepEqual(read, exactProject) {
					t.Fatal("installed project list rounded or changed the nested settings version")
				}
			}
		}
		if !foundExactSettings {
			t.Fatal("installed project list omitted the project with an exact nested settings version")
		}
		exact := process.task(t, exactProject, "Exact lifecycle")
		exactGraph := acceptanceCLIGraphResource(t, cli.run(t, cli.caller, "task", "graph", exact.ID, "--project", exactProject.ID, "--json"))
		if !reflect.DeepEqual(exactGraph.Project, exactProject) {
			t.Fatal("installed graph rounded the nested project settings version")
		}
		fixture.exec(t, "UPDATE tasks SET version=$1 WHERE id=$2", int64(9_007_199_254_740_993), exact.ID)
		cli.run(t, cli.caller, "task", "set-status", exact.ID, "todo", "--project", exactProject.ID, "--if-version", "9007199254740993")
		cli.run(t, cli.caller, "task", "set-status", exact.ID, "in_progress", "--project", exactProject.ID)
		exact = acceptanceCLITaskResource(t, cli.run(t, cli.caller, "task", "show", exact.ID, "--project", exactProject.ID, "--json"))
		if exact.Version != 9_007_199_254_740_994 || exact.Status != "in_progress" {
			t.Fatal("installed lifecycle commands rounded an explicit or read Go int64 version")
		}
		fixture.exec(t, "UPDATE tasks SET version=$1 WHERE id=$2", int64(9_223_372_036_854_775_806), exact.ID)
		cli.run(t, cli.caller, "task", "set-status", exact.ID, "done", "--project", exactProject.ID, "--if-version", "9223372036854775806")
		exact = acceptanceCLITaskResource(t, cli.run(t, cli.caller, "task", "show", exact.ID, "--project", exactProject.ID, "--json"))
		if exact.Version != 9_223_372_036_854_775_807 || exact.Status != "done" {
			t.Fatal("installed completion did not retain the exact int64 maximum result")
		}
		cli.run(t, cli.caller, "task", "set-status", exact.ID, "done", "--project", exactProject.ID, "--if-version", "9223372036854775807")
		if confirmed := acceptanceCLITaskResource(t, cli.run(t, cli.caller, "task", "show", exact.ID, "--project", exactProject.ID, "--json")); !reflect.DeepEqual(confirmed, exact) {
			t.Fatal("installed exact maximum same-status confirmation changed the task")
		}
		cli.git(t, "-C", cli.repo, "remote", "set-url", "origin", "ssh://git@GIT.EXAMPLE:22/Org/Repo.git")
		duplicate := acceptanceDecode[api.Project](t, process.request(context.Background(), http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: "Later duplicate", RepoURL: "https://git.example/Org/Repo"}, ""), http.StatusCreated)
		if duplicate.ID == projectID {
			t.Fatal("server duplicate fixture reused the original project")
		}
		if task := cli.task(t, editable); task.ProjectID != projectID {
			t.Fatal("equivalent origin or later duplicate changed a validated binding")
		}
		if after, err := os.ReadFile(bindingPath); err != nil || !bytes.Equal(after, binding) {
			t.Fatal("explicit project or equivalent origin rewrote the repository association")
		}
		beforeMutations := len(acceptanceCLIMutations(process))
		version := strconv.FormatInt(cli.task(t, editable).Version, 10)
		barrier := fixture.projectLock(t, projectID)
		left := cli.start(t, cli.caller, "task", "update", editable, "--project", projectID, "--if-version", version, "--title", "Concurrent left")
		right := cli.start(t, cli.caller, "task", "update", editable, "--project", projectID, "--if-version", version, "--title", "Concurrent right")
		fixture.waitWriters(t, process, 2)
		acceptanceRelease(t, barrier)
		results := []acceptanceCLIResult{acceptanceCLIReceive(t, left), acceptanceCLIReceive(t, right)}
		requests := acceptanceCLIWaitMutations(t, process, beforeMutations+2)
		if len(requests) != beforeMutations+2 {
			t.Fatal("installed concurrent writers retried a mutation")
		}
		requests = requests[beforeMutations:]
		winners, conflicts := 0, 0
		for _, result := range results {
			if result.status == 0 && result.stderr == "" {
				winners++
				continue
			}
			if result.status == 1 && result.stdout == "" && strings.Contains(result.stderr, "version_conflict") && strings.Contains(result.stderr, editable) {
				conflicts++
				matched := false
				for _, request := range requests {
					if request.Status == 409 && request.RequestID != "" && strings.Contains(result.stderr, "requestId="+request.RequestID) {
						matched = true
					}
				}
				if !matched {
					t.Fatal("installed CLI version conflict lost its server request identity")
				}
				continue
			}
			t.Fatalf("unexpected installed CLI concurrent writer result: %+v", result)
		}
		if winners != 1 || conflicts != 1 || requests[0].RequestID == requests[1].RequestID {
			t.Fatal("installed CLI concurrent same-version writers did not yield one success and one conflict")
		}
		statuses := []int{requests[0].Status, requests[1].Status}
		slices.Sort(statuses)
		if !slices.Equal(statuses, []int{200, 409}) {
			t.Fatal("concurrent installed CLI requests lost their exact HTTP statuses")
		}
		if err := binaryAcceptance.update(func() { scenario.ConcurrentCLIRequests = requests }); err != nil {
			t.Fatal("cannot persist concurrent installed CLI requests")
		}
		before := cli.task(t, editable)
		if before.Version != 9_007_199_254_740_996 || before.Title != "Concurrent left" && before.Title != "Concurrent right" {
			t.Fatal("concurrent installed CLI writers persisted an unexpected version or title")
		}
		firstWithPR := cli.task(t, first)
		if !reflect.DeepEqual(firstWithPR.StartedAt, firstCompleted.StartedAt) || !reflect.DeepEqual(firstWithPR.CompletedAt, firstCompleted.CompletedAt) {
			t.Fatal("completed execution timing changed while unrelated work continued")
		}
		if !reflect.DeepEqual(firstWithPR.Properties, references) {
			t.Fatal("installed lifecycle actions discarded the created PR list")
		}
		references.PullRequests = append(references.PullRequests, api.PullRequestProperty{URL: "\x00 arbitrary\tURL", Title: "标题\x00\n"})
		firstWithPR = acceptanceDecode[api.Task](t, process.request(context.Background(), http.MethodPatch, acceptanceTaskPath(firstWithPR), map[string]any{"version": firstWithPR.Version, "properties": api.TaskWritableProperties{PullRequests: references.PullRequests}}, "installed-raw-pr-readback"), http.StatusOK)
		if task := cli.task(t, first); !reflect.DeepEqual(task, firstWithPR) {
			t.Fatal("installed CLI JSON did not preserve HTTP-supplied NUL PR strings")
		}
		escapedPR := "4. Title: 标题\\u0000\\n\n     URL: \\u0000 arbitrary\\tURL"
		detail := cli.run(t, cli.repo, "task", "show", first)
		for _, field := range []string{escapedPR, "Description: " + firstWithPR.Description, "Version: " + strconv.FormatInt(firstWithPR.Version, 10), "Created: " + firstWithPR.CreatedAt.Format(time.RFC3339Nano), "Updated: " + firstWithPR.UpdatedAt.Format(time.RFC3339Nano)} {
			if !strings.Contains(detail, field) {
				t.Fatal("installed full-resource text output lost details or escaped PR control characters")
			}
		}
		if strings.ContainsAny(detail, "\x00\x1b") {
			t.Fatal("installed full-resource text output emitted raw PR terminal controls")
		}
		readyTodoID, blockedTodoID := "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"
		fixture.exec(t, `INSERT INTO tasks (id, project_id, title, description, status, version)
			VALUES ($1, $3, 'Ready todo task', 'Persistent todo description', 'todo', 17),
			($2, $3, 'Blocked todo task', '', 'todo', 19)`, readyTodoID, blockedTodoID, projectID)
		fixture.exec(t, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id)
			VALUES ($1, $2, $3)`, projectID, blockedTodoID, second)
		todoFixture, blockedTodo := cli.task(t, readyTodoID), cli.task(t, blockedTodoID)
		if todoFixture.Status != "todo" || !todoFixture.Ready || todoFixture.Version != 17 || todoFixture.Description != "Persistent todo description" ||
			len(todoFixture.BlockedBy) != 0 || blockedTodo.Status != "todo" || blockedTodo.Ready ||
			!slices.Equal(blockedTodo.BlockedBy, []string{second}) {
			t.Fatal("installed CLI show lost todo detail or prerequisite projection")
		}
		acceptanceCLITaskListJSON(t, cli.run(t, cli.repo, "task", "list", "--status", "todo", "--json"), []api.Task{cli.task(t, second), before, todoFixture, blockedTodo})
		todoDetail := cli.run(t, cli.repo, "task", "show", readyTodoID)
		for _, field := range []string{"Status: todo\n", "Ready: true\n", "Description: " + todoFixture.Description + "\n", "Version: 17\n"} {
			if !strings.Contains(todoDetail, field) {
				t.Fatal("installed CLI text detail lost todo status or full description")
			}
		}
		unfinished := []api.Task{cli.task(t, second), before, todoFixture, blockedTodo}
		for _, listing := range []struct {
			arguments []string
			expected  []api.Task
		}{
			{[]string{"task", "list"}, unfinished},
			{[]string{"task", "list", "--all"}, append(slices.Clone(unfinished), firstWithPR, cli.task(t, target))},
		} {
			acceptanceCLITaskListJSON(t, cli.run(t, cli.repo, append(slices.Clone(listing.arguments), "--json")...), listing.expected)
			output := cli.run(t, cli.repo, listing.arguments...)
			var listedIDs, expectedIDs []string
			for _, line := range strings.Split(output, "\n") {
				if id, found := strings.CutPrefix(line, "ID: "); found {
					listedIDs = append(listedIDs, id)
				}
			}
			for _, task := range listing.expected {
				expectedIDs = append(expectedIDs, task.ID)
				if !strings.Contains(output, "ID: "+task.ID+"\nProject: "+task.ProjectID+"\nTitle: "+task.Title+"\n") {
					t.Fatal("installed compact task list lost task identity fields")
				}
			}
			if !slices.Equal(listedIDs, expectedIDs) {
				t.Fatal("installed compact task list changed the selected task membership or order")
			}
			for _, field := range []string{"Description:", "Version:", "Created:", "Updated:"} {
				if strings.Contains(output, field) {
					t.Fatal("installed compact task list included full-resource detail fields")
				}
			}
			for _, field := range []string{"Pull requests: 0\n", "Status: todo\n", "Ready: true\nDepends on: none\nExternal dependencies (0): none\nBlocked by: none\n"} {
				if !strings.Contains(output, field) {
					t.Fatal("installed compact task list lost task status, PR or dependency fields")
				}
			}
			if slices.Contains(listing.arguments, "--all") && (!strings.Contains(output, escapedPR) || !strings.Contains(output, "Status: done\n") || !strings.Contains(output, "Depends on: "+first+"\n")) {
				t.Fatal("installed all-status compact task list lost completed tasks, dependencies or escaped PR strings")
			}
			if strings.ContainsAny(output, "\x00\x1b") {
				t.Fatal("installed compact task list emitted raw PR terminal controls")
			}
		}
		graph := acceptanceCLIGraphResource(t, cli.run(t, cli.repo, "task", "graph", blockedTodoID, "--json"))
		expectedGraph := acceptanceDecode[api.TaskGraph](t, process.request(context.Background(), http.MethodGet, "/api/v1/projects/"+projectID+"/task-graph?taskId="+blockedTodoID, nil, ""), http.StatusOK)
		if !expectedGraph.ObservedAt.After(graph.ObservedAt) {
			t.Fatal("separate real graph reads did not advance the database clock sample")
		}
		expectedGraph.ObservedAt = graph.ObservedAt
		if !reflect.DeepEqual(graph, expectedGraph) {
			t.Fatal("installed CLI graph omitted or changed server response fields")
		}
		if graph.Project.ID != projectID || graph.Summary.Total != 2 || graph.Summary.Done != 0 || graph.Summary.Todo != 2 || graph.Summary.Ready != 1 || graph.Summary.Blocked != 1 || len(graph.Tasks) != 2 {
			t.Fatal("installed CLI graph lost the selected chain summary or tasks")
		}
		graphText := cli.run(t, cli.repo, "task", "graph", blockedTodoID)
		if !strings.Contains(graphText, "Todo: 2\n") || strings.Contains(graphText, "Proposed:") || strings.Contains(graphText, readyTodoID) || !strings.Contains(graphText, second) || !strings.Contains(graphText, blockedTodoID) {
			t.Fatal("installed CLI graph text lost todo count or tasks")
		}
		if strings.Contains(cli.run(t, cli.repo, "task", "graph", blockedTodoID, "--json"), `"properties"`) {
			t.Fatal("installed graph included full-resource properties")
		}
		var dependencies []map[string]json.RawMessage
		if err := json.Unmarshal([]byte(cli.run(t, cli.repo, "task", "graph", blockedTodoID, "--depends-only", "--json")), &dependencies); err != nil {
			t.Fatal(err)
		}
		if len(dependencies) != 2 {
			t.Fatalf("installed dependency audit changed chain membership: %#v", dependencies)
		}
		for index, row := range dependencies {
			if len(row) != 3 || row["id"] == nil || row["dependsOn"] == nil || row["externalDependsOn"] == nil {
				t.Fatalf("installed dependency audit leaked fields: %#v", row)
			}
			var id string
			var depends, external []string
			if json.Unmarshal(row["id"], &id) != nil || json.Unmarshal(row["dependsOn"], &depends) != nil || json.Unmarshal(row["externalDependsOn"], &external) != nil || id != graph.Tasks[index].ID || !slices.Equal(depends, graph.Tasks[index].DependsOn) || !slices.Equal(external, graph.Tasks[index].ExternalDependsOn) {
				t.Fatalf("installed audit changed raw dependencies: %#v", row)
			}
		}
		auditText := cli.run(t, cli.repo, "task", "graph", blockedTodoID, "--depends-only")
		for _, line := range strings.Split(strings.TrimSpace(auditText), "\n") {
			if line != "" && !strings.HasPrefix(line, "ID: ") && !strings.HasPrefix(line, "Depends on: ") && !strings.HasPrefix(line, "External dependencies: ") {
				t.Fatalf("installed text audit leaked fields: %s", auditText)
			}
		}
		completedGraph := acceptanceCLIGraphResource(t, cli.run(t, cli.repo, "task", "graph", target, "--json"))
		if completedGraph.Summary != (api.TaskGraphSummary{Total: 2, Done: 2}) || len(completedGraph.Tasks) != 2 {
			t.Fatal("installed graph omitted completed chain members")
		}

		acceptanceCLITaskChainGraph(t, cli, process)
		acceptanceCLIAllowAgents(t, cli, process)
		firstBefore, targetBefore := cli.task(t, first), cli.task(t, target)
		process.signal(t)
		process.stopped(t, 0)
		restarted := fixture.launch(t, map[string]string{"DAYNIGHT_LISTEN_ADDR": process.address}).started(t)
		if restarted.address != process.address {
			t.Fatal("restarted real service did not reuse its released address")
		}
		if !reflect.DeepEqual(cli.task(t, readyTodoID), todoFixture) || !reflect.DeepEqual(cli.task(t, blockedTodoID), blockedTodo) {
			t.Fatal("installed CLI todo tasks changed across actual process restart")
		}
		if after := acceptanceCLITaskResource(t, cli.run(t, cli.caller, "task", "show", exact.ID, "--project", exactProject.ID, "--json")); !reflect.DeepEqual(after, exact) {
			t.Fatal("installed exact int64 lifecycle result changed across restart")
		}
		if after := cli.task(t, editable); !reflect.DeepEqual(after, before) {
			t.Fatal("installed CLI task data did not persist across actual process restart")
		}
		if after := cli.task(t, first); !reflect.DeepEqual(after, firstBefore) || after.Description != "Persistent description" {
			t.Fatal("installed CLI prerequisite description did not persist across restart")
		}
		if after := cli.task(t, target); !reflect.DeepEqual(after, targetBefore) || !slices.Equal(after.DependsOn, []string{first}) {
			t.Fatal("installed CLI completed dependency did not persist across restart")
		}
		if after := acceptanceCLIProjectResource(t, cli.run(t, cli.caller, "project", "show", projectID, "--json")); !reflect.DeepEqual(after, project) {
			t.Fatal("installed CLI project did not persist across actual process restart")
		}
		if after := acceptanceCLIProjectResource(t, cli.run(t, cli.caller, "project", "show", exactProject.ID, "--json")); !reflect.DeepEqual(after, exactProject) {
			t.Fatal("exact nested project settings did not persist across actual process restart")
		}
		if after := acceptanceCLIGraphResource(t, cli.run(t, cli.caller, "task", "graph", exact.ID, "--project", exactProject.ID, "--json")); !reflect.DeepEqual(after.Project, exactProject) {
			t.Fatal("restarted installed graph lost exact nested project settings")
		}
		afterGraph := acceptanceCLIGraphResource(t, cli.run(t, cli.repo, "task", "graph", blockedTodoID, "--json"))
		if !afterGraph.ObservedAt.After(graph.ObservedAt) {
			t.Fatal("restarted service did not supply a fresh database clock sample")
		}
		afterGraph.ObservedAt = graph.ObservedAt
		if !reflect.DeepEqual(afterGraph, graph) {
			t.Fatal("installed CLI complete graph changed across actual process restart")
		}
		restarted.signal(t)
		restarted.stopped(t, 0)
	})
}
