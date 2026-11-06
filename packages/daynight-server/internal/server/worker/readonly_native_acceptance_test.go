//go:build worker_readonly_acceptance

package worker

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	"github.com/google/uuid"
)

// Run explicitly after pnpm build; the ordinary Go gate does not install the CLI.
func startNativeReadOnlyWorker(t *testing.T, server, token, owner, worker, directory string) {
	t.Helper()
	repository, err := filepath.Abs("../../../../..")
	if err != nil {
		t.Fatal(err)
	}
	fixture := filepath.Join(repository, "packages", "daynight", "test", "fixtures", "worker-readonly-native.mjs")
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	cmd := exec.CommandContext(ctx, "node", fixture)
	cmd.Dir = directory
	cmd.WaitDelay = 2 * time.Second
	var diagnostics bytes.Buffer
	cmd.Stderr = &diagnostics
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		cancel()
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	t.Cleanup(func() {
		defer cancel()
		_, _ = io.WriteString(stdin, "close\n")
		_ = stdin.Close()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("Node Worker cleanup failed: %v (%s)", err, diagnostics.String())
			}
		case <-time.After(3 * time.Second):
			_ = cmd.Process.Kill()
			<-done
			t.Error("Node Worker required forced cleanup")
		}
	})
	configuration := map[string]string{"serverOrigin": server, "serverToken": token, "ownerUserId": owner, "workerId": worker, "defaultCwd": directory}
	if err = json.NewEncoder(stdin).Encode(configuration); err != nil {
		t.Fatal(err)
	}
	ready := make(chan bool, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		ready <- scanner.Scan() && scanner.Text() == "WORKER_READONLY_READY"
	}()
	select {
	case ok := <-ready:
		if !ok {
			t.Fatal("Node Worker did not connect")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Node Worker connection deadline exceeded")
	}
}

func TestReadOnlyNativeWorkerDirectoryAcceptance(t *testing.T) {
	f := newReadOnlyFixture(t)
	otherCookie := f.harness.Login(t, "native-readonly-other")
	authRequest := httptest.NewRequest("GET", "/", nil)
	authRequest.AddCookie(otherCookie)
	other, err := f.harness.Auth.AuthenticateRequest(authRequest)
	if err != nil {
		t.Fatal(err)
	}
	otherPAT, err := f.harness.Identity.CreatePAT(context.Background(), other, identitycore.CreatePAT{Name: "Native read-only acceptance"})
	if err != nil {
		t.Fatal(err)
	}
	otherWorker := uuid.NewString()
	f.report(t, otherWorker, otherPAT.Secret)
	type target struct {
		worker, token, owner, directory string
		names                           []string
	}
	targets := []target{
		{worker: f.worker, token: f.token, owner: f.owner.UserID, directory: t.TempDir(), names: []string{"alpha-a", "alpha-b", "alpha-c"}},
		{worker: otherWorker, token: otherPAT.Secret, owner: other.UserID, directory: t.TempDir(), names: []string{"beta-a", "beta-b", "beta-c"}},
	}
	contents := map[string][32]byte{}
	for index := range targets {
		target := &targets[index]
		target.directory, err = filepath.EvalSymlinks(target.directory)
		if err != nil {
			t.Fatal(err)
		}
		for _, name := range append(slices.Clone(target.names), ".hidden") {
			if err = os.Mkdir(filepath.Join(target.directory, name), 0700); err != nil {
				t.Fatal(err)
			}
		}
		file := filepath.Join(target.directory, "private.txt")
		content := []byte(fmt.Sprintf("unchanged content for target %d", index))
		if err = os.WriteFile(file, content, 0600); err != nil {
			t.Fatal(err)
		}
		contents[file] = sha256.Sum256(content)
		startNativeReadOnlyWorker(t, f.server.URL, target.token, target.owner, target.worker, target.directory)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for _, target := range targets {
		var cursor *string
		var names []string
		for {
			input := map[string]any{"limit": 1}
			if cursor != nil {
				input["cursor"] = *cursor
			}
			raw, _ := json.Marshal(input)
			request := ro.Request{RequestID: uuid.NewString(), Operation: "directory.list", Input: raw}
			response, err := f.request(ctx, target.worker, target.token, request)
			if err != nil {
				t.Fatal(err)
			}
			var message ro.Message
			err = json.NewDecoder(response.Body).Decode(&message)
			response.Body.Close()
			if err != nil || response.StatusCode != http.StatusOK || message.Error != nil {
				t.Fatalf("native directory response: status=%d error=%v message=%+v", response.StatusCode, err, message.Error)
			}
			if message.WorkerID != target.worker || message.OwnerUserID != target.owner || message.RequestID != request.RequestID {
				t.Fatal("native directory result was routed to a different owner or Worker")
			}
			var result ro.DirectoryResult
			if err = json.Unmarshal(message.Result, &result); err != nil {
				t.Fatal(err)
			}
			if result.Path != target.directory || len(result.Entries) != 1 {
				t.Fatalf("wrong native page: %+v", result)
			}
			entry := result.Entries[0]
			if entry.Path != filepath.Join(target.directory, entry.Name) {
				t.Fatal("entry path differs from the real target")
			}
			names = append(names, entry.Name)
			cursor = result.NextCursor
			if cursor == nil {
				break
			}
			if len(names) > 10 {
				t.Fatal("native pagination did not terminate")
			}
		}
		if !slices.Equal(names, target.names) {
			t.Fatalf("directory source mismatch: %v", names)
		}
	}
	for _, target := range targets {
		wrongToken := targets[0].token
		if wrongToken == target.token {
			wrongToken = targets[1].token
		}
		response, err := f.request(ctx, target.worker, wrongToken, ro.Request{RequestID: uuid.NewString(), Operation: "directory.list", Input: json.RawMessage(`{}`)})
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != http.StatusNotFound || strings.Contains(string(body), target.directory) {
			t.Fatalf("cross-owner Worker directory was exposed: %d", response.StatusCode)
		}
	}
	for file, before := range contents {
		after, err := os.ReadFile(file)
		if err != nil || sha256.Sum256(after) != before {
			t.Fatal("Worker browsing changed fixture file contents")
		}
	}
	t.Logf("native directory acceptance: platform=%s workers=2 owners=2 pages=6; target paths matched; cross-owner requests denied; file SHA-256 unchanged", runtime.GOOS)
}

func TestReadOnlyNativeWorkerEncodingAcceptance(t *testing.T) {
	f := newReadOnlyFixture(t)
	repository, err := filepath.Abs("../../../../..")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	fixture := filepath.Join(repository, "packages", "daynight", "test", "fixtures", "worker-readonly-encoding.mjs")
	cmd := exec.CommandContext(ctx, "node", fixture)
	cmd.Dir = repository
	cmd.WaitDelay = 2 * time.Second
	configuration, err := json.Marshal(map[string]string{"serverOrigin": f.server.URL, "serverToken": f.token, "ownerUserId": f.owner.UserID, "workerId": f.worker, "defaultCwd": t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stdin = bytes.NewReader(append(configuration, '\n'))
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("native Worker/Web encoding acceptance: %v\n%s", err, output)
	}
	t.Logf("native Worker/Web encoding acceptance: %s", output)
}
