//go:build linux

package local

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	"github.com/google/uuid"
)

// This helper owns an actual locked directory in a separate process. The parent
// kills it without closing its descriptors to exercise kernel lock release.
func TestArchiveStagingProcessHelper(t *testing.T) {
	if os.Getenv("DAYNIGHT_STAGING_HELPER") != "1" {
		return
	}
	root, owner, session, file := os.Getenv("DAYNIGHT_STAGING_ROOT"), os.Getenv("DAYNIGHT_STAGING_OWNER"), os.Getenv("DAYNIGHT_STAGING_SESSION"), os.Getenv("DAYNIGHT_STAGING_FILE")
	n, err := sessionarchive.NewNamespace(sessionarchive.Users, owner, session)
	if err != nil {
		t.Fatal(err)
	}
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.EnableArchiveStaging(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	guard, err := s.AcquireArchiveStaging(context.Background(), n, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := guard.Create(context.Background(), file); err != nil {
		t.Fatal(err)
	}
	block := bytes.Repeat([]byte{0x41}, 512*1024)
	if offset, err := guard.Append(context.Background(), file, int64(len(block)+100), 0, block); err != nil || offset != int64(len(block)) {
		t.Fatalf("append offset=%d err=%v", offset, err)
	}
	fmt.Println("STAGING_READY")
	time.Sleep(time.Hour)
	t.Fatal("helper was not stopped")
}

func TestArchiveStagingAcrossProcessesAndCrash(t *testing.T) {
	volume, err := filepath.Abs(filepath.Join("..", "..", "..", "..", ".tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(volume, 0o700); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(volume, "archive-process-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	owner, session, file := uuid.NewString(), uuid.NewString(), uuid.NewString()
	n, err := sessionarchive.NewNamespace(sessionarchive.Users, owner, session)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if p, err := s.AcquireArchiveStaging(ctx, n, true); !errors.Is(err, ErrArchiveVolumeUnverified) {
		if p != nil {
			_ = p.Close()
		}
		t.Fatalf("unverified volume accepted staging: %v", err)
	}
	if err := s.EnableArchiveStaging(ctx, true); err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestArchiveStagingProcessHelper$")
	cmd.Env = append(os.Environ(), "DAYNIGHT_STAGING_HELPER=1", "DAYNIGHT_STAGING_ROOT="+root, "DAYNIGHT_STAGING_OWNER="+owner, "DAYNIGHT_STAGING_SESSION="+session, "DAYNIGHT_STAGING_FILE="+file)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	wait := make(chan error, 1)
	go func() { wait <- cmd.Wait() }()
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = cmd.Process.Kill()
			<-wait
		}
	})
	ready := make(chan string, 1)
	go func() { line, _ := bufio.NewReader(stdout).ReadString('\n'); ready <- line }()
	select {
	case line := <-ready:
		if strings.TrimSpace(line) != "STAGING_READY" {
			t.Fatalf("helper readiness %q: %s", line, stderr.String())
		}
	case err := <-wait:
		t.Fatalf("helper exited before readiness: %v: %s", err, stderr.String())
	case <-ctx.Done():
		t.Fatal("helper did not reach lock barrier")
	}
	if p, err := s.AcquireArchiveStaging(ctx, n, true); !errors.Is(err, filestorage.ErrGateBusy) {
		if p != nil {
			_ = p.Close()
		}
		t.Fatalf("active writer did not exclude other process: %v", err)
	}
	if err := s.DeleteSessionArchives(ctx, n); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("cleanup did not retain active namespace: %v", err)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := <-wait; err == nil {
		t.Fatal("helper unexpectedly exited successfully")
	}
	guard, err := s.AcquireArchiveStaging(ctx, n, false)
	if err != nil {
		t.Fatalf("lock remained after process death: %v", err)
	}
	const block = 512 * 1024
	total := int64(block + 100)
	if offset, err := guard.Observe(ctx, file, total); err != nil || offset != block {
		t.Fatalf("durable offset after crash = %d, %v", offset, err)
	}
	// Simulate a disk tail from interruption during an append, which is not an
	// acknowledged recovery point even when the file survived the crash.
	path := filepath.Join(root, "session-archives", filepath.FromSlash(n.Directory()), ".staging", file)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(bytes.Repeat([]byte{0x7f}, 37)); err != nil {
		t.Fatal(err)
	}
	if err := errors.Join(f.Sync(), f.Close()); err != nil {
		t.Fatal(err)
	}
	if offset, err := guard.Observe(ctx, file, total); err != nil || offset != block {
		t.Fatalf("partial tail recovery = %d, %v", offset, err)
	}
	final := bytes.Repeat([]byte{0x42}, 100)
	if offset, err := guard.Append(ctx, file, total, block, final); err != nil || offset != total {
		t.Fatalf("resume offset=%d err=%v", offset, err)
	}
	object, err := guard.Open(ctx, file, total)
	if err != nil {
		t.Fatal(err)
	}
	if err := guard.Close(); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("guard closed while reader open: %v", err)
	}
	if err := s.DeleteSessionArchives(ctx, n); !errors.Is(err, filestorage.ErrGateBusy) {
		t.Fatalf("cleanup passed open reader: %v", err)
	}
	got, err := io.ReadAll(object.Body)
	if err != nil {
		t.Fatal(err)
	}
	if err := object.Body.Close(); err != nil {
		t.Fatal(err)
	}
	want := append(bytes.Repeat([]byte{0x41}, block), final...)
	if !bytes.Equal(got, want) {
		t.Fatal("resumed file includes uncommitted tail or differs from acknowledged bytes")
	}
	if err := guard.Close(); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteSessionArchives(ctx, n); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("namespace survived cleanup: %v", err)
	}
}

// Run separately on a real unsupported mount selected by the operator. This
// does not claim that a local filesystem test proves a shared topology.
func TestArchiveStagingUnsupportedMountedVolume(t *testing.T) {
	parent := os.Getenv("DAYNIGHT_TEST_ARCHIVE_UNSUPPORTED_ROOT")
	if parent == "" {
		t.Skip("set DAYNIGHT_TEST_ARCHIVE_UNSUPPORTED_ROOT to an unsupported mount")
	}
	root, err := os.MkdirTemp(parent, "daynight-archive-volume-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err := s.EnableArchiveStaging(t.Context(), true); !errors.Is(err, ErrArchiveVolumeUnverified) {
		t.Fatalf("unsupported volume enabled: %v", err)
	}
	n, err := sessionarchive.NewNamespace(sessionarchive.Users, uuid.NewString(), uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if guard, err := s.AcquireArchiveStaging(t.Context(), n, true); !errors.Is(err, ErrArchiveVolumeUnverified) {
		if guard != nil {
			_ = guard.Close()
		}
		t.Fatalf("unsupported volume accepted staging: %v", err)
	}
}
