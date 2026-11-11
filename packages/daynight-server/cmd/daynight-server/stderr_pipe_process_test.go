//go:build startupshutdown

package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestClosedStderrProcessHelper(t *testing.T) {
	if os.Getenv("DAYNIGHT_CLOSED_STDERR_HELPER") == "" {
		return
	}
	if _, err := bufio.NewReader(os.Stdin).ReadString('\n'); err != nil {
		os.Exit(10)
	}
	os.Args = []string{"daynight-server", "--root", os.Getenv("DAYNIGHT_TEST_ROOT")}
	main()
}

func TestClosedStderrPipeStopsServiceAfterFileWrite(t *testing.T) {
	root := testStorageRoot(t)
	values := processAPIEnvironment(t)
	cmd := exec.Command(os.Args[0], "-test.run=^TestClosedStderrProcessHelper$")
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(key, "DAYNIGHT_") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	for key, value := range values {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	cmd.Env = append(cmd.Env, "DAYNIGHT_CLOSED_STDERR_HELPER=1", "DAYNIGHT_TEST_ROOT="+root)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stdout = io.Discard
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- cmd.Wait() }()
	reaped := false
	t.Cleanup(func() {
		_ = stderr.Close()
		_ = stdin.Close()
		if !reaped {
			_ = cmd.Process.Kill()
			select {
			case <-finished:
			case <-time.After(5 * time.Second):
				t.Error("process was not reaped")
			}
		}
	})
	readerDone := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, stderr); close(readerDone) }()
	if _, err = stdin.Write([]byte("start\n")); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Timeout: time.Second}
	defer client.CloseIdleConnections()
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	readyID := rand.Text()
	for {
		ready, err := http.NewRequest(http.MethodGet, values["DAYNIGHT_PUBLIC_ORIGIN"]+"/readyz", nil)
		if err != nil {
			t.Fatal(err)
		}
		ready.Header.Set("X-Request-ID", readyID)
		response, requestErr := client.Do(ready)
		if requestErr == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				break
			}
		}
		select {
		case err = <-finished:
			reaped = true
			t.Fatalf("process exited before readiness: %v", err)
		case <-deadline.C:
			t.Fatal("process did not become ready")
		case <-ticker.C:
		}
	}
	// Wait for the readiness request's log so its write cannot race the pipe closure.
	for {
		data, err := os.ReadFile(filepath.Join(root, "logs", "daynight-server.log"))
		if err == nil && bytes.Contains(data, []byte(readyID)) {
			break
		}
		select {
		case err = <-finished:
			reaped = true
			t.Fatalf("process exited before readiness log: %v", err)
		case <-deadline.C:
			t.Fatal("readiness log did not complete")
		case <-ticker.C:
		}
	}
	// Close the only read end before sending a request that causes a log write.
	if err = stderr.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-readerDone:
	case <-time.After(5 * time.Second):
		t.Fatal("stderr reader did not stop")
	}
	id := rand.Text()
	req, err := http.NewRequest(http.MethodGet, values["DAYNIGHT_PUBLIC_ORIGIN"]+"/readyz", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Request-ID", id)
	response, _ := client.Do(req)
	if response != nil {
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
	}
	select {
	case err = <-finished:
		reaped = true
	case <-time.After(20 * time.Second):
		t.Fatal("process failed to stop after stderr pipe closed")
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 1 {
		t.Fatalf("expected controlled exit 1, got %v", err)
	}
	data, err := os.ReadFile(filepath.Join(root, "logs", "daynight-server.log"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(data, []byte(id)) || !bytes.Contains(data, []byte(`"phase":"stopped"`)) {
		t.Fatalf("file did not record request and completed shutdown: %s", data)
	}
}
