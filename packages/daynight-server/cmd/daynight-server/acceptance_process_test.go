package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type acceptanceEvidence struct {
	mu           sync.Mutex
	path         string
	Binary       string                `json:"-"`
	GitSHA       string                `json:"gitSha"`
	GitTreeSHA   string                `json:"gitTreeSha"`
	GitHubSHA    string                `json:"githubSha,omitempty"`
	Dirty        bool                  `json:"dirty"`
	GoVersion    string                `json:"goVersion"`
	PostgreSQL   string                `json:"postgresqlVersion"`
	BinarySHA256 string                `json:"binarySha256"`
	Build        string                `json:"build"`
	Result       string                `json:"result"`
	Scenarios    []*acceptanceScenario `json:"scenarios"`
	InstalledCLI *acceptanceCLIReceipt `json:"installedCli,omitempty"`
}

type acceptanceScenario struct {
	Name                   string                         `json:"name"`
	Requirements           []string                       `json:"requirements"`
	Result                 string                         `json:"result"`
	DurationMS             int64                          `json:"durationMs"`
	ProcessesStarted       int                            `json:"processesStarted"`
	ProcessesReaped        int                            `json:"processesReaped"`
	CLIProcessesStarted    int                            `json:"cliProcessesStarted,omitempty"`
	CLIProcessesReaped     int                            `json:"cliProcessesReaped,omitempty"`
	CLIWorkspaceRemoved    bool                           `json:"cliWorkspaceRemoved,omitempty"`
	CLIRefusalRequestIDs   []string                       `json:"cliRefusalRequestIds,omitempty"`
	ConcurrentCLIRequests  []acceptanceCLIRequest         `json:"concurrentCliRequests,omitempty"`
	SchemasRemoved         int                            `json:"schemasRemoved"`
	SessionsRemoved        bool                           `json:"sessionsRemoved"`
	StorageRootRemoved     bool                           `json:"storageRootRemoved"`
	AttachmentFiles        []acceptanceAttachmentEvidence `json:"attachmentFiles,omitempty"`
	AttachmentsListed      int                            `json:"attachmentsListed,omitempty"`
	AttachmentPageRequests int                            `json:"attachmentPageRequests,omitempty"`
	Cleanup                string                         `json:"cleanup"`
	Lifecycle              *acceptanceLifecycleEvidence   `json:"lifecycle,omitempty"`
}

var binaryAcceptance *acceptanceEvidence

var acceptanceSlots = make(chan struct{}, 4)

func (e *acceptanceEvidence) update(change func()) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	change()
	data, err := json.MarshalIndent(e, "", "  ")
	if err != nil {
		return err
	}
	temporary := e.path + ".new"
	if err := os.WriteFile(temporary, append(data, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, e.path)
}

func TestMain(m *testing.M) {
	moduleRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		fmt.Fprintln(os.Stderr, "acceptance: cannot resolve module directory")
		os.Exit(1)
	}
	temporary := filepath.Join(moduleRoot, ".tmp")
	if err := os.MkdirAll(temporary, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "acceptance: cannot create evidence directory")
		os.Exit(1)
	}
	binaryAcceptance = &acceptanceEvidence{path: filepath.Join(temporary, "acceptance-evidence.json"), GoVersion: runtime.Version(), Build: "pending", Result: "running", Scenarios: []*acceptanceScenario{}}
	finish := func(code int) {
		result := "passed"
		if code != 0 {
			result = "failed"
		}
		if err := binaryAcceptance.update(func() { binaryAcceptance.Result = result }); err != nil {
			fmt.Fprintln(os.Stderr, "acceptance: cannot persist final evidence")
			code = 1
		}
		os.Exit(code)
	}
	if err := binaryAcceptance.update(func() {}); err != nil {
		fmt.Fprintln(os.Stderr, "acceptance: cannot initialize evidence")
		os.Exit(1)
	}
	git := func(arguments ...string) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		command := exec.CommandContext(ctx, "git", arguments...)
		command.Dir = moduleRoot
		output, err := command.Output()
		return strings.TrimSpace(string(output)), err
	}
	sha, shaErr := git("rev-parse", "HEAD")
	tree, treeErr := git("rev-parse", "HEAD^{tree}")
	status, statusErr := git("status", "--porcelain")
	githubSHA := os.Getenv("GITHUB_SHA")
	if shaErr != nil || treeErr != nil || statusErr != nil || githubSHA != "" && githubSHA != sha || os.Getenv("GITHUB_ACTIONS") == "true" && status != "" {
		_ = binaryAcceptance.update(func() { binaryAcceptance.Build = "source_provenance_failed" })
		fmt.Fprintln(os.Stderr, "acceptance: source provenance does not match the checked-out revision")
		finish(1)
	}
	_ = binaryAcceptance.update(func() {
		binaryAcceptance.GitSHA, binaryAcceptance.GitTreeSHA, binaryAcceptance.GitHubSHA, binaryAcceptance.Dirty = sha, tree, githubSHA, status != ""
	})
	buildDirectory, err := os.MkdirTemp(temporary, "acceptance-build-")
	if err != nil {
		fmt.Fprintln(os.Stderr, "acceptance: cannot create binary directory")
		finish(1)
	}
	binaryAcceptance.Binary = filepath.Join(buildDirectory, "daynight-server")
	if runtime.GOOS == "windows" {
		binaryAcceptance.Binary += ".exe"
	}
	environment := map[string]string{
		"GOCACHE": filepath.Join(temporary, "go-cache"), "GOMODCACHE": filepath.Join(temporary, "go-mod"),
		"GOPATH": filepath.Join(temporary, "go"), "GOBIN": filepath.Join(temporary, "bin"), "TMPDIR": filepath.Join(temporary, "tmp"),
		"XDG_CONFIG_HOME": filepath.Join(temporary, "config"), "XDG_CACHE_HOME": filepath.Join(temporary, "cache"),
		"GOENV": "off", "GOTOOLCHAIN": "go1.27.2",
	}
	for key, value := range environment {
		if key != "GOENV" && key != "GOTOOLCHAIN" {
			if err := os.MkdirAll(value, 0o755); err != nil {
				fmt.Fprintln(os.Stderr, "acceptance: cannot initialize tool directories")
				finish(1)
			}
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	command := exec.CommandContext(ctx, "go", "build", "-race", "-o", binaryAcceptance.Binary, "./cmd/daynight-server")
	command.Dir, command.Env, command.Stdout, command.Stderr = moduleRoot, acceptanceEnvironment(environment), os.Stdout, os.Stderr
	err = command.Run()
	cancel()
	if err != nil {
		_ = os.RemoveAll(buildDirectory)
		_ = binaryAcceptance.update(func() { binaryAcceptance.Build = "failed" })
		fmt.Fprintln(os.Stderr, "acceptance: fresh race-enabled binary build failed")
		finish(1)
	}
	content, err := os.ReadFile(binaryAcceptance.Binary)
	if err != nil {
		fmt.Fprintln(os.Stderr, "acceptance: cannot hash built binary")
		finish(1)
	}
	if err := binaryAcceptance.update(func() {
		binaryAcceptance.BinarySHA256 = fmt.Sprintf("%x", sha256.Sum256(content))
		binaryAcceptance.Build = "passed"
	}); err != nil {
		fmt.Fprintln(os.Stderr, "acceptance: cannot persist build evidence")
		finish(1)
	}
	code := m.Run()
	if err := os.RemoveAll(buildDirectory); err != nil {
		fmt.Fprintln(os.Stderr, "acceptance: cannot remove owned binary directory")
		code = 1
	}
	finish(code)
}

func acceptanceEnvironment(values map[string]string) []string {
	result := make([]string, 0, len(os.Environ())+len(values))
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if _, replaced := values[key]; !replaced && !strings.HasPrefix(key, "DAYNIGHT_") {
			result = append(result, entry)
		}
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	for _, key := range keys {
		result = append(result, key+"="+values[key])
	}
	return result
}

func acceptanceCase(t *testing.T, name string, requirements []string, operation func(*testing.T, *acceptanceScenario)) {
	t.Helper()
	t.Run(name, func(t *testing.T) {
		// Parallel subtests finish before their parent returns, keeping process-wide
		// environment changes in the other top-level tests outside these scenarios.
		t.Parallel()
		acceptanceSlots <- struct{}{}
		t.Cleanup(func() { <-acceptanceSlots })
		started := time.Now()
		scenario := &acceptanceScenario{Name: name, Requirements: requirements, Result: "running", Cleanup: "pending"}
		if err := binaryAcceptance.update(func() { binaryAcceptance.Scenarios = append(binaryAcceptance.Scenarios, scenario) }); err != nil {
			t.Fatal("cannot persist scenario receipt")
		}
		t.Cleanup(func() {
			cleanupPassed := false
			if err := binaryAcceptance.update(func() {
				scenario.DurationMS = time.Since(started).Milliseconds()
				scenario.Result = "passed"
				if t.Failed() {
					scenario.Result = "failed"
				}
				if scenario.ProcessesStarted == scenario.ProcessesReaped && scenario.CLIProcessesStarted == scenario.CLIProcessesReaped && (scenario.CLIProcessesStarted == 0 || scenario.CLIWorkspaceRemoved) && scenario.SchemasRemoved > 0 && scenario.SessionsRemoved && scenario.StorageRootRemoved {
					scenario.Cleanup = "passed"
					cleanupPassed = true
				} else {
					scenario.Cleanup = "failed"
					scenario.Result = "failed"
				}
			}); err != nil {
				t.Error("cannot persist completed scenario receipt")
			}
			if !cleanupPassed {
				t.Error("acceptance scenario did not prove complete resource cleanup")
			}
		})
		operation(t, scenario)
	})
}

type acceptanceFixture struct {
	admin          *pgxpool.Pool
	schema         string
	databaseURL    string
	storageRoot    string
	applications   []string
	scenario       *acceptanceScenario
	serverLifetime time.Duration
}

func newAcceptanceFixture(t *testing.T, scenario *acceptanceScenario) *acceptanceFixture {
	t.Helper()
	base := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if base == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required for built-binary acceptance")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, base)
	if err != nil {
		t.Fatal("cannot configure acceptance database")
	}
	fixture := &acceptanceFixture{schema: "acceptance_" + strings.ToLower(rand.Text()), databaseURL: base, storageRoot: newTestStorageRoot(t), scenario: scenario, serverLifetime: 45 * time.Second}
	t.Cleanup(func() {
		if err := os.RemoveAll(fixture.storageRoot); err != nil {
			t.Error("cannot remove owned acceptance storage root")
			return
		}
		if _, err := os.Stat(fixture.storageRoot); !errors.Is(err, os.ErrNotExist) {
			t.Error("owned acceptance storage root still exists")
			return
		}
		if err := binaryAcceptance.update(func() { scenario.StorageRootRemoved = true }); err != nil {
			t.Error("cannot persist acceptance storage cleanup")
		}
	})
	if _, err := pool.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{fixture.schema}.Sanitize()); err != nil {
		pool.Close()
		t.Fatal("cannot create isolated acceptance schema")
	}
	pool.Close()
	config, err := pgxpool.ParseConfig(base)
	if err != nil {
		t.Fatal("cannot configure isolated acceptance database")
	}
	config.ConnConfig.RuntimeParams["search_path"], config.ConnConfig.RuntimeParams["application_name"] = fixture.schema, fixture.schema+"_admin"
	fixture.admin, err = pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal("cannot open acceptance administration pool")
	}
	var version string
	if err := fixture.admin.QueryRow(ctx, "SHOW server_version").Scan(&version); err != nil {
		t.Fatal("acceptance PostgreSQL is unavailable")
	}
	if err := binaryAcceptance.update(func() { binaryAcceptance.PostgreSQL = version }); err != nil {
		t.Fatal("cannot persist PostgreSQL version")
	}
	t.Cleanup(func() {
		defer fixture.admin.Close()
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := fixture.noSessions(cleanup); err != nil {
			t.Error("owned process database sessions remain after cleanup")
		} else {
			_ = binaryAcceptance.update(func() { scenario.SessionsRemoved = true })
		}
		if _, err := fixture.admin.Exec(cleanup, "DROP SCHEMA "+pgx.Identifier{fixture.schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error("cannot remove owned acceptance schema")
		} else {
			_ = binaryAcceptance.update(func() { scenario.SchemasRemoved++ })
		}
	})
	return fixture
}

func (f *acceptanceFixture) url(t *testing.T, application string) string {
	t.Helper()
	parsed, err := url.Parse(f.databaseURL)
	if err != nil {
		t.Fatal("acceptance database URL is malformed")
	}
	query := parsed.Query()
	query.Set("search_path", f.schema)
	query.Set("timezone", "UTC")
	query.Set("application_name", application)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func (f *acceptanceFixture) noSessions(ctx context.Context) error {
	return acceptanceEventually(ctx, func() (bool, error) {
		var remaining int
		err := f.admin.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE application_name = ANY($1::text[])", f.applications).Scan(&remaining)
		return remaining == 0, err
	})
}

func acceptanceEventually(ctx context.Context, condition func() (bool, error)) error {
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		complete, err := condition()
		if err != nil {
			return err
		}
		if complete {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

type acceptanceLogs struct {
	mu      sync.Mutex
	buffer  bytes.Buffer
	pending []byte
	events  []map[string]any
	invalid bool
	ready   chan string
}

func (l *acceptanceLogs) Write(value []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.buffer.Len()+len(value) > 4<<20 {
		l.invalid = true
		return len(value), nil
	}
	_, _ = l.buffer.Write(value)
	l.pending = append(l.pending, value...)
	for {
		position := bytes.IndexByte(l.pending, '\n')
		if position < 0 {
			break
		}
		line := l.pending[:position]
		l.pending = l.pending[position+1:]
		var event map[string]any
		if err := json.Unmarshal(line, &event); err != nil {
			l.invalid = true
			continue
		}
		l.events = append(l.events, event)
		if event["phase"] == "listening" {
			if address, ok := event["address"].(string); ok {
				select {
				case l.ready <- address:
				default:
				}
			}
		}
	}
	return len(value), nil
}

func (l *acceptanceLogs) matches(fields map[string]any) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, event := range l.events {
		match := true
		for key, expected := range fields {
			if event[key] != expected {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

func (l *acceptanceLogs) safe(t *testing.T, secrets ...string) {
	t.Helper()
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.invalid || len(l.pending) > 0 {
		t.Error("process emitted invalid or incomplete structured logs")
	}
	for _, secret := range secrets {
		if secret != "" && strings.Contains(l.buffer.String(), secret) {
			t.Error("sensitive value entered process logs")
		}
	}
}

type acceptanceProcess struct {
	command       *exec.Cmd
	logs          *acceptanceLogs
	application   string
	address       string
	done          chan struct{}
	err           error
	cancel        context.CancelFunc
	scenario      *acceptanceScenario
	fixture       *acceptanceFixture
	configuration map[string]string
	attempt       int
	origin        string
	token         string
	appSecret     string
	gateway       *testauth.Fixture
}

func (f *acceptanceFixture) launch(t *testing.T, configuration map[string]string) *acceptanceProcess {
	t.Helper()
	application := fmt.Sprintf("%s_%d", f.schema, len(f.applications)+1)
	f.applications = append(f.applications, application)
	address := configuration["DAYNIGHT_LISTEN_ADDR"]
	if address == "" {
		address = acceptanceAddress(t)
	}
	origin := "http://" + address
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	values := map[string]string{
		"DAYNIGHT_DATABASE_URL": f.url(t, application), "DAYNIGHT_STORAGE_ROOT": f.storageRoot,
		"DAYNIGHT_LISTEN_ADDR": address, "DAYNIGHT_STARTUP_TIMEOUT": "5s", "DAYNIGHT_SHUTDOWN_TIMEOUT": "2s",
		"DAYNIGHT_PUBLIC_ORIGIN": origin, "DAYNIGHT_UNIAUTH_URL": gateway.Origin,
		"DAYNIGHT_UNIAUTH_APP_ID": gateway.AppID, "DAYNIGHT_UNIAUTH_APP_SECRET": gateway.AppSecret,
		"DAYNIGHT_UNIAUTH_CALLBACK_URL":   callback,
		"DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN": "1", "DAYNIGHT_ALLOW_LOOPBACK_HTTP": "1",
	}
	for key, value := range configuration {
		values[key] = value
	}
	ctx, cancel := context.WithTimeout(context.Background(), f.serverLifetime)
	process := &acceptanceProcess{logs: &acceptanceLogs{ready: make(chan string, 1)}, application: application, done: make(chan struct{}), cancel: cancel, scenario: f.scenario, fixture: f, configuration: configuration, origin: origin, appSecret: gateway.AppSecret, gateway: gateway}
	process.command = exec.CommandContext(ctx, binaryAcceptance.Binary)
	process.command.Env, process.command.Stdout, process.command.Stderr = acceptanceEnvironment(values), process.logs, process.logs
	process.command.WaitDelay = time.Second
	if err := process.command.Start(); err != nil {
		cancel()
		t.Fatal("cannot start owned acceptance binary")
	}
	if err := binaryAcceptance.update(func() { f.scenario.ProcessesStarted++ }); err != nil {
		t.Fatal("cannot persist process-start receipt")
	}
	go func() {
		process.err = process.command.Wait()
		_ = binaryAcceptance.update(func() { process.scenario.ProcessesReaped++ })
		close(process.done)
	}()
	t.Cleanup(func() {
		defer cancel()
		select {
		case <-process.done:
		default:
			_ = process.command.Process.Signal(syscall.SIGTERM)
			select {
			case <-process.done:
				if process.err != nil {
					t.Error("owned process failed during cleanup shutdown")
				}
			case <-time.After(5 * time.Second):
				_ = process.command.Process.Kill()
				select {
				case <-process.done:
				case <-time.After(2 * time.Second):
					t.Error("owned process could not be reaped")
				}
				t.Error("owned process required forced cleanup")
			}
		}
		process.logs.safe(t, "acceptance-secret", f.databaseURL, "daynight-test", "SELECT ", "INSERT ", "UPDATE ", "CREATE TABLE", process.token, process.appSecret)
	})
	return process
}

func acceptanceAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal("cannot reserve a candidate acceptance address")
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal("cannot release candidate acceptance listener")
	}
	return address
}

func (p *acceptanceProcess) started(t *testing.T) *acceptanceProcess {
	t.Helper()
	select {
	case address := <-p.logs.ready:
		if host, _, err := net.SplitHostPort(address); err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() || "http://"+address != p.origin {
			t.Fatal("binary listener differs from its configured numeric loopback origin")
		}
		p.address = address
	case <-p.done:
		if p.configuration["DAYNIGHT_LISTEN_ADDR"] == "" && p.attempt < 2 && p.logs.matches(map[string]any{"phase": "startup", "diagnostic": "HTTP listen failed", "cause": "address_in_use"}) {
			p.gateway.Close(t)
			retry := p.fixture.launch(t, p.configuration)
			retry.attempt = p.attempt + 1
			return retry.started(t)
		}
		t.Fatal("acceptance binary exited before HTTP readiness")
	case <-time.After(8 * time.Second):
		t.Fatal("acceptance binary did not become ready")
	}
	browser := testauth.Browser(t)
	response, err := browser.Get(p.origin + "/api/v1/projects")
	if err != nil {
		t.Fatal("cannot verify anonymous built-binary admission")
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatal("built binary accepted an anonymous project request")
	}
	testauth.Login(t, browser, p.origin, "alice")
	p.token = testauth.CreatePAT(t, browser, p.origin)
	browser.CloseIdleConnections()
	return p
}

func (p *acceptanceProcess) signal(t *testing.T) {
	t.Helper()
	if err := p.command.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal("cannot signal owned acceptance process")
	}
}

func (p *acceptanceProcess) stopped(t *testing.T, expected int) {
	t.Helper()
	select {
	case <-p.done:
	case <-time.After(8 * time.Second):
		t.Fatal("owned process did not stop within the shutdown bound")
	}
	actual := 0
	if p.err != nil {
		var exitError *exec.ExitError
		if !errors.As(p.err, &exitError) {
			t.Fatal("owned process wait failed")
		}
		actual = exitError.ExitCode()
	}
	if actual != expected {
		p.logs.mu.Lock()
		var lifecycle []map[string]any
		for _, event := range p.logs.events {
			if event["type"] == "operation_error" && event["component"] == "server" {
				lifecycle = append(lifecycle, map[string]any{"phase": event["phase"], "cause": event["cause"], "diagnostic": event["diagnostic"]})
			}
		}
		p.logs.mu.Unlock()
		t.Fatalf("process exit code %d, expected %d; lifecycle failures: %v", actual, expected, lifecycle)
	}
}

type acceptanceResponse struct {
	status int
	header http.Header
	body   []byte
	err    error
}

func (p *acceptanceProcess) request(ctx context.Context, method, path string, input any, id string) acceptanceResponse {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return acceptanceResponse{err: err}
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, "http://"+p.address+path, body)
	if err != nil {
		return acceptanceResponse{err: err}
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Authorization", "Bearer "+p.token)
	if id != "" {
		request.Header.Set("X-Request-ID", id)
	}
	transport := &http.Transport{DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	response, err := (&http.Client{Transport: transport, Timeout: 8 * time.Second}).Do(request)
	if err != nil {
		return acceptanceResponse{err: err}
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	return acceptanceResponse{status: response.StatusCode, header: response.Header, body: data, err: err}
}

func acceptanceDecode[T any](t *testing.T, response acceptanceResponse, status int) T {
	t.Helper()
	if response.err != nil || response.status != status {
		t.Fatalf("HTTP operation returned status %d, expected %d (transport failure: %t)", response.status, status, response.err != nil)
	}
	if response.header.Get("Content-Type") != "application/json" || response.header.Get("X-Request-ID") == "" {
		t.Fatal("HTTP response omitted JSON content type or request ID")
	}
	var value T
	if err := json.Unmarshal(response.body, &value); err != nil {
		t.Fatal("HTTP response was not valid expected JSON")
	}
	return value
}

func acceptanceError(t *testing.T, response acceptanceResponse, status int, code string) api.Error {
	t.Helper()
	value := acceptanceDecode[api.ErrorResponse](t, response, status).Error
	if value.Code != code || value.RequestID != response.header.Get("X-Request-ID") || value.Message == "" {
		t.Fatal("HTTP error code or request correlation differs from the contract")
	}
	leaks, err := acceptanceErrorLeaks(response.body, response.header.Values("X-Request-ID"))
	if err != nil {
		t.Fatalf("HTTP error correlation metadata is invalid: %v", err)
	}
	if leaks {
		t.Fatal("sensitive data entered the HTTP error response")
	}
	return value
}

func (p *acceptanceProcess) project(t *testing.T, name string) api.Project {
	t.Helper()
	response := p.request(context.Background(), http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: name, RepoURL: "https://github.com/example/acceptance-repo"}, "")
	project := acceptanceDecode[api.Project](t, response, http.StatusCreated)
	if response.header.Get("Location") != "/api/v1/projects/"+project.ID || project.ID == "" || project.Settings != (api.ProjectSettings{Version: 1, ExecutionWarningMinutes: 60}) {
		t.Fatal("project identity or Location is invalid")
	}
	return project
}

func acceptanceTasksPath(projectID string) string { return "/api/v1/projects/" + projectID + "/tasks" }
func acceptanceTaskPath(task api.Task) string {
	return acceptanceTasksPath(task.ProjectID) + "/" + task.ID
}

func (p *acceptanceProcess) task(t *testing.T, project api.Project, title string, dependencies ...string) api.Task {
	t.Helper()
	input := map[string]any{"title": title}
	if dependencies != nil {
		input["dependsOn"] = dependencies
	}
	response := p.request(context.Background(), http.MethodPost, acceptanceTasksPath(project.ID), input, "")
	task := acceptanceDecode[api.Task](t, response, http.StatusCreated)
	if response.header.Get("Location") != acceptanceTaskPath(task) || task.ProjectID != project.ID || task.Version != 1 || task.Status != "todo" || task.Ready != (len(task.BlockedBy) == 0) {
		t.Fatal("task create metadata or Location is invalid")
	}
	return task
}

func (p *acceptanceProcess) readTask(t *testing.T, task api.Task) api.Task {
	t.Helper()
	return acceptanceDecode[api.Task](t, p.request(context.Background(), http.MethodGet, acceptanceTaskPath(task), nil, ""), http.StatusOK)
}

func (p *acceptanceProcess) update(t *testing.T, task api.Task, fields map[string]any) api.Task {
	t.Helper()
	fields["version"] = task.Version
	return acceptanceDecode[api.Task](t, p.request(context.Background(), http.MethodPatch, acceptanceTaskPath(task), fields, ""), http.StatusOK)
}

func acceptanceTaskTimingTransition(t *testing.T, before, after api.Task, status string) {
	t.Helper()
	if before.Status == status {
		if !reflect.DeepEqual(after.StartedAt, before.StartedAt) || !reflect.DeepEqual(after.CompletedAt, before.CompletedAt) {
			t.Fatal("same-status confirmation changed execution timing")
		}
		return
	}
	switch status {
	case "todo":
		if after.StartedAt != nil || after.CompletedAt != nil {
			t.Fatal("returning to todo did not clear the current interval")
		}
	case "in_progress":
		if after.StartedAt == nil || !after.StartedAt.Equal(after.UpdatedAt) || after.CompletedAt != nil {
			t.Fatal("entering in_progress did not atomically record its real start with no completion")
		}
	case "done":
		var expectedStart *time.Time
		if before.Status == "in_progress" {
			expectedStart = before.StartedAt
		}
		if !reflect.DeepEqual(after.StartedAt, expectedStart) || after.CompletedAt == nil || !after.CompletedAt.Equal(after.UpdatedAt) ||
			after.StartedAt != nil && after.CompletedAt.Before(*after.StartedAt) {
			t.Fatal("completion did not preserve its known start and atomically record its real end")
		}
	default:
		t.Fatalf("unexpected task status %q", status)
	}
}

func (p *acceptanceProcess) setStatus(t *testing.T, task api.Task, status string) api.Task {
	t.Helper()
	updated := acceptanceDecode[api.Task](t, p.request(context.Background(), http.MethodPut, acceptanceTaskPath(task)+"/status", map[string]any{"version": task.Version, "status": status}, ""), http.StatusOK)
	acceptanceTaskTimingTransition(t, task, updated, status)
	preserved := updated
	preserved.StartedAt, preserved.CompletedAt = task.StartedAt, task.CompletedAt
	preserved.Status, preserved.Ready, preserved.Version, preserved.UpdatedAt = task.Status, task.Ready, task.Version, task.UpdatedAt
	preserved.BlockedBy = task.BlockedBy
	changed := task.Status != status
	expectedVersion := task.Version
	if changed {
		expectedVersion++
	}
	if updated.Status != status || updated.Version != expectedVersion || changed && !updated.UpdatedAt.After(task.UpdatedAt) || !changed && !updated.UpdatedAt.Equal(task.UpdatedAt) || !reflect.DeepEqual(preserved, task) {
		t.Fatal("status assignment changed unrelated data or returned the wrong version/timestamp branch")
	}
	return updated
}

func (f *acceptanceFixture) exec(t *testing.T, sql string, arguments ...any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if _, err := f.admin.Exec(ctx, sql, arguments...); err != nil {
		t.Fatal("acceptance database setup or assertion failed")
	}
}

func (f *acceptanceFixture) projectLock(t *testing.T, projectID string) pgx.Tx {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	tx, err := f.admin.Begin(ctx)
	if err != nil {
		t.Fatal("cannot begin owned project lock transaction")
	}
	if _, err := tx.Exec(ctx, "SELECT id FROM projects WHERE id=$1 FOR UPDATE", projectID); err != nil {
		t.Fatal("cannot hold owned project row lock")
	}
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := tx.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			t.Error("cannot release owned project row lock")
		}
	})
	return tx
}

func acceptanceRelease(t *testing.T, tx pgx.Tx) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal("cannot release owned SQL barrier")
	}
}

func (f *acceptanceFixture) waitWriters(t *testing.T, process *acceptanceProcess, count int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	err := acceptanceEventually(ctx, func() (bool, error) {
		var waiting int
		err := f.admin.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE application_name=$1 AND wait_event_type='Lock'
			AND query LIKE 'SELECT id::text FROM projects WHERE id = % FOR UPDATE'`, process.application).Scan(&waiting)
		return waiting == count, err
	})
	if err != nil {
		t.Fatal("actual owned HTTP writers did not reach the project row-lock barrier")
	}
}

func acceptanceReceive(t *testing.T, channel <-chan acceptanceResponse) acceptanceResponse {
	t.Helper()
	select {
	case value := <-channel:
		return value
	case <-time.After(10 * time.Second):
		t.Fatal("HTTP operation exceeded its bound")
		return acceptanceResponse{}
	}
}
