//go:build startupshutdown

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
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

type grantResponse struct {
	status int
	header http.Header
	body   []byte
	err    error
}
type grantProcess struct {
	command *exec.Cmd
	done    chan struct{}
	err     error
	logs    grantLogs
}
type grantLogs struct {
	mu    sync.Mutex
	bytes bytes.Buffer
}

func (l *grantLogs) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.bytes.Write(p)
}
func (l *grantLogs) contains(secret string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return secret != "" && strings.Contains(l.bytes.String(), secret)
}

func grantRoundTrip(client *http.Client, request *http.Request) grantResponse {
	response, err := client.Do(request)
	if err != nil {
		return grantResponse{err: err}
	}
	body, readErr := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	closeErr := response.Body.Close()
	if len(body) > 2<<20 {
		readErr = errors.Join(readErr, errors.New("response exceeds the test limit"))
	}
	return grantResponse{status: response.StatusCode, header: response.Header.Clone(), body: body, err: errors.Join(readErr, closeErr)}
}
func grantRequest(ctx context.Context, client *http.Client, method, address, token string, input any) grantResponse {
	var body io.Reader
	if input != nil {
		value, err := json.Marshal(input)
		if err != nil {
			return grantResponse{err: err}
		}
		body = bytes.NewReader(value)
	}
	request, err := http.NewRequestWithContext(ctx, method, address, body)
	if err != nil {
		return grantResponse{err: err}
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	return grantRoundTrip(client, request)
}
func grantDecode[T any](t *testing.T, response grantResponse, status int) T {
	t.Helper()
	var value T
	if response.err != nil || response.status != status || json.Unmarshal(response.body, &value) != nil {
		t.Fatalf("grant fixture HTTP status=%d, expected=%d, transport failure=%t", response.status, status, response.err != nil)
	}
	return value
}
func grantNotFound(t *testing.T, response grantResponse) {
	t.Helper()
	value := grantDecode[api.ErrorResponse](t, response, http.StatusNotFound)
	if value.Error.Code != "not_found" {
		t.Fatal("revoked resource did not return not_found")
	}
}
func grantAwait(t *testing.T, ctx context.Context, result <-chan grantResponse) grantResponse {
	t.Helper()
	select {
	case response := <-result:
		if response.err != nil {
			t.Fatal("owned grant HTTP request failed")
		}
		return response
	case <-ctx.Done():
		t.Fatal("owned grant HTTP request timed out")
		return grantResponse{}
	}
}
func grantWait(ctx context.Context, check func() (bool, error)) error {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		ok, err := check()
		if err != nil {
			return err
		}
		if ok {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
func grantEnvironment(values map[string]string) []string {
	env := make([]string, 0, len(os.Environ())+len(values))
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(key, "DAYNIGHT_") {
			env = append(env, entry)
		}
	}
	for key, value := range values {
		env = append(env, key+"="+value)
	}
	return env
}
func grantGit(t *testing.T, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = filepath.Join("..", "..")
	output, err := cmd.Output()
	if err != nil {
		t.Fatal("cannot determine source identity")
	}
	return strings.TrimSpace(string(output))
}

type grantProcessControl interface {
	Signal(os.Signal) error
	Kill() error
}

func grantStopProcess(process grantProcessControl, done <-chan struct{}, graceful, forced time.Duration) (bool, error) {
	select {
	case <-done:
		return true, nil
	default:
	}
	signalErr := process.Signal(syscall.SIGTERM)
	if errors.Is(signalErr, os.ErrProcessDone) {
		signalErr = nil
	}
	timer := time.NewTimer(graceful)
	defer timer.Stop()
	select {
	case <-done:
		return true, signalErr
	case <-timer.C:
	}
	killErr := process.Kill()
	if errors.Is(killErr, os.ErrProcessDone) {
		killErr = nil
	}
	deadline := time.NewTimer(forced)
	defer deadline.Stop()
	select {
	case <-done:
		return true, errors.Join(signalErr, killErr, errors.New("owned service required forced termination"))
	case <-deadline.C:
		return false, errors.Join(signalErr, killErr, errors.New("owned service could not be reaped within the deadline"))
	}
}

func grantRemoveTempRoot(root string, stopped bool) error {
	if !stopped {
		return errors.New("owned fixture directory retained because service exit is unconfirmed")
	}
	if err := os.RemoveAll(root); err != nil {
		return errors.New("cannot remove owned fixture directory")
	}
	return nil
}

func grantTempRoot(t *testing.T, prefix string, cleanupAllowed func() bool) string {
	t.Helper()
	base, err := filepath.Abs(filepath.Join("..", "..", ".tmp"))
	if err != nil || os.MkdirAll(base, 0o755) != nil {
		t.Fatal("cannot prepare owned fixture directory")
	}
	root, err := os.MkdirTemp(base, prefix)
	if err != nil {
		t.Fatal("cannot create owned fixture directory")
	}
	t.Cleanup(func() {
		if err := grantRemoveTempRoot(root, cleanupAllowed()); err != nil {
			t.Errorf("%v: %s", err, root)
		}
	})
	return root
}

func grantDatabaseEnvironment(t *testing.T, storageRoot string, cleanupAllowed func() bool) (map[string]string, string) {
	t.Helper()
	databaseURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal("cannot configure isolated database")
	}
	schema := "grant_" + strings.ToLower(rand.Text())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatal("cannot create isolated schema")
	}
	t.Cleanup(func() {
		defer admin.Close()
		if !cleanupAllowed() {
			t.Errorf("owned schema %s retained because service exit is unconfirmed", schema)
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error("cannot remove isolated schema")
		}
	})
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal("cannot parse isolated database URL")
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	address := testAddress(t)
	origin := "http://" + address
	return map[string]string{"DAYNIGHT_DATABASE_URL": parsed.String(), "DAYNIGHT_STORAGE_ROOT": storageRoot, "DAYNIGHT_LISTEN_ADDR": address,
		"DAYNIGHT_PUBLIC_ORIGIN": origin, "DAYNIGHT_UNIAUTH_CALLBACK_URL": origin + "/api/v1/auth/callback",
		"DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN": "1", "DAYNIGHT_ALLOW_LOOPBACK_HTTP": "1"}, schema
}

func TestAttachmentGrantRevocationWithFreshProcess(t *testing.T) {
	// The receipt is written after the owned process, gateway, schema, and temporary roots are cleaned.
	var storageRoot, binaryRoot, schema, application, binarySHA, binaryGoVersion, postgresVersion, fixtureSHA string
	var buildConfirmed, processStarted, processReaped, sessionsRemoved, gatewayAttempted, binaryRace bool
	var gateway *testauth.Fixture
	cleanupAllowed := func() bool { return buildConfirmed && (!processStarted || processReaped && sessionsRemoved) }
	flags := os.Getenv("GOFLAGS")
	flagsSHA := fmt.Sprintf("%x", sha256.Sum256([]byte(flags)))
	gitHead, gitTree := grantGit(t, "rev-parse", "HEAD"), grantGit(t, "rev-parse", "HEAD^{tree}")
	dirty := grantGit(t, "status", "--porcelain") != ""
	var projectID, userID, taskID, bodySHA string
	var removalStatus, uploadStatus, observedPrefixBytes, observedBytes int
	var beforePAT, beforeCookie, afterPAT, afterCookie int
	var prefixObserved, removalBeforeUpload, deniedBeforeUpload, bytesVerified, stagingRemoved bool
	t.Cleanup(func() {
		cleanup := cleanupAllowed() && (!processStarted || sessionsRemoved)
		if gatewayAttempted && (gateway == nil || !gateway.CleanupConfirmed()) {
			cleanup = false
			t.Error("authentication fixture cleanup was not confirmed")
		}
		for _, path := range []string{storageRoot, binaryRoot} {
			if path != "" {
				if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
					cleanup = false
					t.Error("owned temporary root remains")
				}
			}
		}
		if schema != "" {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			pool, err := pgxpool.New(ctx, os.Getenv("DAYNIGHT_TEST_DATABASE_URL"))
			if err != nil {
				cleanup = false
				t.Error("cannot verify schema cleanup")
			} else {
				var exists bool
				err = pool.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)", schema).Scan(&exists)
				pool.Close()
				if err != nil || exists {
					cleanup = false
					t.Error("owned schema cleanup was not confirmed")
				}
			}
		}
		receipt := map[string]any{"sourceGit": gitHead, "sourceTree": gitTree, "dirty": dirty, "goVersion": runtime.Version(), "goFlagsSHA256": flagsSHA,
			"buildCommand": "go build -race=<test race> -o <owned> ./cmd/daynight-server", "binaryGoVersion": binaryGoVersion, "testRaceEnabled": grantRaceEnabled, "binaryRaceEnabled": binaryRace,
			"binarySHA256": binarySHA, "authFixtureSHA256": fixtureSHA, "postgresql": postgresVersion, "projectId": projectID, "userId": userID, "taskId": taskID,
			"prefixBytes": observedPrefixBytes, "bytes": observedBytes, "bodySHA256": bodySHA, "uploadStatus": uploadStatus, "removalStatus": removalStatus,
			"projectBeforePAT": beforePAT, "projectBeforeCookie": beforeCookie, "attachmentAfterPAT": afterPAT, "attachmentAfterCookie": afterCookie,
			"prefixObserved": prefixObserved, "removalBeforeUpload": removalBeforeUpload,
			"deniedBeforeUpload": deniedBeforeUpload, "bytesVerified": bytesVerified, "stagingRemoved": stagingRemoved,
			"processReaped": processReaped, "serviceSessionsRemoved": sessionsRemoved, "gatewayCleanupConfirmed": gateway != nil && gateway.CleanupConfirmed(), "resourcesRemoved": cleanup, "passed": !t.Failed() && cleanup}
		encoded, err := json.Marshal(receipt)
		if err != nil {
			t.Error("cannot encode grant admission evidence")
		} else {
			t.Logf("grant_admission_evidence=%s", encoded)
		}
	})

	binaryRoot = grantTempRoot(t, "grant-binary-", cleanupAllowed)
	binary := filepath.Join(binaryRoot, "daynight-server")
	buildCtx, buildCancel := context.WithTimeout(t.Context(), 75*time.Second)
	build := exec.CommandContext(buildCtx, "go", "build", "-race="+strconv.FormatBool(grantRaceEnabled), "-o", binary, "./cmd/daynight-server")
	build.Dir = filepath.Join("..", "..") // Preserve module-relative GOFLAGS, including overlays.
	build.Env = os.Environ()              // Keep GOFLAGS, including an explicit source overlay when supplied.
	build.WaitDelay = 2 * time.Second
	output, err := build.CombinedOutput()
	buildCancel()
	if err != nil {
		t.Fatalf("fresh service build failed: %v", err)
	}
	_ = output
	buildConfirmed = true
	binaryBytes, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal("cannot hash built service")
	}
	binarySHA = fmt.Sprintf("%x", sha256.Sum256(binaryBytes))
	buildInfo, err := buildinfo.ReadFile(binary)
	if err != nil {
		t.Fatal("cannot inspect built service settings")
	}
	binaryGoVersion = buildInfo.GoVersion
	if binaryGoVersion != runtime.Version() {
		t.Fatal("built service Go version differs from the module test")
	}
	for _, setting := range buildInfo.Settings {
		if setting.Key == "-race" {
			binaryRace = setting.Value == "true"
		}
	}
	if binaryRace != grantRaceEnabled {
		t.Fatal("service race instrumentation differs from the module test")
	}
	fixtureBytes, err := os.ReadFile(os.Getenv("DAYNIGHT_TEST_UNIAUTH_FIXTURE"))
	if err != nil {
		t.Fatal("cannot hash authentication fixture")
	}
	fixtureSHA = fmt.Sprintf("%x", sha256.Sum256(fixtureBytes))
	storageRoot = grantTempRoot(t, "grant-storage-", cleanupAllowed)
	values, ownedSchema := grantDatabaseEnvironment(t, storageRoot, cleanupAllowed)
	schema = ownedSchema
	parsed, err := url.Parse(values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal("cannot parse isolated database URL")
	}
	application = schema + "_child"
	query := parsed.Query()
	query.Set("application_name", application)
	parsed.RawQuery = query.Encode()
	values["DAYNIGHT_DATABASE_URL"] = parsed.String()
	observerURL := *parsed
	query = observerURL.Query()
	query.Set("application_name", schema+"_observer")
	observerURL.RawQuery = query.Encode()
	dbCtx, dbCancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer dbCancel()
	observer, err := pgxpool.New(dbCtx, observerURL.String())
	if err != nil {
		t.Fatal("cannot open isolated observation pool")
	}
	t.Cleanup(observer.Close)
	if err := observer.QueryRow(dbCtx, "SHOW server_version").Scan(&postgresVersion); err != nil {
		t.Fatal("cannot read PostgreSQL version")
	}
	gatewayAttempted = true
	gateway = testauth.StartGatewayGuarded(t, values["DAYNIGHT_UNIAUTH_CALLBACK_URL"], cleanupAllowed)
	values["DAYNIGHT_UNIAUTH_URL"], values["DAYNIGHT_UNIAUTH_APP_ID"], values["DAYNIGHT_UNIAUTH_APP_SECRET"] = gateway.Origin, gateway.AppID, gateway.AppSecret
	process := &grantProcess{done: make(chan struct{})}
	process.command = exec.Command(binary)
	process.command.WaitDelay = 2 * time.Second
	process.command.Env = grantEnvironment(values)
	process.command.Stdout = &process.logs
	process.command.Stderr = &process.logs
	if err := process.command.Start(); err != nil {
		t.Fatal("cannot start fresh service process")
	}
	processStarted = true
	go func() { process.err = process.command.Wait(); close(process.done) }()
	t.Cleanup(func() {
		var stopErr error
		processReaped, stopErr = grantStopProcess(process.command.Process, process.done, 5*time.Second, 2*time.Second)
		if stopErr != nil {
			t.Error(stopErr)
		}
		if !processReaped {
			return
		}
		if process.err != nil {
			t.Error("owned service process did not exit successfully")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := grantWait(ctx, func() (bool, error) {
			var sessions int
			err := observer.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE application_name=$1", application).Scan(&sessions)
			return err == nil && sessions == 0, err
		}); err != nil {
			t.Error("owned service database sessions did not clear")
		} else {
			sessionsRemoved = true
		}
	})
	origin := values["DAYNIGHT_PUBLIC_ORIGIN"]
	client := &http.Client{Transport: http.DefaultTransport.(*http.Transport).Clone(), Timeout: 12 * time.Second}
	defer client.CloseIdleConnections()
	readyCtx, readyCancel := context.WithTimeout(t.Context(), 10*time.Second)
	err = grantWait(readyCtx, func() (bool, error) {
		select {
		case <-process.done:
			return false, errors.New("service exited before readiness")
		default:
		}
		response := grantRequest(readyCtx, client, http.MethodGet, origin+"/readyz", "", nil)
		return response.err == nil && response.status == http.StatusOK, nil
	})
	readyCancel()
	if err != nil {
		t.Fatal("fresh service did not become ready")
	}

	admin, member := testauth.Browser(t), testauth.Browser(t)
	testauth.Login(t, admin, origin, "alice")
	testauth.Login(t, member, origin, "bob")
	adminPAT, memberPAT := testauth.CreatePAT(t, admin, origin), testauth.CreatePAT(t, member, origin)
	t.Cleanup(func() {
		for _, secret := range []string{adminPAT, memberPAT, gateway.AppSecret} {
			if process.logs.contains(secret) {
				t.Error("service diagnostics exposed a fixture secret")
			}
		}
	})
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	adminUser := grantDecode[api.User](t, grantRequest(ctx, client, http.MethodGet, origin+"/api/v1/me", adminPAT, nil), http.StatusOK)
	memberUser := grantDecode[api.User](t, grantRequest(ctx, client, http.MethodGet, origin+"/api/v1/me", memberPAT, nil), http.StatusOK)
	if adminUser.ID == "" || memberUser.ID == "" || adminUser.ID == memberUser.ID {
		t.Fatal("fixture identities are not distinct")
	}
	project := grantDecode[api.Project](t, grantRequest(ctx, client, http.MethodPost, origin+"/api/v1/projects", adminPAT, api.CreateProjectRequest{Name: "Attachment admission", RepoURL: "https://example.com/attachment-admission", ExpectedUserID: adminUser.ID}), http.StatusCreated)
	projectID, userID = project.ID, memberUser.ID
	base := "/api/v1/projects/" + project.ID
	invitation := grantDecode[api.CreatedProjectInvitation](t, grantRequest(ctx, client, http.MethodPost, origin+base+"/invitations", adminPAT, api.ProjectInvitationMutationRequest{ExpectedUserID: adminUser.ID}), http.StatusCreated)
	link, err := url.Parse(invitation.Link)
	if err != nil || link.Fragment == "" {
		t.Fatal("invitation omitted its acceptance token")
	}
	joined := grantDecode[api.ProjectInvitationAcceptance](t, grantRequest(ctx, client, http.MethodPost, origin+"/api/v1/invitations/accept", memberPAT, api.AcceptProjectInvitationRequest{Token: link.Fragment, ExpectedUserID: memberUser.ID}), http.StatusOK)
	if joined.DirectGrant.UserID != memberUser.ID || joined.DirectGrant.ProjectID != project.ID {
		t.Fatal("member did not receive the intended direct grant")
	}
	task := grantDecode[api.Task](t, grantRequest(ctx, client, http.MethodPost, origin+base+"/tasks", adminPAT, map[string]any{"title": "Attachment admission"}), http.StatusCreated)
	taskID = task.ID
	const prefixSize = 64 << 10
	body := bytes.Repeat([]byte{0, 0xff, 0x7f, '\n'}, 256<<10)
	path := base + "/tasks/" + task.ID + "/attachments/files/admission/retained.bin"
	reader, writer := io.Pipe()
	defer writer.CloseWithError(context.Canceled)
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, origin+path, reader)
	if err != nil {
		t.Fatal("cannot construct held upload")
	}
	request.ContentLength = int64(len(body))
	request.Header.Set("Authorization", "Bearer "+memberPAT)
	request.Header.Set("Content-Type", "application/octet-stream")
	request.Header.Set("X-Request-ID", "attachment-grant-revocation")
	result, uploadDone := make(chan grantResponse, 1), make(chan struct{})
	go func() { defer close(uploadDone); result <- grantRoundTrip(client, request) }()
	var removalDone <-chan struct{}
	defer func() {
		cancel()
		_ = writer.CloseWithError(context.Canceled)
		for _, done := range []<-chan struct{}{uploadDone, removalDone} {
			if done == nil {
				continue
			}
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("owned HTTP operation did not stop")
			}
		}
	}()
	if n, err := writer.Write(body[:prefixSize]); err != nil || n != prefixSize {
		t.Fatalf("cannot send upload prefix: %d", n)
	}
	staging := filepath.Join(storageRoot, "task-attachments", project.ID, task.ID[:2], task.ID, "admission")
	if err := grantWait(ctx, func() (bool, error) {
		entries, err := os.ReadDir(staging)
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".daynight-upload-") {
				bytesRead, err := os.ReadFile(filepath.Join(staging, entry.Name()))
				return err == nil && bytes.Equal(bytesRead, body[:prefixSize]), err
			}
		}
		return false, nil
	}); err != nil {
		t.Fatal("held upload prefix was not observed on disk")
	}
	prefixObserved = true
	observedPrefixBytes = prefixSize
	removal, done := make(chan grantResponse, 1), make(chan struct{})
	removalDone = done
	go func() {
		defer close(done)
		removal <- grantRequest(ctx, client, http.MethodDelete, origin+base+"/members/"+memberUser.ID, adminPAT, map[string]any{"version": joined.DirectGrant.Version, "expectedUserId": adminUser.ID})
	}()
	removed := grantAwait(t, ctx, removal)
	removalStatus = removed.status
	if removed.status != http.StatusNoContent || len(removed.body) != 0 {
		t.Fatal("member removal did not return 204")
	}
	select {
	case <-uploadDone:
		t.Fatal("upload completed before the remainder was sent")
	default:
	}
	removalBeforeUpload = true
	var grants, metadata int
	if err := observer.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2), (SELECT count(*) FROM task_attachments WHERE project_id=$1 AND task_id=$3 AND path=$4)`, project.ID, memberUser.ID, task.ID, "admission/retained.bin").Scan(&grants, &metadata); err != nil || grants != 0 || metadata != 0 {
		t.Fatal("grant removal or incomplete upload state differs before release")
	}
	entries, err := os.ReadDir(staging)
	if err != nil {
		t.Fatal("cannot inspect held upload")
	}
	staged := 0
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".daynight-upload-") {
			staged++
			contents, err := os.ReadFile(filepath.Join(staging, entry.Name()))
			if err != nil || !bytes.Equal(contents, body[:prefixSize]) {
				t.Fatal("held upload prefix changed before release")
			}
		} else if entry.Name() == "retained.bin" {
			t.Fatal("incomplete upload published its final file")
		}
	}
	if staged != 1 {
		t.Fatal("held upload did not retain exactly one staging file")
	}
	response := grantRequest(ctx, client, http.MethodGet, origin+base, memberPAT, nil)
	beforePAT = response.status
	grantNotFound(t, response)
	response = grantRequest(ctx, member, http.MethodGet, origin+base, "", nil)
	beforeCookie = response.status
	grantNotFound(t, response)
	select {
	case <-uploadDone:
		t.Fatal("upload completed while checking revoked access")
	default:
	}
	deniedBeforeUpload = true
	if n, err := writer.Write(body[prefixSize:]); err != nil || n != len(body)-prefixSize {
		select {
		case response := <-result:
			t.Fatalf("cannot send remaining upload: bytes=%d pipe=%v HTTP status=%d transport=%v context=%v", n, err, response.status, response.err, ctx.Err())
		case <-time.After(5 * time.Second):
			t.Fatalf("cannot send remaining upload: bytes=%d pipe=%v; HTTP result not available; context=%v", n, err, ctx.Err())
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal("cannot finish held upload")
	}
	uploaded := grantAwait(t, ctx, result)
	uploadStatus = uploaded.status
	attachment := grantDecode[api.Attachment](t, uploaded, http.StatusCreated)
	if uploaded.header.Get("X-Request-ID") != "attachment-grant-revocation" || attachment.Path != "admission/retained.bin" || attachment.SizeBytes != int64(len(body)) {
		t.Fatal("upload receipt differs from the sent bytes")
	}
	stored := grantRequest(ctx, client, http.MethodGet, origin+path, adminPAT, nil)
	if stored.err != nil || stored.status != http.StatusOK || !bytes.Equal(stored.body, body) {
		t.Fatal("committed attachment bytes differ from upload")
	}
	bytesVerified = true
	observedBytes = len(stored.body)
	bodySHA = fmt.Sprintf("%x", sha256.Sum256(stored.body))
	// The target gate serializes reads of this path with the upload.
	response = grantRequest(ctx, client, http.MethodGet, origin+path, memberPAT, nil)
	afterPAT = response.status
	grantNotFound(t, response)
	response = grantRequest(ctx, member, http.MethodGet, origin+path, "", nil)
	afterCookie = response.status
	grantNotFound(t, response)
	if err := observer.QueryRow(ctx, `SELECT (SELECT count(*) FROM project_grants WHERE project_id=$1 AND user_id=$2), (SELECT count(*) FROM task_attachments WHERE project_id=$1 AND task_id=$3 AND path=$4)`, project.ID, memberUser.ID, task.ID, "admission/retained.bin").Scan(&grants, &metadata); err != nil || grants != 0 || metadata != 1 {
		t.Fatal("committed grant or attachment metadata differs")
	}
	entries, err = os.ReadDir(staging)
	if err != nil {
		t.Fatal("cannot inspect staging cleanup")
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".daynight-upload-") {
			t.Fatal("completed upload left a temporary file")
		}
	}
	stagingRemoved = true
}

type grantFakeProcess struct {
	signal func(os.Signal) error
	kill   func() error
}

func (p grantFakeProcess) Signal(value os.Signal) error { return p.signal(value) }
func (p grantFakeProcess) Kill() error                  { return p.kill() }

func TestGrantStopProcessIsBounded(t *testing.T) {
	t.Run("already exited", func(t *testing.T) {
		done := make(chan struct{})
		close(done)
		calls := 0
		process := grantFakeProcess{signal: func(os.Signal) error { calls++; return nil }, kill: func() error { calls++; return nil }}
		reaped, err := grantStopProcess(process, done, time.Millisecond, time.Millisecond)
		if !reaped || err != nil || calls != 0 {
			t.Fatal("already exited process was signaled or not reaped")
		}
	})
	t.Run("graceful exit", func(t *testing.T) {
		done := make(chan struct{})
		killed := false
		process := grantFakeProcess{signal: func(os.Signal) error { close(done); return nil }, kill: func() error { killed = true; return nil }}
		reaped, err := grantStopProcess(process, done, time.Millisecond, time.Millisecond)
		if !reaped || err != nil || killed {
			t.Fatal("graceful exit did not finish cleanly")
		}
	})
	t.Run("forced exit", func(t *testing.T) {
		done := make(chan struct{})
		process := grantFakeProcess{signal: func(os.Signal) error { return nil }, kill: func() error { close(done); return nil }}
		reaped, err := grantStopProcess(process, done, time.Millisecond, time.Millisecond)
		if !reaped || err == nil || !strings.Contains(err.Error(), "forced termination") {
			t.Fatal("forced exit was not reported")
		}
	})
	t.Run("kill failure and no exit", func(t *testing.T) {
		done := make(chan struct{})
		failure := errors.New("kill failed")
		process := grantFakeProcess{signal: func(os.Signal) error { return nil }, kill: func() error { return failure }}
		reaped, err := grantStopProcess(process, done, time.Millisecond, time.Millisecond)
		if reaped || !errors.Is(err, failure) || !strings.Contains(err.Error(), "could not be reaped") {
			t.Fatal("unconfirmed exit was not preserved")
		}
	})
}

func TestGrantTempRootRequiresStoppedProcess(t *testing.T) {
	root := filepath.Join(t.TempDir(), "owned")
	if err := os.Mkdir(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := grantRemoveTempRoot(root, false); err == nil {
		t.Fatal("unconfirmed process allowed fixture removal")
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatal("unconfirmed process did not retain its fixture")
	}
	if err := grantRemoveTempRoot(root, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("stopped process fixture was not removed")
	}
}
