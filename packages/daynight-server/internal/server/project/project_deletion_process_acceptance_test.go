//go:build acceptance

package project_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	coreattachment "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	projectservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/project"
	"github.com/google/uuid"
)

func TestProjectDeletionBuiltProcessRestart(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	h := testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
		return authhttp.NewAuthentication(identity, configpkg.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	})
	cookie := h.Login(t, "deletion-process-acceptance")
	principal, err := h.Identity.Authenticate(ctx, model.SessionCredential, cookie.Value)
	if err != nil {
		t.Fatal(err)
	}
	projects := projectservice.NewProjects(h.Database)
	project, err := projects.Create(ctx, principal, coreproject.CreateProject{Name: "To delete", RepoURL: "https://example.com/delete.git", ExpectedUserID: principal.UserID})
	if err != nil {
		t.Fatal(err)
	}
	other, err := projects.Create(ctx, principal, coreproject.CreateProject{Name: "Other", RepoURL: "https://example.com/other.git", ExpectedUserID: principal.UserID})
	if err != nil {
		t.Fatal(err)
	}
	task := uuid.NewString()
	if _, err = h.Database.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,version,status) VALUES($1,$2,'retained',9,'in_progress')`, task, project.ID); err != nil {
		t.Fatal(err)
	}
	module, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	tempRoot := filepath.Join(module, ".tmp")
	if err = os.MkdirAll(tempRoot, 0755); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(tempRoot, "project-delete-process-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	binary := filepath.Join(dir, "daynight-server")
	build := exec.CommandContext(ctx, "go", "build", "-overlay=scripts/unit-overlay.json", "-o", binary, "./cmd/daynight-server")
	build.Dir = module
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build server: %v\n%s", err, output)
	}
	binaryBytes, err := os.ReadFile(binary)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("server binary sha256=%x; build uses unit web overlay", sha256.Sum256(binaryBytes))
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err = listener.Close(); err != nil {
		t.Fatal(err)
	}
	origin := "http://" + address
	storageRoot := filepath.Join(dir, "storage")
	env := make([]string, 0, len(os.Environ())+10)
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "DAYNIGHT_") {
			env = append(env, entry)
		}
	}
	env = append(env, "DAYNIGHT_DATABASE_URL="+h.Database.Pool.Config().ConnString(), "DAYNIGHT_STORAGE_ROOT="+storageRoot, "DAYNIGHT_LISTEN_ADDR="+address, "DAYNIGHT_PUBLIC_ORIGIN="+origin, "DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN=1", "DAYNIGHT_ALLOW_LOOPBACK_HTTP=1", "DAYNIGHT_UNIAUTH_URL=http://127.0.0.1:1", "DAYNIGHT_UNIAUTH_APP_ID=test-app", "DAYNIGHT_UNIAUTH_APP_SECRET=test-secret", "DAYNIGHT_UNIAUTH_CALLBACK_URL="+origin+"/api/v1/auth/callback", "DAYNIGHT_MCP_RESERVED_FREE_BYTES=0", "DAYNIGHT_STARTUP_TIMEOUT=90s")
	logFile, err := os.Create(filepath.Join(dir, "server.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()
	client := &http.Client{Timeout: 3 * time.Second}
	var process *exec.Cmd
	stop := func() {
		t.Helper()
		if process == nil {
			return
		}
		if err := process.Process.Signal(syscall.SIGTERM); err != nil {
			t.Errorf("stop server: %v", err)
		}
		done := make(chan error, 1)
		go func() { done <- process.Wait() }()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("server exit: %v", err)
			}
		case <-time.After(10 * time.Second):
			_ = process.Process.Kill()
			<-done
			t.Error("server failed to stop")
		}
		process = nil
	}
	defer stop()
	request := func(method, path, body string) *http.Response {
		t.Helper()
		r, err := http.NewRequestWithContext(ctx, method, origin+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		r.AddCookie(cookie)
		r.Header.Set("Origin", origin)
		r.Header.Set("Content-Type", "text/plain")
		response, err := client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	start := func() {
		t.Helper()
		process = exec.CommandContext(ctx, binary)
		process.Dir = module
		process.Env = env
		process.Stdout = logFile
		process.Stderr = logFile
		if err := process.Start(); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(100 * time.Second)
		for time.Now().Before(deadline) {
			r, err := http.NewRequestWithContext(ctx, "GET", origin+"/api/v1/me", nil)
			if err != nil {
				t.Fatal(err)
			}
			response, err := client.Do(r)
			if err == nil {
				response.Body.Close()
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		data, _ := os.ReadFile(logFile.Name())
		t.Fatalf("server did not start: %s", data)
	}
	start()
	base := "/api/v1/projects/" + project.ID
	taskBase := base + "/tasks/" + task
	fileContent := "persistent process file\n"
	response := request("PUT", taskBase+"/attachments/files/history.txt", fileContent)
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 201 {
		t.Fatalf("PUT: %d %s", response.StatusCode, data)
	}
	addr, err := coreattachment.NewAddress(project.ID, task, "history.txt")
	if err != nil {
		t.Fatal(err)
	}
	hash := func() [32]byte {
		t.Helper()
		files, err := local.New(storageRoot)
		if err != nil {
			t.Fatal(err)
		}
		defer files.Close()
		object, err := files.Open(ctx, coreattachment.Bucket, addr.StoragePath)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(object.Body)
		closeErr := object.Body.Close()
		if err != nil || closeErr != nil {
			t.Fatalf("file read: %v %v", err, closeErr)
		}
		return sha256.Sum256(data)
	}
	expected := hash()
	if expected != sha256.Sum256([]byte(fileContent)) {
		t.Fatal("wrong file content")
	}
	response = request("DELETE", base, "")
	data, _ = io.ReadAll(response.Body)
	response.Body.Close()
	var receipt api.ProjectDeletionReceipt
	if response.StatusCode != 200 || json.Unmarshal(data, &receipt) != nil || receipt.ProjectID != project.ID || !receipt.Deleted {
		t.Fatalf("DELETE: %d %s", response.StatusCode, data)
	}
	stop()
	start()
	for _, path := range []string{base, base + "/deletion-preview", taskBase, taskBase + "/attachments", taskBase + "/attachments/files/history.txt"} {
		response = request("GET", path, "")
		data, _ = io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 404 {
			t.Errorf("after process restart %s: %d %s", path, response.StatusCode, data)
		}
	}
	response = request("GET", "/api/v1/projects/"+other.ID, "")
	data, _ = io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("other project: %d %s", response.StatusCode, data)
	}
	if hash() != expected {
		t.Fatal("file changed across process restart")
	}
	var version int64
	var status string
	var deleted bool
	if err = h.Database.Pool.QueryRow(ctx, `SELECT t.version,t.status,p.deleted_at IS NOT NULL FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1`, task).Scan(&version, &status, &deleted); err != nil || version != 9 || status != "in_progress" || !deleted {
		t.Fatalf("persistent state: %d %s %t %v", version, status, deleted, err)
	}
}
