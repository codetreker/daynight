package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"reflect"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPersistenceProcessHelper(t *testing.T) {
	if os.Getenv("DAYNIGHT_PERSISTENCE_PROCESS_HELPER") != "1" {
		return
	}
	os.Exit(run(context.Background(), nil, os.Getenv, os.Stdout, os.Stderr))
}

type persistenceProcessLog struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (l *persistenceProcessLog) Write(value []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.buffer.Len()+len(value) > 1024*1024 {
		return 0, errors.New("server diagnostics exceeded limit")
	}
	return l.buffer.Write(value)
}

func (l *persistenceProcessLog) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buffer.String()
}

type persistenceProcess struct {
	cmd      *exec.Cmd
	finished chan error
	logs     *persistenceProcessLog
	stopped  bool
}

func startPersistenceProcess(t *testing.T, values map[string]string) *persistenceProcess {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestPersistenceProcessHelper$")
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if _, overridden := values[key]; !overridden && key != "DAYNIGHT_PERSISTENCE_PROCESS_HELPER" {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	for key, value := range values {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	cmd.Env = append(cmd.Env, "DAYNIGHT_PERSISTENCE_PROCESS_HELPER=1")
	logs := &persistenceProcessLog{}
	cmd.Stdout, cmd.Stderr = logs, logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	process := &persistenceProcess{cmd: cmd, finished: make(chan error, 1), logs: logs}
	go func() { process.finished <- cmd.Wait() }()
	t.Cleanup(func() {
		if !process.stopped {
			if err := process.stop(); err != nil {
				t.Errorf("cleanup server process: %v", err)
			}
		}
	})
	client := &http.Client{Timeout: time.Second}
	defer client.CloseIdleConnections()
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		response, err := client.Get(values["DAYNIGHT_PUBLIC_ORIGIN"] + "/readyz")
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return process
			}
		}
		select {
		case err := <-process.finished:
			process.stopped = true
			t.Fatalf("server exited before readiness: %v; %s", err, logs.String())
		case <-deadline.C:
			t.Fatalf("server did not become ready: %s", logs.String())
		case <-ticker.C:
		}
	}
}

func (p *persistenceProcess) stop() error {
	if p.stopped {
		return nil
	}
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		select {
		case result := <-p.finished:
			p.stopped = true
			return errors.Join(err, result)
		default:
			killErr := p.cmd.Process.Kill()
			select {
			case result := <-p.finished:
				p.stopped = true
				return errors.Join(err, killErr, result)
			case <-time.After(5 * time.Second):
				return errors.Join(err, killErr, errors.New("server process did not exit after kill"))
			}
		}
	}
	select {
	case err := <-p.finished:
		p.stopped = true
		return err
	case <-time.After(15 * time.Second):
		killErr := p.cmd.Process.Kill()
		select {
		case err := <-p.finished:
			p.stopped = true
			return errors.Join(errors.New("server shutdown timed out"), killErr, err)
		case <-time.After(5 * time.Second):
			return errors.Join(errors.New("server process did not exit after kill"), killErr)
		}
	}
}

func processPersistenceDecode[T any](t *testing.T, response *http.Response, data []byte, status int) T {
	t.Helper()
	if response.StatusCode != status {
		t.Fatalf("HTTP %s %s: %d %s", response.Request.Method, response.Request.URL.Path, response.StatusCode, data)
	}
	var result T
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestServerProcessPersistsResourcesAcrossRestart(t *testing.T) {
	values := processAPIEnvironment(t)
	gateway := testauth.StartGateway(t, values["DAYNIGHT_UNIAUTH_CALLBACK_URL"])
	values["DAYNIGHT_UNIAUTH_URL"], values["DAYNIGHT_UNIAUTH_APP_ID"], values["DAYNIGHT_UNIAUTH_APP_SECRET"] = gateway.Origin, gateway.AppID, gateway.AppSecret
	adminURL := values["DAYNIGHT_DATABASE_URL"]
	parsed, err := url.Parse(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	applicationName := "process_restart_" + strings.ToLower(rand.Text())
	query := parsed.Query()
	query.Set("application_name", applicationName)
	parsed.RawQuery = query.Encode()
	values["DAYNIGHT_DATABASE_URL"] = parsed.String()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	admin, err := pgxpool.New(ctx, adminURL)
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	process := startPersistenceProcess(t, values)
	browser := testauth.Browser(t)
	testauth.Login(t, browser, values["DAYNIGHT_PUBLIC_ORIGIN"], "alice")
	token := testauth.CreatePAT(t, browser, values["DAYNIGHT_PUBLIC_ORIGIN"])
	browser.CloseIdleConnections()
	client := &http.Client{Timeout: 5 * time.Second, Transport: bearerTransport{token: token, next: http.DefaultTransport}}
	defer client.CloseIdleConnections()
	request := func(method, path, contentType string, data []byte) (*http.Response, []byte) {
		t.Helper()
		req, err := http.NewRequest(method, values["DAYNIGHT_PUBLIC_ORIGIN"]+path, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		if err != nil || closeErr != nil {
			t.Fatalf("read response: %v, close: %v", err, closeErr)
		}
		return response, body
	}
	jsonRequest := func(method, path string, value any) (*http.Response, []byte) {
		t.Helper()
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return request(method, path, "application/json", data)
	}
	response, body := request(http.MethodGet, "/api/v1/me", "", nil)
	user := processPersistenceDecode[api.User](t, response, body, http.StatusOK)
	response, body = jsonRequest(http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: "Restart persistence", RepoURL: "https://example.com/restart", ExpectedUserID: user.ID})
	project := processPersistenceDecode[api.Project](t, response, body, http.StatusCreated)
	projectPath := "/api/v1/projects/" + project.ID
	response, body = jsonRequest(http.MethodPatch, projectPath+"/settings", api.UpdateProjectSettingsRequest{Version: project.Settings.Version, ExecutionWarningMinutes: 90})
	processPersistenceDecode[api.Project](t, response, body, http.StatusOK)
	createTask := func(title, description string, dependencies, external []string) api.Task {
		t.Helper()
		response, body := jsonRequest(http.MethodPost, projectPath+"/tasks", map[string]any{"title": title, "description": description, "dependsOn": dependencies, "externalDependsOn": external})
		return processPersistenceDecode[api.Task](t, response, body, http.StatusCreated)
	}
	first := createTask("Prerequisite", "Persistent description", []string{}, []string{})
	response, body = jsonRequest(http.MethodPut, projectPath+"/tasks/"+first.ID+"/status", api.TaskStatusUpdateRequest{Version: first.Version, Status: "in_progress"})
	first = processPersistenceDecode[api.Task](t, response, body, http.StatusOK)
	ctx, cancel = context.WithTimeout(context.Background(), 10*time.Second)
	_, err = admin.Exec(ctx, "UPDATE tasks SET version=$1 WHERE id=$2", int64(math.MaxInt64-1), first.ID)
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	response, body = jsonRequest(http.MethodPut, projectPath+"/tasks/"+first.ID+"/status", api.TaskStatusUpdateRequest{Version: math.MaxInt64 - 1, Status: "done"})
	first = processPersistenceDecode[api.Task](t, response, body, http.StatusOK)
	if first.Status != "done" || first.Version != math.MaxInt64 || !bytes.Contains(body, []byte(`"version":9223372036854775807`)) {
		t.Fatalf("maximum version completion: %#v", first)
	}
	completed := createTask("Completed dependent", "Completed chain", []string{first.ID}, []string{})
	for _, status := range []string{"in_progress", "done"} {
		response, body = jsonRequest(http.MethodPut, projectPath+"/tasks/"+completed.ID+"/status", api.TaskStatusUpdateRequest{Version: completed.Version, Status: status})
		completed = processPersistenceDecode[api.Task](t, response, body, http.StatusOK)
	}
	if completed.Status != "done" || !slices.Equal(completed.DependsOn, []string{first.ID}) {
		t.Fatalf("completed dependent lost prerequisite: %#v", completed)
	}
	second := createTask("External prerequisite", "Awaiting work", []string{}, []string{})
	target := createTask("Blocked classified task", "Retained task", []string{first.ID, second.ID}, []string{second.ID})
	references := []api.PullRequestProperty{
		{URL: "", Title: ""},
		{URL: "-arbitrary=地址, text", Title: "  标题\n\x1b[2J  "},
		{URL: "-arbitrary=地址, text", Title: "  标题\n\x1b[2J  "},
	}
	response, body = jsonRequest(http.MethodPatch, projectPath+"/tasks/"+target.ID, map[string]any{"version": target.Version, "properties": map[string]any{"pullRequests": references}})
	target = processPersistenceDecode[api.Task](t, response, body, http.StatusOK)
	checkReferences := func(value api.Task) {
		t.Helper()
		var actual []api.PullRequestProperty
		if err := json.Unmarshal(value.Properties["pullRequests"], &actual); err != nil || !reflect.DeepEqual(actual, references) {
			t.Fatalf("PR references did not survive: %#v %v", actual, err)
		}
	}
	checkReferences(target)
	attachmentPath := projectPath + "/tasks/" + target.ID + "/attachments/files/nested/data.bin"
	content := []byte{0, 1, 255, 13, 10, 'a'}
	response, body = request(http.MethodPut, attachmentPath, "application/octet-stream", content)
	processPersistenceDecode[api.Attachment](t, response, body, http.StatusCreated)
	const exact int64 = 9_007_199_254_740_993
	ctx, cancel = context.WithTimeout(context.Background(), 10*time.Second)
	_, err = admin.Exec(ctx, "UPDATE projects SET settings_version=$1 WHERE id=$2", exact, project.ID)
	if err == nil {
		_, err = admin.Exec(ctx, "UPDATE tasks SET version=$1 WHERE id=$2", exact, target.ID)
	}
	cancel()
	if err != nil {
		t.Fatal(err)
	}
	readProject := func() api.Project {
		response, body := request(http.MethodGet, projectPath, "", nil)
		return processPersistenceDecode[api.Project](t, response, body, http.StatusOK)
	}
	readTask := func(id string) api.Task {
		response, body := request(http.MethodGet, projectPath+"/tasks/"+id, "", nil)
		return processPersistenceDecode[api.Task](t, response, body, http.StatusOK)
	}
	readGraph := func() api.TaskGraph {
		response, body := request(http.MethodGet, projectPath+"/task-graph?taskId="+url.QueryEscape(target.ID), "", nil)
		return processPersistenceDecode[api.TaskGraph](t, response, body, http.StatusOK)
	}
	readAttachments := func() api.AttachmentPage {
		response, body := request(http.MethodGet, projectPath+"/tasks/"+target.ID+"/attachments", "", nil)
		return processPersistenceDecode[api.AttachmentPage](t, response, body, http.StatusOK)
	}
	project = readProject()
	first, second, target, completed = readTask(first.ID), readTask(second.ID), readTask(target.ID), readTask(completed.ID)
	checkReferences(target)
	graph, attachments := readGraph(), readAttachments()
	if project.Settings.Version != exact || project.Settings.ExecutionWarningMinutes != 90 || target.Version != exact || first.Version != math.MaxInt64 || first.Description != "Persistent description" || first.Status != "done" || second.Status != "todo" || target.Ready || !reflect.DeepEqual(target.ExternalDependsOn, []string{second.ID}) || len(target.DependsOn) != 2 || !slices.Contains(target.DependsOn, first.ID) || !slices.Contains(target.DependsOn, second.ID) || len(attachments.Items) != 1 || attachments.Items[0].Path != "nested/data.bin" || attachments.Items[0].ContentType != "application/octet-stream" || attachments.Items[0].SizeBytes != int64(len(content)) || graph.Project != project || graph.ObservedAt.IsZero() || !slices.ContainsFunc(graph.Tasks, func(item api.GraphTask) bool {
		return item.ID == target.ID && reflect.DeepEqual(item.ExternalDependsOn, []string{second.ID})
	}) {
		t.Fatalf("persistence fixture incomplete: project=%#v first=%#v second=%#v target=%#v attachments=%#v", project, first, second, target, attachments)
	}
	if err := process.stop(); err != nil {
		t.Fatalf("first process did not stop cleanly: %v; %s", err, process.logs.String())
	}
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	var connections int
	err = admin.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE application_name=$1", applicationName).Scan(&connections)
	cancel()
	if err != nil || connections != 0 {
		t.Fatalf("stopped process retained database connections: %d %v", connections, err)
	}
	process = startPersistenceProcess(t, values)
	if actual := readProject(); !reflect.DeepEqual(actual, project) {
		t.Fatalf("project changed across restart: %#v", actual)
	}
	for _, before := range []api.Task{first, second, target, completed} {
		actual := readTask(before.ID)
		if !reflect.DeepEqual(actual, before) {
			t.Fatalf("task changed across restart: %#v", actual)
		}
		if before.ID == target.ID {
			checkReferences(actual)
		}
	}
	if actual := readAttachments(); !reflect.DeepEqual(actual, attachments) {
		t.Fatalf("attachment metadata changed across restart: %#v", actual)
	}
	response, body = request(http.MethodGet, attachmentPath, "", nil)
	if response.StatusCode != http.StatusOK || !bytes.Equal(body, content) {
		t.Fatalf("attachment bytes changed across restart: %d", response.StatusCode)
	}
	after := readGraph()
	if !after.ObservedAt.After(graph.ObservedAt) {
		t.Fatalf("restarted graph did not observe a fresh database time: %v then %v", graph.ObservedAt, after.ObservedAt)
	}
	after.ObservedAt = graph.ObservedAt
	if !reflect.DeepEqual(after, graph) {
		t.Fatalf("graph changed across restart: %#v", after)
	}
	if err := process.stop(); err != nil {
		t.Fatalf("restarted process did not stop cleanly: %v; %s", err, process.logs.String())
	}
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	err = admin.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE application_name=$1", applicationName).Scan(&connections)
	cancel()
	if err != nil || connections != 0 {
		t.Fatalf("restarted process retained database connections: %d %v", connections, err)
	}
	listener, err := net.Listen("tcp", values["DAYNIGHT_LISTEN_ADDR"])
	if err != nil {
		t.Fatalf("restarted process retained listener: %v", err)
	}
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
}
