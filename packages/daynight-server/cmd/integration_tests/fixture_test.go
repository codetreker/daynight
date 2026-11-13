//go:build integration

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/hex"
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
	"regexp"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.yaml.in/yaml/v4"
)

type buildReceipt struct {
	SourceSHA         string `json:"sourceSha"`
	SourceFingerprint string `json:"sourceFingerprint"`
	BinarySHA256      string `json:"binarySha256"`
	GoVersion         string `json:"goVersion"`
	Race              bool   `json:"race"`
}

type processLog struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (l *processLog) Write(data []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.buffer.Len()+len(data) > 1<<20 {
		return 0, errors.New("integration server diagnostics exceeded 1 MiB")
	}
	if _, err := os.Stdout.Write(data); err != nil {
		return 0, err
	}
	return l.buffer.Write(data)
}

func (l *processLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buffer.String()
}

type serverProcess struct {
	command *exec.Cmd
	exited  chan struct{}
	waitErr error
	logs    *processLog
}

func (p *serverProcess) stop(t *testing.T) {
	t.Helper()
	select {
	case <-p.exited:
		if p.waitErr != nil {
			t.Errorf("integration server exited: %v\n%s", p.waitErr, p.logs.String())
		}
		return
	default:
	}
	if err := p.command.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
		t.Errorf("stop integration server: %v", err)
	}
	select {
	case <-p.exited:
		if p.waitErr != nil {
			t.Errorf("integration server shutdown failed: %v\n%s", p.waitErr, p.logs.String())
		}
	case <-time.After(5 * time.Second):
		t.Error("integration server did not stop within its shutdown budget")
		if err := p.command.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			t.Errorf("kill integration server: %v", err)
		}
		select {
		case <-p.exited:
		case <-time.After(3 * time.Second):
			t.Error("integration server remained alive after forced termination")
		}
	}
}

type fixture struct {
	context      context.Context
	origin       string
	client       *http.Client
	userID       string
	databaseURL  string
	s2sSharedKey string
	process      *serverProcess
}

func verifyServerBuild(t *testing.T) string {
	t.Helper()
	binary := os.Getenv("DAYNIGHT_INTEGRATION_SERVER_BINARY")
	if binary == "" {
		t.Fatal("run scripts/integration.sh to build the integration Server")
	}
	data, err := os.ReadFile(binary + ".json")
	if err != nil {
		t.Fatal(err)
	}
	var receipt buildReceipt
	if err := json.Unmarshal(data, &receipt); err != nil {
		t.Fatal(err)
	}
	if len(receipt.SourceSHA) != 40 || len(receipt.SourceFingerprint) != 64 || receipt.GoVersion != "go1.27.2" {
		t.Fatalf("invalid integration build receipt: %+v", receipt)
	}
	file, err := os.Open(binary)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.New()
	_, hashErr := io.Copy(hash, file)
	if err := errors.Join(hashErr, file.Close()); err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(hash.Sum(nil)) != receipt.BinarySHA256 {
		t.Fatal("integration Server differs from its build receipt")
	}
	info, err := buildinfo.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	if info.Main.Path != "github.com/codetreker/daynight/packages/daynight-server" || info.Path != "github.com/codetreker/daynight/packages/daynight-server/cmd/daynight-server" || info.GoVersion != receipt.GoVersion {
		t.Fatalf("integration executable is not the expected Server build: %+v", info)
	}
	race := false
	for _, setting := range info.Settings {
		if setting.Key == "-race" {
			race = setting.Value == "true"
		}
	}
	if race != receipt.Race {
		t.Fatal("integration Server race instrumentation differs from its receipt")
	}
	t.Logf("integration source=%s fingerprint=%s binary=%s toolchain=%s race=%t", receipt.SourceSHA, receipt.SourceFingerprint, receipt.BinarySHA256, receipt.GoVersion, receipt.Race)
	return binary
}

func integrationRunRoot(t *testing.T) string {
	t.Helper()
	runRoot := os.Getenv("DAYNIGHT_INTEGRATION_RUN_ROOT")
	if runRoot == "" {
		t.Fatal("integration runner did not supply its cleanup directory")
	}
	module, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Dir(runRoot) != filepath.Join(module, ".tmp") || !regexp.MustCompile(`^integration\.[A-Za-z0-9]{8}$`).MatchString(filepath.Base(runRoot)) {
		t.Fatal("integration cleanup directory is outside its module owner")
	}
	return runRoot
}

func writeOwnedResources(path string, resources ownedResources) error {
	data, err := json.Marshal(resources)
	if err != nil {
		return err
	}
	if err := os.WriteFile(path+".writing", data, 0o600); err != nil {
		return err
	}
	return os.Rename(path+".writing", path)
}

func newFixture(t *testing.T) *fixture {
	return newFixtureWithDecoder(t, false)
}

func newFixtureWithDecoder(t *testing.T, imageDecoder bool) *fixture {
	t.Helper()
	binary := verifyServerBuild(t)
	databaseURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("integration requires its test environment's isolated PostgreSQL")
	}
	runRoot := integrationRunRoot(t)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Minute)
	t.Cleanup(cancel)
	root := filepath.Join(runRoot, "storage")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	var process *serverProcess
	stopped := func() bool {
		if process == nil {
			return true
		}
		select {
		case <-process.exited:
			return true
		default:
			return false
		}
	}
	t.Cleanup(func() {
		if !stopped() {
			t.Error("retaining integration storage because Server termination is unconfirmed")
			return
		}
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := "api_" + strings.ToLower(rand.Text())
	resources := ownedResources{DatabaseURL: databaseURL, Schema: schema, StorageRoot: root}
	resourcePath := filepath.Join(runRoot, "resources.json")
	t.Cleanup(func() {
		defer admin.Close()
		if !stopped() {
			t.Error("retaining integration schema because Server termination is unconfirmed")
			return
		}
		cleanup, finish := context.WithTimeout(context.Background(), 10*time.Second)
		defer finish()
		if _, err := admin.Exec(cleanup, "DROP SCHEMA IF EXISTS "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	writeResources := func() error { return writeOwnedResources(resourcePath, resources) }
	if err := writeResources(); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	query.Set("timezone", "UTC")
	parsed.RawQuery = query.Encode()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	origin := "http://" + address
	callbackURL := origin + "/api/v1/auth/callback"
	resources.GatewayCallback = callbackURL
	gateway := testauth.StartGatewayWithResources(t, callbackURL, stopped, func(resource testauth.GatewayResources) error {
		if resources.GatewayRoot != "" && resources.GatewayRoot != resource.Directory {
			return errors.New("authentication resource directory changed after preparation")
		}
		resources.GatewayRoot = resource.Directory
		switch resource.State {
		case "prepared":
		case "started":
			identity, err := identifyProcess(resource.PID)
			if err != nil {
				return err
			}
			resources.Gateway = &identity
		default:
			return errors.New("invalid authentication resource lifecycle state")
		}
		return writeResources()
	})
	s2sSharedKey := rand.Text() + rand.Text()
	configuration := map[string]any{
		"s2s":       map[string]any{"allowed_origin": "https://client.example", "shared_key": s2sSharedKey},
		"server":    map[string]any{"listen_address": address, "public_origin": origin, "allow_http_test_origin": true, "startup_timeout": "10s", "shutdown_timeout": "2s"},
		"database":  map[string]any{"url": parsed.String()},
		"storage":   map[string]any{"root": "attachments"},
		"uniauth":   map[string]any{"url": gateway.Origin, "app_id": gateway.AppID, "app_secret": gateway.AppSecret, "callback_url": callbackURL, "allow_loopback_http": true},
		"task_sync": map[string]any{"overlap": "10s"},
		"webhook":   map[string]any{"enabled": true},
	}
	if imageDecoder {
		dir, node := os.Getenv("DAYNIGHT_INTEGRATION_IMAGE_DECODER_DIR"), os.Getenv("DAYNIGHT_INTEGRATION_NODE_PATH")
		if !filepath.IsAbs(dir) || !filepath.IsAbs(node) {
			t.Fatal("integration runner must provide the real image decoder and Node paths")
		}
		temporary := filepath.Join(root, "image-decode")
		if err := os.Mkdir(temporary, 0o700); err != nil {
			t.Fatal(err)
		}
		configuration["image_decoder"] = map[string]any{
			"node_path": node, "helper_path": filepath.Join(dir, "image-validation-helper.js"),
			"manifest_path": filepath.Join(dir, "image-validation-manifest.json"), "temporary_directory": temporary,
		}
	}
	configDir := filepath.Join(root, "config")
	if err := os.Mkdir(configDir, 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := yaml.Marshal(configuration)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir, "config.yml"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(binary, "--root", root)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "DAYNIGHT_") {
			command.Env = append(command.Env, entry)
		}
	}
	command.Env = append(command.Env, "DAYNIGHT_INTEGRATION_RUN_ROOT="+runRoot)
	child := &serverProcess{command: command, exited: make(chan struct{}), logs: &processLog{}}
	command.Stdout, command.Stderr = child.logs, child.logs
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	process = child
	go func() {
		process.waitErr = command.Wait()
		close(process.exited)
	}()
	t.Cleanup(func() { process.stop(t) })
	identity, err := identifyProcess(command.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	resources.Server = &identity
	if err := writeResources(); err != nil {
		t.Fatal(err)
	}
	readyClient := &http.Client{Timeout: time.Second}
	t.Cleanup(readyClient.CloseIdleConnections)
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+"/readyz", nil)
		if err != nil {
			t.Fatal(err)
		}
		response, err := readyClient.Do(request)
		if err == nil {
			_, readErr := io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
			closeErr := response.Body.Close()
			if errors.Join(readErr, closeErr) != nil {
				t.Fatal(errors.Join(readErr, closeErr))
			}
			if response.StatusCode == http.StatusOK {
				break
			}
		}
		select {
		case <-process.exited:
			t.Fatalf("integration Server stopped before readiness: %v\n%s", process.waitErr, process.logs.String())
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-deadline.C:
			t.Fatalf("integration Server did not become ready\n%s", process.logs.String())
		case <-ticker.C:
		}
	}
	browser := testauth.Browser(t)
	testauth.Login(t, browser, origin, "alice")
	token := testauth.CreatePAT(t, browser, origin)
	browser.CloseIdleConnections()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	t.Cleanup(transport.CloseIdleConnections)
	f := &fixture{context: ctx, origin: origin, databaseURL: parsed.String(), s2sSharedKey: s2sSharedKey, process: process, client: &http.Client{Timeout: 5 * time.Second, Transport: tokenTransport{token: token, next: transport}}}
	response, body := f.request(t, http.MethodGet, "/api/v1/projects", "", nil, http.StatusOK)
	var page api.ProjectPage
	if err := json.Unmarshal(body, &page); err != nil {
		t.Fatal(err)
	}
	if page.Items == nil || response.Header.Get("X-Request-ID") == "" {
		t.Fatalf("project list envelope or request correlation is missing: %s", body)
	}
	f.userID = response.Header.Get("Daynight-User-ID")
	if f.userID == "" {
		t.Fatal("authenticated API did not identify its principal")
	}
	return f
}

type tokenTransport struct {
	token string
	next  http.RoundTripper
}

func (r tokenTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	copy := request.Clone(request.Context())
	copy.Header.Set("Authorization", "Bearer "+r.token)
	return r.next.RoundTrip(copy)
}

func (f *fixture) request(t *testing.T, method, path, contentType string, body []byte, status int) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequestWithContext(f.context, method, f.origin+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := f.client.Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v\n%s", method, path, err, f.process.logs.String())
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	closeErr := response.Body.Close()
	if err := errors.Join(readErr, closeErr); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != status {
		t.Fatalf("%s %s returned %d, want %d: %s\n%s", method, path, response.StatusCode, status, data, f.process.logs.String())
	}
	return response, data
}

func requestJSON[T any](t *testing.T, f *fixture, method, path string, input any, status int) T {
	t.Helper()
	var body []byte
	if input != nil {
		var err error
		body, err = json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
	}
	_, data := f.request(t, method, path, "application/json", body, status)
	var result T
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("decode %s %s: %v: %s", method, path, err, data)
	}
	return result
}

func createProject(t *testing.T, f *fixture, name string) api.Project {
	t.Helper()
	project := requestJSON[api.Project](t, f, http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: name, RepoURL: "https://github.com/example/integration", ExpectedUserID: f.userID}, http.StatusCreated)
	if project.ID == "" || project.Name != name {
		t.Fatalf("created project identity/content differs: %+v", project)
	}
	return project
}

func taskCollection(projectID string) string { return "/api/v1/projects/" + projectID + "/tasks" }
func taskPath(task api.Task) string          { return taskCollection(task.ProjectID) + "/" + task.ID }

func createTask(t *testing.T, f *fixture, project api.Project, title string, fields map[string]any) api.Task {
	t.Helper()
	input := map[string]any{"title": title}
	for key, value := range fields {
		input[key] = value
	}
	task := requestJSON[api.Task](t, f, http.MethodPost, taskCollection(project.ID), input, http.StatusCreated)
	if task.ID == "" || task.ProjectID != project.ID || task.Title != title || task.Version < 1 {
		t.Fatalf("created task identity/content differs: %+v", task)
	}
	return task
}

func setStatus(t *testing.T, f *fixture, task api.Task, status string, claim *string) api.Task {
	t.Helper()
	result := requestJSON[api.Task](t, f, http.MethodPut, taskPath(task)+"/status", api.TaskStatusUpdateRequest{Version: task.Version, Status: status, ClaimID: claim}, http.StatusOK)
	if result.ID != task.ID || result.ProjectID != task.ProjectID || result.Status != status || result.Version != task.Version+1 {
		t.Fatalf("status result identity/content differs: %+v", result)
	}
	return result
}

func assertTaskContent(t *testing.T, actual, expected api.Task) {
	t.Helper()
	if actual.ID != expected.ID || actual.ProjectID != expected.ProjectID || actual.Version != expected.Version || actual.Title != expected.Title || actual.Description != expected.Description || actual.Status != expected.Status {
		t.Fatalf("task readback differs: actual=%+v expected=%+v", actual, expected)
	}
}

func workerClaim(t *testing.T, task api.Task) api.WorkerClaim {
	t.Helper()
	var claim api.WorkerClaim
	if err := json.Unmarshal(task.Properties["worker"], &claim); err != nil {
		t.Fatal(err)
	}
	return claim
}

func requireProperty(t *testing.T, properties api.TaskProperties, name string, expected any) {
	t.Helper()
	want, err := json.Marshal(expected)
	if err != nil {
		t.Fatal(err)
	}
	actual, ok := properties[name]
	var actualValue, expectedValue any
	if !ok {
		t.Fatalf("property %s absent from readback", name)
	}
	if err := errors.Join(json.Unmarshal(actual, &actualValue), json.Unmarshal(want, &expectedValue)); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actualValue, expectedValue) {
		t.Fatalf("property %s differs: got %s, want %s", name, actual, want)
	}
}

func expectID[T any](t *testing.T, values []T, id string, idOf func(T) string) T {
	t.Helper()
	for _, value := range values {
		if idOf(value) == id {
			return value
		}
	}
	t.Fatalf("resource %s absent from readback", id)
	var zero T
	return zero
}

func syncPath(projectID string) string { return "/api/v1/projects/" + projectID + "/task-sync" }

func deltaPath(projectID string, baseline api.TaskSync) string {
	return syncPath(projectID) + "?" + url.Values{"epoch": {baseline.Epoch}, "since": {baseline.ObservedAt.Format(time.RFC3339Nano)}}.Encode()
}

func resourceVersion(version int64) string { return fmt.Sprintf("%d", version) }

func identifyProcess(pid int) (processIdentity, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return processIdentity{}, err
	}
	fields := strings.Fields(string(data)[strings.LastIndexByte(string(data), ')')+2:])
	if len(fields) <= 19 || fields[0] == "Z" || fields[0] == "X" {
		return processIdentity{}, errors.New("integration process exited before its ownership receipt")
	}
	executable, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil {
		return processIdentity{}, err
	}
	return processIdentity{PID: pid, StartTicks: fields[19], Executable: executable}, nil
}

func decodeAttachment(t *testing.T, data []byte) api.Attachment {
	t.Helper()
	var result api.Attachment
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}
