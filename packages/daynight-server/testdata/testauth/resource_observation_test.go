//go:build linux

package testauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestGatewayResourceObservation(t *testing.T) {
	var events []GatewayResources
	fixture := StartGatewayWithResources(t, "http://127.0.0.1:8787/api/v1/auth/callback", func() bool { return true }, func(resource GatewayResources) error {
		events = append(events, resource)
		if resource.State == "prepared" {
			if resource.PID != 0 {
				t.Fatal("prepared gateway already has a process")
			}
			if _, err := os.Stat(resource.Directory); err != nil {
				return err
			}
		}
		return nil
	})
	if len(events) != 2 || events[0].State != "prepared" || events[1].State != "started" || events[0].Directory != fixture.directory || events[1].Directory != fixture.directory || events[1].PID != fixture.command.Process.Pid {
		t.Fatalf("gateway ownership transitions differ: %+v", events)
	}
}

func TestGatewayResourceCallbackFailureHelper(t *testing.T) {
	phase := os.Getenv("DAYNIGHT_RESOURCE_CALLBACK_FAILURE_PHASE")
	if phase == "" {
		return
	}
	StartGatewayWithResources(t, "http://127.0.0.1:8787/api/v1/auth/callback", func() bool { return true }, func(resource GatewayResources) error {
		data, err := json.Marshal(resource)
		if err != nil {
			return err
		}
		if err := os.WriteFile(os.Getenv("DAYNIGHT_RESOURCE_CALLBACK_RECEIPT"), data, 0o600); err != nil {
			return err
		}
		if resource.State == phase {
			return errors.New("resource-receipt-write-failure")
		}
		return nil
	})
	t.Fatal("expected resource callback failure")
}

func TestGatewayResourceCallbackFailureCleansOwnedResources(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, phase := range []string{"prepared", "started"} {
		t.Run(phase, func(t *testing.T) {
			path := filepath.Join(Directory(t), "ownership.json")
			ctx, cancel := context.WithTimeout(t.Context(), 25*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, executable, "-test.run=^TestGatewayResourceCallbackFailureHelper$", "-test.timeout=20s")
			command.Env = append(os.Environ(), "DAYNIGHT_RESOURCE_CALLBACK_FAILURE_PHASE="+phase, "DAYNIGHT_RESOURCE_CALLBACK_RECEIPT="+path)
			var output bytes.Buffer
			stream := io.MultiWriter(os.Stdout, &output)
			command.Stdout, command.Stderr = stream, stream
			runErr := command.Run()
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var receipt GatewayResources
			if err := json.Unmarshal(data, &receipt); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { cleanupObservedGateway(t, receipt, filepath.Dir(filepath.Dir(path))) })
			var exit *exec.ExitError
			if !errors.As(runErr, &exit) || !strings.Contains(output.String(), "resource-receipt-write-failure") {
				t.Fatalf("resource callback failure was not propagated: %v %s", runErr, &output)
			}
			if receipt.State != phase {
				t.Fatalf("observed wrong callback phase: %+v", receipt)
			}
			if _, err := os.Stat(receipt.Directory); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("callback failure retained its gateway directory: %v", err)
			}
			if phase == "started" {
				if current, err := os.Readlink(filepath.Join("/proc", strconv.Itoa(receipt.PID), "exe")); err == nil && current == os.Getenv("DAYNIGHT_TEST_UNIAUTH_FIXTURE") {
					t.Fatal("callback failure left the UniAuth process alive")
				}
			}
		})
	}
}

func cleanupObservedGateway(t *testing.T, receipt GatewayResources, parent string) {
	t.Helper()
	if filepath.Dir(receipt.Directory) != parent || !strings.HasPrefix(filepath.Base(receipt.Directory), "gateway-") {
		t.Error("refusing an authentication cleanup path outside its resource owner")
		return
	}
	if receipt.PID > 0 {
		path := filepath.Join("/proc", strconv.Itoa(receipt.PID), "environ")
		data, err := os.ReadFile(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			t.Error(err)
			return
		}
		marker := []byte("DAYNIGHT_FIXTURE_DATABASE_PATH=" + filepath.Join(receipt.Directory, "apps.db") + "\x00")
		if bytes.Contains(data, marker) {
			process, err := os.FindProcess(receipt.PID)
			if err != nil {
				t.Error(err)
				return
			}
			if err := process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
				t.Error(err)
				return
			}
			deadline := time.Now().Add(3 * time.Second)
			for {
				data, err = os.ReadFile(path)
				if errors.Is(err, os.ErrNotExist) || err == nil && !bytes.Contains(data, marker) {
					break
				}
				if err != nil || !time.Now().Before(deadline) {
					t.Error("authentication callback child termination is unconfirmed")
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
		}
	}
	if err := os.RemoveAll(receipt.Directory); err != nil {
		t.Error(err)
	}
}
