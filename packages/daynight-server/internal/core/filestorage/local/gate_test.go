package local

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
)

func TestGateAcrossInstancesAndDomains(t *testing.T) {
	root := t.TempDir()
	a, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	permit, err := a.AcquireGate(t.Context(), filestorage.TargetGate, "same")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 100*time.Millisecond)
	defer cancel()
	if _, err := b.AcquireGate(ctx, filestorage.TargetGate, "same"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("another instance did not wait: %v", err)
	}
	if _, err := a.AcquireGate(ctx, filestorage.TargetGate, "same"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("same instance did not honor cancellation: %v", err)
	}
	private, err := b.AcquireGate(t.Context(), filestorage.PrivateGate, "same")
	if err != nil {
		t.Fatal(err)
	}
	if err := private.Close(); err != nil {
		t.Fatal(err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := b.AcquireGate(t.Context(), filestorage.TargetGate, "same")
	if err != nil {
		t.Fatal(err)
	}
	if err := next.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := a.Put(t.Context(), gateDirectory, "target-001", strings.NewReader("x")); !errors.Is(err, filestorage.ErrInvalidAddress) {
		t.Fatalf("ordinary objects can overwrite control locks: %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(root, gateDirectory))
	if err != nil || len(entries) != 2 {
		t.Fatalf("persistent gate files: %v %v", entries, err)
	}
	if _, err := a.AcquireGate(t.Context(), "wrong", "key"); err == nil {
		t.Fatal("invalid domain accepted")
	}
	if _, err := a.AcquireGate(t.Context(), filestorage.TargetGate, ""); err == nil {
		t.Fatal("empty key accepted")
	}
}

func TestGateAcrossProcesses(t *testing.T) {
	if root := os.Getenv("DAYNIGHT_GATE_TEST_ROOT"); root != "" {
		storage, err := New(root)
		if err != nil {
			t.Fatal(err)
		}
		defer storage.Close()
		fmt.Println("waiting")
		permit, err := storage.AcquireGate(t.Context(), filestorage.TargetGate, "shared")
		if err != nil {
			t.Fatal(err)
		}
		defer permit.Close()
		fmt.Println("acquired")
		return
	}
	root := t.TempDir()
	storage, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer storage.Close()
	permit, err := storage.AcquireGate(t.Context(), filestorage.TargetGate, "shared")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestGateAcrossProcesses$")
	cmd.Env = append(os.Environ(), "DAYNIGHT_GATE_TEST_ROOT="+root)
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	lines := make(chan string, 2)
	go func() {
		scanner := bufio.NewScanner(output)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
	}()
	select {
	case line := <-lines:
		if line != "waiting" {
			t.Fatalf("child: %q", line)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case line := <-lines:
		t.Fatalf("child acquired while held: %q", line)
	case <-time.After(100 * time.Millisecond):
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case line := <-lines:
		if line != "acquired" {
			t.Fatalf("child: %q", line)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
}
