package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
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
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	"github.com/jackc/pgx/v5"
)

// startMigrationProcess starts without waiting for readiness so the test can
// observe both processes waiting on the same PostgreSQL migration lock.
func startMigrationProcess(t *testing.T, values map[string]string) *persistenceProcess {
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
				t.Errorf("cleanup service process: %v", err)
			}
		}
	})
	return process
}

func waitMigrationProcessReady(t *testing.T, ctx context.Context, process *persistenceProcess, origin string) {
	t.Helper()
	client := &http.Client{Timeout: time.Second}
	defer client.CloseIdleConnections()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		response, err := client.Get(origin + "/readyz")
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		select {
		case err := <-process.finished:
			process.stopped = true
			t.Fatalf("service exited before readiness: %v; %s", err, process.logs.String())
		case <-ctx.Done():
			t.Fatalf("service readiness timed out: %s", process.logs.String())
		case <-ticker.C:
		}
	}
}

func TestConcurrentServerProcessesShareMigratedTaskSync(t *testing.T) {
	firstValues := processAPIEnvironment(t)
	gateway := testauth.StartGateway(t, firstValues["DAYNIGHT_UNIAUTH_CALLBACK_URL"])
	firstValues["DAYNIGHT_UNIAUTH_URL"], firstValues["DAYNIGHT_UNIAUTH_APP_ID"], firstValues["DAYNIGHT_UNIAUTH_APP_SECRET"] = gateway.Origin, gateway.AppID, gateway.AppSecret
	firstValues["DAYNIGHT_STARTUP_TIMEOUT"] = "40s"
	secondValues := make(map[string]string, len(firstValues))
	for key, value := range firstValues {
		secondValues[key] = value
	}
	for tries := 0; tries < 10; tries++ {
		secondValues["DAYNIGHT_LISTEN_ADDR"] = testAddress(t)
		if secondValues["DAYNIGHT_LISTEN_ADDR"] != firstValues["DAYNIGHT_LISTEN_ADDR"] {
			break
		}
	}
	if secondValues["DAYNIGHT_LISTEN_ADDR"] == firstValues["DAYNIGHT_LISTEN_ADDR"] {
		t.Fatal("could not select distinct service addresses")
	}
	secondValues["DAYNIGHT_PUBLIC_ORIGIN"] = "http://" + secondValues["DAYNIGHT_LISTEN_ADDR"]
	secondValues["DAYNIGHT_UNIAUTH_CALLBACK_URL"] = secondValues["DAYNIGHT_PUBLIC_ORIGIN"] + "/api/v1/auth/callback"
	adminURL := firstValues["DAYNIGHT_DATABASE_URL"]
	applications := []string{"migration_first_" + strings.ToLower(rand.Text()), "migration_second_" + strings.ToLower(rand.Text())}
	for i, values := range []map[string]string{firstValues, secondValues} {
		parsed, err := url.Parse(adminURL)
		if err != nil {
			t.Fatal(err)
		}
		query := parsed.Query()
		query.Set("application_name", applications[i])
		parsed.RawQuery = query.Encode()
		values["DAYNIGHT_DATABASE_URL"] = parsed.String()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	observer, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if err := observer.Close(cleanup); err != nil {
			t.Error(err)
		}
	}()
	var existingObjects int
	if err := observer.QueryRow(ctx, `SELECT count(*) FROM pg_depend
		WHERE refclassid='pg_namespace'::regclass AND refobjid=current_schema()::regnamespace`).Scan(&existingObjects); err != nil || existingObjects != 0 {
		t.Fatalf("concurrent initialization requires an empty schema: objects=%d error=%v", existingObjects, err)
	}
	const migrationLock int64 = 0x4441594e49474854
	if _, err := observer.Exec(ctx, "SELECT pg_advisory_lock($1)", migrationLock); err != nil {
		t.Fatal(err)
	}
	held := true
	defer func() {
		if held {
			cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
			defer done()
			if _, err := observer.Exec(cleanup, "SELECT pg_advisory_unlock($1)", migrationLock); err != nil {
				t.Error(err)
			}
		}
	}()
	first := startMigrationProcess(t, firstValues)
	second := startMigrationProcess(t, secondValues)
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting int
		err := observer.QueryRow(ctx, `SELECT count(DISTINCT activity.application_name) FROM pg_locks locks JOIN pg_stat_activity activity USING(pid)
			WHERE locks.locktype='advisory' AND locks.classid=$1::oid AND locks.objid=$2::oid AND NOT locks.granted
			AND activity.application_name=ANY($3::text[])`, migrationLock>>32, migrationLock&0xffffffff, applications).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting == 2 {
			break
		}
		select {
		case err := <-first.finished:
			first.stopped = true
			t.Fatalf("first service exited before migration barrier: %v; %s", err, first.logs.String())
		case err := <-second.finished:
			second.stopped = true
			t.Fatalf("second service exited before migration barrier: %v; %s", err, second.logs.String())
		case <-ctx.Done():
			t.Fatal("both service processes did not reach the migration lock")
		case <-ticker.C:
		}
	}
	var unlocked bool
	if err := observer.QueryRow(ctx, "SELECT pg_advisory_unlock($1)", migrationLock).Scan(&unlocked); err != nil || !unlocked {
		t.Fatalf("release migration lock: %v unlocked=%v", err, unlocked)
	}
	held = false
	waitMigrationProcessReady(t, ctx, first, firstValues["DAYNIGHT_PUBLIC_ORIGIN"])
	waitMigrationProcessReady(t, ctx, second, secondValues["DAYNIGHT_PUBLIC_ORIGIN"])
	var versions []int64
	if err := observer.QueryRow(ctx, `SELECT array_agg(version ORDER BY version) FROM schema_migrations`).Scan(&versions); err != nil {
		t.Fatal(err)
	}
	var seedRows int
	if err := observer.QueryRow(ctx, `SELECT (SELECT count(*) FROM private_transfer_ledger WHERE singleton)
		+ (SELECT count(*) FROM oauth_credential_cleanup_cursor WHERE singleton)
		+ (SELECT count(*) FROM oauth_authorization_cleanup_cursor WHERE singleton)`).Scan(&seedRows); err != nil || seedRows != 3 {
		t.Fatalf("concurrent initialization lost system records: count=%d error=%v", seedRows, err)
	}
	migrationRoot := filepath.Join("..", "..", "internal", "core", "store", "postgres")
	var wantVersions []int64
	for _, directory := range []string{filepath.Join(migrationRoot, "migrations"), filepath.Join(migrationRoot, "internal", "migration026", "migrations")} {
		entries, err := os.ReadDir(directory)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
				continue
			}
			prefix, _, found := strings.Cut(entry.Name(), "_")
			version, err := strconv.ParseInt(prefix, 10, 64)
			if !found || err != nil || version < 1 {
				t.Fatalf("invalid migration filename %q", entry.Name())
			}
			wantVersions = append(wantVersions, version)
		}
	}
	slices.Sort(wantVersions)
	if !slices.Equal(versions, wantVersions) {
		t.Fatalf("concurrent processes did not share the complete migration ledger: %v", versions)
	}
	if len(versions) < 39 || versions[37] != 38 || versions[38] != 39 {
		t.Fatalf("OAuth migrations missing from ledger: %v", versions)
	}
	var grants, access, refresh, clients int
	if err := observer.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants), (SELECT count(*) FROM oauth_access_tokens), (SELECT count(*) FROM oauth_refresh_tokens), (SELECT count(*) FROM oauth_clients)`).Scan(&grants, &access, &refresh, &clients); err != nil || grants != 0 || access != 0 || refresh != 0 || clients != 0 {
		t.Fatalf("OAuth tables after concurrent startup: grants=%d access=%d refresh=%d clients=%d error=%v", grants, access, refresh, clients, err)
	}
	browser := testauth.Browser(t)
	testauth.Login(t, browser, firstValues["DAYNIGHT_PUBLIC_ORIGIN"], "alice")
	token := testauth.CreatePAT(t, browser, firstValues["DAYNIGHT_PUBLIC_ORIGIN"])
	browser.CloseIdleConnections()
	client := &http.Client{Timeout: 5 * time.Second, Transport: bearerTransport{token: token, next: http.DefaultTransport}}
	defer client.CloseIdleConnections()
	request := func(origin, method, path string, input any) (*http.Response, []byte) {
		t.Helper()
		var data []byte
		if input != nil {
			var err error
			data, err = json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
		}
		req, err := http.NewRequest(method, origin+path, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		if input != nil {
			req.Header.Set("Content-Type", "application/json")
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
	origin1, origin2 := firstValues["DAYNIGHT_PUBLIC_ORIGIN"], secondValues["DAYNIGHT_PUBLIC_ORIGIN"]
	response, body := request(origin1, http.MethodGet, "/api/v1/me", nil)
	user := processPersistenceDecode[api.User](t, response, body, http.StatusOK)
	response, body = request(origin1, http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: "Concurrent startup", RepoURL: "https://example.com/concurrent", ExpectedUserID: user.ID})
	project := processPersistenceDecode[api.Project](t, response, body, http.StatusCreated)
	path := "/api/v1/projects/" + project.ID
	response, body = request(origin1, http.MethodGet, path+"/task-sync", nil)
	empty1 := processPersistenceDecode[api.TaskSync](t, response, body, http.StatusOK)
	response, body = request(origin2, http.MethodGet, path+"/task-sync", nil)
	empty2 := processPersistenceDecode[api.TaskSync](t, response, body, http.StatusOK)
	if empty1.Epoch == "" || empty1.Epoch != empty2.Epoch || empty1.Mode != "snapshot" || empty2.Mode != "snapshot" || empty1.Project != project || empty2.Project != project || empty1.Tasks == nil || empty2.Tasks == nil || len(empty1.Tasks) != 0 || len(empty2.Tasks) != 0 || empty1.ObservedAt.IsZero() || empty2.ObservedAt.IsZero() {
		t.Fatalf("empty project did not share an initialized snapshot: %#v %#v", empty1, empty2)
	}
	empty2.ObservedAt = empty1.ObservedAt
	if !reflect.DeepEqual(empty1, empty2) {
		t.Fatalf("empty project snapshots differ: %#v %#v", empty1, empty2)
	}
	response, body = request(origin1, http.MethodPost, path+"/tasks", map[string]any{"title": "Shared task", "description": "Persistent state"})
	task := processPersistenceDecode[api.Task](t, response, body, http.StatusCreated)
	read := func(origin string) (api.Project, api.Task, api.TaskSync) {
		t.Helper()
		response, body := request(origin, http.MethodGet, path, nil)
		readProject := processPersistenceDecode[api.Project](t, response, body, http.StatusOK)
		response, body = request(origin, http.MethodGet, path+"/tasks/"+task.ID, nil)
		readTask := processPersistenceDecode[api.Task](t, response, body, http.StatusOK)
		response, body = request(origin, http.MethodGet, path+"/task-sync", nil)
		sync := processPersistenceDecode[api.TaskSync](t, response, body, http.StatusOK)
		return readProject, readTask, sync
	}
	project1, task1, sync1 := read(origin1)
	project2, task2, sync2 := read(origin2)
	if project1 != project || project2 != project || sync1.Project != project || !reflect.DeepEqual(task1, task) || !reflect.DeepEqual(task2, task) || sync1.Epoch != empty1.Epoch || sync1.Epoch != sync2.Epoch || sync1.Mode != "snapshot" || len(sync1.Tasks) != 1 || sync1.Tasks[0].ID != task.ID || sync1.Tasks[0].TitlePreview != task.Title || sync1.Tasks[0].Status != task.Status || sync1.Tasks[0].Version != strconv.FormatInt(task.Version, 10) || !reflect.DeepEqual(sync1.Tasks[0].DependsOn, task.DependsOn) || !reflect.DeepEqual(sync1.Tasks[0].ExternalDependsOn, task.ExternalDependsOn) || sync1.ObservedAt.IsZero() || sync2.ObservedAt.IsZero() {
		t.Fatalf("services did not share project, task and sync state: %#v %#v", sync1, sync2)
	}
	sync2.ObservedAt = sync1.ObservedAt
	if !reflect.DeepEqual(sync1, sync2) {
		t.Fatalf("services returned different task sync projections: %#v %#v", sync1, sync2)
	}
	for _, process := range []*persistenceProcess{first, second} {
		if err := process.stop(); err != nil {
			t.Fatalf("service process did not stop cleanly: %v; %s", err, process.logs.String())
		}
	}
	var connections int
	if err := observer.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE application_name=ANY($1::text[])", applications).Scan(&connections); err != nil || connections != 0 {
		t.Fatalf("service database connections remained: %d %v", connections, err)
	}
	for _, values := range []map[string]string{firstValues, secondValues} {
		listener, err := net.Listen("tcp", values["DAYNIGHT_LISTEN_ADDR"])
		if err != nil {
			t.Fatalf("service retained listener: %v", err)
		}
		if err := listener.Close(); err != nil {
			t.Fatal(err)
		}
	}
}
