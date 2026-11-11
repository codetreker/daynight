package logging

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestRotationAppendAndIdenticalJSON(t *testing.T) {
	root := t.TempDir()
	var stderr bytes.Buffer
	cfg := Config{MaxBytes: 120, Archives: 10}
	out, err := open(root, &stderr, nil, cfg, systemOperations)
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(out, nil))
	logger.Info("first", "value", "x")
	first := append([]byte(nil), stderr.Bytes()...)
	if err = out.Close(); err != nil {
		t.Fatal(err)
	}
	out, err = open(root, &stderr, nil, cfg, systemOperations)
	if err != nil {
		t.Fatal(err)
	}
	logger = slog.New(slog.NewJSONHandler(out, nil))
	logger.Info("second", "value", "y")
	if err = out.Close(); err != nil {
		t.Fatal(err)
	}
	active, err := os.ReadFile(filepath.Join(root, "logs", logName))
	if err != nil {
		t.Fatal(err)
	}
	archive, err := os.ReadFile(filepath.Join(root, "logs", logName+".1"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(archive, first) || !bytes.Equal(append(archive, active...), stderr.Bytes()) {
		t.Fatal("JSON bytes differ between sinks or restart did not append before rotation")
	}
	for _, name := range []string{logName, lockName} {
		info, err := os.Stat(filepath.Join(root, "logs", name))
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("%s: %v %v", name, info, err)
		}
	}
	info, err := os.Stat(filepath.Join(root, "logs"))
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("directory: %v %v", info, err)
	}
}

func TestRotationKeepsTenAndOversizeRecord(t *testing.T) {
	root := t.TempDir()
	var stderr bytes.Buffer
	out, err := open(root, &stderr, nil, Config{MaxBytes: 4, Archives: 10}, systemOperations)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 12; i++ {
		if _, err := out.Write([]byte{byte('a' + i), '\n'}); err != nil {
			t.Fatal(err)
		}
		if _, err := out.Write([]byte("XXXX")); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := out.Write([]byte("oversized-record")); err != nil {
		t.Fatal(err)
	}
	if _, err := out.Write([]byte("end")); err != nil {
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, "logs")
	got, err := os.ReadFile(filepath.Join(dir, logName+".1"))
	if err != nil || string(got) != "oversized-record" {
		t.Fatalf("oversize: %q %v", got, err)
	}
	for i := 1; i <= 10; i++ {
		if _, err := os.Stat(filepath.Join(dir, logName+"."+itoa(i))); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, logName+".11")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unexpected archive: %v", err)
	}
}

func itoa(n int) string { return strconv.Itoa(n) }

// The helper holds the actual operating-system lock in another process.
func TestLockProcessHelper(t *testing.T) {
	root := os.Getenv("LOGGING_HELPER_ROOT")
	if root == "" {
		return
	}
	out, err := Open(root, io.Discard, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = out.Write([]byte("before\n")); err != nil {
		t.Fatal(err)
	}
	println("ready")
	reader := bufio.NewReader(os.Stdin)
	if _, err = reader.ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	if _, err = out.Write([]byte("after\n")); err != nil {
		t.Fatal(err)
	}
	println("written")
	if _, err = reader.ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	if err = out.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestProcessLockReleaseAndKill(t *testing.T) {
	for _, kill := range []bool{false, true} {
		t.Run(map[bool]string{false: "release", true: "kill"}[kill], func(t *testing.T) {
			root := t.TempDir()
			if err := os.Mkdir(filepath.Join(root, "logs"), 0700); err != nil {
				t.Fatal(err)
			}
			archivePath := filepath.Join(root, "logs", logName+".1")
			if err := os.WriteFile(archivePath, []byte("previous"), 0600); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(os.Args[0], "-test.run=^TestLockProcessHelper$")
			cmd.Env = append(os.Environ(), "LOGGING_HELPER_ROOT="+root)
			in, err := cmd.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			stderr, err := cmd.StderrPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err = cmd.Start(); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
			lines := bufio.NewScanner(stderr)
			read := func(want string) {
				t.Helper()
				ch := make(chan string, 1)
				go func() {
					if lines.Scan() {
						ch <- lines.Text()
					} else {
						ch <- ""
					}
				}()
				select {
				case got := <-ch:
					if got != want {
						t.Fatalf("got %q want %q", got, want)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("helper timeout")
				}
			}
			read("ready")
			path := filepath.Join(root, "logs", logName)
			before, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			_, err = Open(root, io.Discard, nil)
			var failure *Error
			if !errors.As(err, &failure) || failure.Phase != "lock" || failure.Cause != "busy" {
				t.Fatalf("lock: %v", err)
			}
			after, err := os.ReadFile(path)
			archive, archiveErr := os.ReadFile(archivePath)
			if archiveErr != nil || string(archive) != "previous" {
				t.Fatalf("busy changed archive: %q %v", archive, archiveErr)
			}
			if err != nil || !bytes.Equal(before, after) {
				t.Fatalf("busy changed file: %q %v", after, err)
			}
			if _, err = in.Write([]byte("go\n")); err != nil {
				t.Fatal(err)
			}
			read("written")
			if kill {
				if err = cmd.Process.Kill(); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err = in.Write([]byte("exit\n")); err != nil {
					t.Fatal(err)
				}
			}
			_ = cmd.Wait()
			out, err := Open(root, io.Discard, nil)
			if err != nil {
				t.Fatal(err)
			}
			if err = out.Close(); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(path)
			if err != nil || string(got) != "before\nafter\n" {
				t.Fatalf("first owner failed: %q %v", got, err)
			}
		})
	}
}

type faultyWriter struct {
	err   error
	short bool
	calls int
}

func (w *faultyWriter) Write(p []byte) (int, error) {
	w.calls++
	if w.short {
		return 0, w.err
	}
	return len(p), w.err
}

type wrappedFile struct {
	file
	writeErr, statErr, closeErr error
	short                       bool
	closes                      int
}

func (f *wrappedFile) Write(p []byte) (int, error) {
	if f.writeErr != nil || f.short {
		if f.short {
			return 0, f.writeErr
		}
		return 0, f.writeErr
	}
	return f.file.Write(p)
}
func (f *wrappedFile) Stat() (os.FileInfo, error) {
	if f.statErr != nil {
		return nil, f.statErr
	}
	return f.file.Stat()
}
func (f *wrappedFile) Close() error { f.closes++; return errors.Join(f.file.Close(), f.closeErr) }

func TestFailuresTryBothLatchAndRetainCauses(t *testing.T) {
	for _, target := range []string{"stderr", "file", "both", "stat", "close"} {
		t.Run(target, func(t *testing.T) {
			root := t.TempDir()
			sentinel := errors.New("private path and secret")
			stderr := &faultyWriter{}
			ctx, cancel := context.WithCancelCause(context.Background())
			cancel(errors.New("signal"))
			ops := systemOperations
			var f *wrappedFile
			ops.open = func(name string, flags int, mode os.FileMode) (file, error) {
				raw, err := systemOperations.open(name, flags, mode)
				if err != nil {
					return nil, err
				}
				f = &wrappedFile{file: raw}
				return f, nil
			}
			out, err := open(root, stderr, cancel, DefaultConfig(), ops)
			if err != nil {
				t.Fatal(err)
			}
			if target == "stderr" || target == "both" {
				stderr.short = true
				stderr.err = sentinel
			}
			if target == "file" || target == "both" {
				f.short = true
				f.writeErr = sentinel
			}
			if target == "stat" {
				f.statErr = sentinel
			}
			if target == "close" {
				f.closeErr = sentinel
			}
			_, err = out.Write([]byte("hello"))
			if target != "close" {
				if !errors.Is(err, sentinel) || !errors.Is(out.Err(), sentinel) {
					t.Fatalf("missing cause: %v / %v", err, out.Err())
				}
				if target != "stat" && !errors.Is(err, io.ErrShortWrite) {
					t.Fatalf("missing short write: %v", err)
				}
				if strings.Contains(err.Error(), "private") {
					t.Fatalf("unsafe error: %v", err)
				}
				if stderr.calls != 1 {
					t.Fatal("stderr not attempted")
				}
				if target == "stderr" {
					data, e := os.ReadFile(filepath.Join(root, "logs", logName))
					if e != nil || string(data) != "hello" {
						t.Fatalf("file not attempted: %q %v", data, e)
					}
				}
				if context.Cause(ctx).Error() != "signal" {
					t.Fatal("changed earlier signal")
				}
			}
			closeErr := out.Close()
			if target == "close" && (!errors.Is(closeErr, sentinel) || !errors.Is(out.Err(), sentinel)) {
				t.Fatalf("close missing: %v", closeErr)
			}
			other, e := Open(root, io.Discard, nil)
			if e != nil {
				t.Fatalf("lock not released: %v", e)
			}
			_ = other.Close()
		})
	}
}

func TestRotationFailureIsSticky(t *testing.T) {
	for _, op := range []string{"close", "remove", "rename", "open"} {
		t.Run(op, func(t *testing.T) {
			root := t.TempDir()
			var stderr bytes.Buffer
			sentinel := errors.New("injected")
			ops := systemOperations
			var f *wrappedFile
			opens, calls := 0, 0
			ops.open = func(name string, flags int, mode os.FileMode) (file, error) {
				opens++
				if op == "open" && opens > 1 {
					calls++
					return nil, sentinel
				}
				raw, err := systemOperations.open(name, flags, mode)
				if err != nil {
					return nil, err
				}
				f = &wrappedFile{file: raw}
				if op == "close" {
					f.closeErr = sentinel
				}
				return f, nil
			}
			ops.remove = func(name string) error {
				if op == "remove" {
					calls++
					return sentinel
				}
				return systemOperations.remove(name)
			}
			ops.rename = func(from, to string) error {
				if op == "rename" {
					calls++
					return sentinel
				}
				return systemOperations.rename(from, to)
			}
			out, err := open(root, &stderr, nil, Config{MaxBytes: 1, Archives: 2}, ops)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = out.Write([]byte("a")); err != nil {
				t.Fatal(err)
			}
			if _, err = out.Write([]byte("b")); !errors.Is(err, sentinel) {
				t.Fatalf("rotation: %v", err)
			}
			prior := calls
			if _, err = out.Write([]byte("c")); !errors.Is(err, sentinel) {
				t.Fatalf("sticky: %v", err)
			}
			if calls != prior || stderr.String() != "abc" {
				t.Fatalf("repeated rotation or missing stderr: %d %d %q", calls, prior, stderr.String())
			}
			if f.closes != 1 {
				t.Fatalf("active close calls %d", f.closes)
			}
			if err = out.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestInvalidAndOpenFailure(t *testing.T) {
	if (Config{}).Validate() == nil {
		t.Fatal("invalid config accepted")
	}
	if _, err := Open(t.TempDir(), nil, nil); err == nil {
		t.Fatal("nil stderr accepted")
	}
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "logs"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(root, io.Discard, nil); err == nil {
		t.Fatal("directory failure accepted")
	}
	root = t.TempDir()
	sentinel := errors.New("open")
	ops := systemOperations
	ops.open = func(string, int, os.FileMode) (file, error) { return nil, sentinel }
	if _, err := open(root, io.Discard, nil, DefaultConfig(), ops); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	out, err := Open(root, io.Discard, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = out.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAppendAndArchiveOrder(t *testing.T) {
	root := t.TempDir()
	cfg := Config{MaxBytes: 2, Archives: 3}
	out, err := open(root, io.Discard, nil, cfg, systemOperations)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = out.Write([]byte("a")); err != nil {
		t.Fatal(err)
	}
	if err = out.Close(); err != nil {
		t.Fatal(err)
	}
	out, err = open(root, io.Discard, nil, cfg, systemOperations)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range []string{"b", "c", "d", "e", "f", "g", "h", "i"} {
		if _, err = out.Write([]byte(record)); err != nil {
			t.Fatal(err)
		}
	}
	if err = out.Close(); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{logName: "i", logName + ".1": "gh", logName + ".2": "ef", logName + ".3": "cd"} {
		got, err := os.ReadFile(filepath.Join(root, "logs", name))
		if err != nil || string(got) != want {
			t.Errorf("%s: %q, want %q: %v", name, got, want, err)
		}
	}
}

func TestFailureCancelsOnceAndCloseIsIdempotent(t *testing.T) {
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	stderr := &faultyWriter{short: true}
	out, err := Open(t.TempDir(), stderr, cancel)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = out.Write([]byte("first")); !errors.Is(err, io.ErrShortWrite) {
		t.Fatal(err)
	}
	first := out.Err()
	if !errors.Is(context.Cause(ctx), io.ErrShortWrite) {
		t.Fatalf("no cancellation cause: %v", context.Cause(ctx))
	}
	stderr.err = errors.New("later")
	if _, err = out.Write([]byte("second")); err == nil {
		t.Fatal("expected later error")
	}
	if out.Err() != first {
		t.Fatal("first error replaced")
	}
	if err = out.Close(); err != nil {
		t.Fatal(err)
	}
	if err = out.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err = out.Write([]byte("after close")); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("write after close: %v", err)
	}
}

func TestRootSymlinkParentTraversalUsesSameProcessLock(t *testing.T) {
	base := t.TempDir()
	physicalRoot := filepath.Join(base, "physical", "instance")
	child := filepath.Join(base, "physical", "child")
	lexicalRoot := filepath.Join(base, "lexical", "instance")
	for _, dir := range []string{physicalRoot, child, lexicalRoot} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(child, filepath.Join(base, "lexical", "link")); err != nil {
		t.Fatal(err)
	}
	// filepath.Join would erase the parent component before the kernel follows link.
	root := filepath.Join(base, "lexical", "link") + "/../instance"
	cmd := exec.Command(os.Args[0], "-test.run=^TestLockProcessHelper$")
	cmd.Env = append(os.Environ(), "LOGGING_HELPER_ROOT="+root)
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	lines := bufio.NewScanner(stderr)
	read := func(want string) {
		t.Helper()
		ch := make(chan string, 1)
		go func() {
			if lines.Scan() {
				ch <- lines.Text()
			} else {
				ch <- ""
			}
		}()
		select {
		case got := <-ch:
			if got != want {
				t.Fatalf("got %q want %q", got, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("helper timeout")
		}
	}
	read("ready")
	actual := filepath.Join(physicalRoot, "logs", logName)
	before, err := os.ReadFile(actual)
	if err != nil || string(before) != "before\n" {
		t.Fatalf("actual root: %q %v", before, err)
	}
	if _, err = os.Stat(filepath.Join(lexicalRoot, "logs")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("lexically cleaned root used: %v", err)
	}
	_, err = Open(physicalRoot, io.Discard, nil)
	var detail *Error
	if !errors.As(err, &detail) || detail.Phase != "lock" || detail.Cause != "busy" {
		t.Fatalf("same actual root did not contend: %v", err)
	}
	if _, err = in.Write([]byte("go\n")); err != nil {
		t.Fatal(err)
	}
	read("written")
	if _, err = in.Write([]byte("exit\n")); err != nil {
		t.Fatal(err)
	}
	if err = cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	out, err := Open(physicalRoot, io.Discard, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = out.Close(); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(actual)
	if err != nil || string(got) != "before\nafter\n" {
		t.Fatalf("owner did not continue: %q %v", got, err)
	}
}
