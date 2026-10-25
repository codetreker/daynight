package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
)

type identityCLIReceipt struct {
	SchemaVersion  int    `json:"schemaVersion"`
	Root           string `json:"root"`
	PackageVersion string `json:"packageVersion"`
	TarballPath    string `json:"tarballPath"`
	TarballSHA256  string `json:"tarballSha256"`
	NodePath       string `json:"nodePath"`
	EntryPath      string `json:"entryPath"`
	EntrySHA256    string `json:"entrySha256"`
}

func identityPathWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != "." && relative != ".." && !filepath.IsAbs(relative) && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func identityInstalledReceipt(t *testing.T) identityCLIReceipt {
	t.Helper()
	path := os.Getenv("DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT")
	if path == "" {
		t.Fatal("DAYNIGHT_TEST_INSTALLED_CLI_RECEIPT is required for installed authentication acceptance; run scripts/check.sh")
	}
	data, err := os.ReadFile(path)
	var receipt identityCLIReceipt
	if err != nil || json.Unmarshal(data, &receipt) != nil || receipt.SchemaVersion != 1 || receipt.PackageVersion == "" {
		t.Fatal("cannot read a valid installed CLI receipt")
	}
	projectTemporary, err := filepath.Abs(filepath.Join("..", "..", "..", "..", ".tmp"))
	if err != nil {
		t.Fatal("cannot locate project temporary directory")
	}
	projectTemporary, err = filepath.EvalSymlinks(projectTemporary)
	if err != nil {
		t.Fatal("cannot resolve project temporary directory")
	}
	root, err := filepath.EvalSymlinks(receipt.Root)
	if err != nil || !filepath.IsAbs(receipt.Root) || !identityPathWithin(projectTemporary, root) {
		t.Fatal("installed CLI fixture must belong to the project temporary directory")
	}
	for _, artifact := range []struct{ path, hash string }{{receipt.EntryPath, receipt.EntrySHA256}, {receipt.TarballPath, receipt.TarballSHA256}} {
		actual, err := filepath.EvalSymlinks(artifact.path)
		if err != nil || !filepath.IsAbs(artifact.path) || !identityPathWithin(root, actual) {
			t.Fatal("installed CLI artifact is outside its receipt root")
		}
		info, err := os.Stat(actual)
		if err != nil || !info.Mode().IsRegular() {
			t.Fatal("installed CLI artifact is not a regular file")
		}
		content, err := os.ReadFile(actual)
		digest := sha256.Sum256(content)
		if err != nil || hex.EncodeToString(digest[:]) != artifact.hash {
			t.Fatal("installed CLI artifact differs from its receipt hash")
		}
	}
	info, err := os.Stat(receipt.NodePath)
	if err != nil || !filepath.IsAbs(receipt.NodePath) || !info.Mode().IsRegular() {
		t.Fatal("installed CLI Node executable is unavailable")
	}
	manifestData, err := os.ReadFile(filepath.Join(filepath.Dir(filepath.Dir(receipt.EntryPath)), "package.json"))
	var manifest struct{ Name, Version string }
	if err != nil || json.Unmarshal(manifestData, &manifest) != nil || manifest.Name != "@codetreker/daynight" || manifest.Version != receipt.PackageVersion {
		t.Fatal("installed CLI package differs from its receipt")
	}
	sourceData, err := os.ReadFile(filepath.Join("..", "..", "..", "daynight", "package.json"))
	var source struct{ Version string }
	if err != nil || json.Unmarshal(sourceData, &source) != nil || source.Version != receipt.PackageVersion {
		t.Fatal("installed CLI version differs from the source package")
	}
	return receipt
}

type identityCLIOutput struct{ buffer bytes.Buffer }

func (output *identityCLIOutput) Write(value []byte) (int, error) {
	if output.buffer.Len()+len(value) > 1<<20 {
		return 0, errors.New("installed authentication CLI output exceeded its capture bound")
	}
	return output.buffer.Write(value)
}

type identityInstalledCLI struct {
	receipt identityCLIReceipt
	root    string
	home    string
	secret  string
}

func newIdentityInstalledCLI(t *testing.T, receipt identityCLIReceipt, secret string) *identityInstalledCLI {
	t.Helper()
	root := testauth.Directory(t)
	home := filepath.Join(root, "home")
	if err := os.Mkdir(home, 0o700); err != nil {
		t.Fatal("create isolated installed CLI home failed")
	}
	return &identityInstalledCLI{receipt: receipt, root: root, home: home, secret: secret}
}

func (cli *identityInstalledCLI) environment() []string {
	values := map[string]string{
		"HOME": cli.home, "USERPROFILE": cli.home, "XDG_CONFIG_HOME": filepath.Join(cli.home, "config"),
		"XDG_CACHE_HOME": filepath.Join(cli.home, "cache"), "APPDATA": filepath.Join(cli.home, "AppData", "Roaming"),
		"LOCALAPPDATA": filepath.Join(cli.home, "AppData", "Local"), "NO_COLOR": "1", "GIT_CONFIG_NOSYSTEM": "1",
		"GIT_CONFIG_GLOBAL": filepath.Join(cli.root, "gitconfig"), "GIT_TERMINAL_PROMPT": "0",
	}
	var environment []string
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		upper := strings.ToUpper(key)
		_, replaced := values[upper]
		if !replaced && !strings.HasPrefix(upper, "DAYNIGHT_") && !strings.HasPrefix(upper, "GIT_") && !strings.HasPrefix(upper, "GH_") && !strings.HasPrefix(upper, "GITHUB_") && !strings.HasPrefix(upper, "COPILOT_") && upper != "NODE_OPTIONS" {
			environment = append(environment, entry)
		}
	}
	for key, value := range values {
		environment = append(environment, key+"="+value)
	}
	return environment
}

func (cli *identityInstalledCLI) run(t *testing.T, input string, success bool, arguments ...string) (string, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, cli.receipt.NodePath, append([]string{cli.receipt.EntryPath}, arguments...)...)
	command.Dir, command.Env, command.WaitDelay = cli.root, cli.environment(), time.Second
	command.Stdin = strings.NewReader(input)
	stdout, stderr := &identityCLIOutput{}, &identityCLIOutput{}
	command.Stdout, command.Stderr = stdout, stderr
	err := command.Run()
	if ctx.Err() != nil {
		t.Fatal("installed authentication CLI exceeded its execution deadline")
	}
	if cli.secret != "" && (bytes.Contains(stdout.buffer.Bytes(), []byte(cli.secret)) || bytes.Contains(stderr.buffer.Bytes(), []byte(cli.secret))) {
		t.Fatal("installed CLI exposed its personal access token")
	}
	var exit *exec.ExitError
	if err != nil && !errors.As(err, &exit) {
		t.Fatal("installed authentication CLI process failed")
	}
	if success != (err == nil) {
		t.Fatalf("installed authentication CLI returned an unexpected success state for %s", arguments[0])
	}
	return stdout.buffer.String(), stderr.buffer.String()
}

type identityCLIRequests struct {
	all, bearer, anonymous, authenticatedPAT, unauthorized atomic.Int64
}

func publishIdentityBudgetPAT(t *testing.T, receipt identityCLIReceipt, token string) {
	t.Helper()
	path := os.Getenv("DAYNIGHT_TEST_CLI_BUDGET_TOKEN_FILE")
	if path == "" {
		return
	}
	if !filepath.IsAbs(path) || !identityPathWithin(receipt.Root, path) {
		t.Fatal("budget token handoff must belong to its installed fixture")
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatal("create private budget token handoff failed")
	}
	err = json.NewEncoder(file).Encode(struct {
		ServerToken string `json:"serverToken"`
	}{ServerToken: token})
	if err = errors.Join(err, file.Close()); err != nil {
		if removeErr := os.Remove(path); removeErr != nil {
			t.Error("remove incomplete budget token handoff failed")
		}
		t.Fatal("persist private budget token handoff failed")
	}
}

func TestAuthenticationInstalledCLIUsesPersonalAccessToken(t *testing.T) {
	receipt := identityInstalledReceipt(t)
	integration := newIdentityIntegration(t)
	requests := integration.requests
	aliceBrowser, bobBrowser := identityBrowser(t), identityBrowser(t)
	integration.login(t, aliceBrowser, "alice")
	integration.login(t, bobBrowser, "bob")
	origin := map[string]string{"Origin": integration.server.URL}
	repository := "https://example.test/auth-cli/shared.git"
	_, data := identityRequest(t, bobBrowser, http.MethodPost, integration.server.URL+"/api/v1/projects", `{"name":"Bob private project","repoUrl":"`+repository+`"}`, origin, http.StatusCreated)
	bobProject := identityDecode[api.Project](t, data)
	_, data = identityRequest(t, aliceBrowser, http.MethodPost, integration.server.URL+"/api/v1/me/tokens", `{"name":"Installed CLI acceptance","days":1}`, origin, http.StatusCreated)
	token := identityDecode[api.CreatedPersonalAccessToken](t, data)
	if token.ID == "" || !strings.HasPrefix(token.Token, "dnpat_") {
		t.Fatal("real browser session did not mint a personal access token")
	}
	publishIdentityBudgetPAT(t, receipt, token.Token)
	integration.secrets = append(integration.secrets, token.Token)
	cli := newIdentityInstalledCLI(t, receipt, token.Token)
	stdout, _ := cli.run(t, token.Token+"\n", true, "setup", "--server-url", integration.server.URL, "--server-token-stdin")
	if stdout != "" {
		t.Fatal("installed setup must keep stdout empty")
	}
	config := filepath.Join(cli.home, ".daynight", "config.yml")
	info, err := os.Stat(config)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		t.Fatal("installed setup did not preserve its token in a private regular configuration file")
	}
	configuration, err := os.ReadFile(config)
	if err != nil || !bytes.Contains(configuration, []byte(token.Token)) {
		t.Fatal("installed setup did not save the token provided through stdin")
	}
	before := requests.all.Load()
	beforePAT := requests.authenticatedPAT.Load()
	stdout, _ = cli.run(t, "", true, "project", "create", "Installed PAT project", "--repo", repository)
	if !strings.HasPrefix(stdout, "Project created.\n") || !strings.Contains(stdout, "Name: Installed PAT project\n") || !strings.Contains(stdout, "Repository: "+repository+"\n") {
		t.Fatal("installed project create did not preserve its documented command output")
	}
	if requests.all.Load() != before+2 || requests.authenticatedPAT.Load() != beforePAT+2 {
		t.Fatal("installed project create must authenticate both duplicate lookup and creation with its PAT")
	}
	createdOutput := stdout
	stdout, _ = cli.run(t, "", true, "project", "list", "--json")
	projects := identityDecode[[]api.Project](t, []byte(stdout))
	if len(projects) != 1 || projects[0].ID == "" || projects[0].ID == bobProject.ID || projects[0].Name != "Installed PAT project" || projects[0].RepoURL != repository || !strings.Contains(createdOutput, "ID: "+projects[0].ID+"\n") {
		t.Fatal("installed JSON project list did not preserve the authenticated user's accessible project scope")
	}
	_, data = identityRequest(t, bobBrowser, http.MethodGet, integration.server.URL+"/api/v1/projects", "", nil, http.StatusOK)
	bobPage := identityDecode[api.ProjectPage](t, data)
	if len(bobPage.Items) != 1 || bobPage.Items[0].ID != bobProject.ID {
		t.Fatal("installed CLI creation changed another user's private project scope")
	}
	identityRequest(t, aliceBrowser, http.MethodDelete, integration.server.URL+"/api/v1/me/tokens/"+token.ID, "", origin, http.StatusNoContent)
	before, anonymous, bearer := requests.all.Load(), requests.anonymous.Load(), requests.bearer.Load()
	unauthorized := requests.unauthorized.Load()
	stdout, stderr := cli.run(t, "", false, "project", "list", "--json")
	if stdout != "" || !strings.Contains(stderr, "unauthenticated:") || !strings.Contains(stderr, "daynight login") {
		t.Fatalf("revoked PAT failure: stdoutEmpty=%t unauthenticatedCode=%t loginGuidance=%t", stdout == "", strings.Contains(stderr, "unauthenticated:"), strings.Contains(stderr, "daynight login"))
	}
	if requests.all.Load() != before+1 || requests.bearer.Load() != bearer+1 || requests.anonymous.Load() != anonymous || requests.unauthorized.Load() != unauthorized+1 {
		t.Fatal("revoked PAT must cause exactly one HTTP 401 bearer request with no anonymous retry")
	}
	unauthenticated := newIdentityInstalledCLI(t, receipt, token.Token)
	unauthenticated.run(t, "", true, "setup", "--server-url", integration.server.URL)
	before, anonymous = requests.all.Load(), requests.anonymous.Load()
	unauthorized = requests.unauthorized.Load()
	stdout, stderr = unauthenticated.run(t, "", false, "project", "list", "--json")
	if stdout != "" || !strings.Contains(stderr, "daynight login") || requests.all.Load() != before || requests.anonymous.Load() != anonymous || requests.unauthorized.Load() != unauthorized {
		t.Fatal("missing token must provide installed CLI login guidance before dispatching a request")
	}
	for _, secret := range integration.secrets {
		if secret != "" && integration.logs.contains(secret) {
			t.Fatal("actual Go authentication handlers logged an OAuth or personal credential")
		}
	}
}
