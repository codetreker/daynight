//go:build startupshutdown

package main

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"
)

// startMetricsProcess leaves readiness to the caller, which discovers actual
// ephemeral addresses from the lifecycle events emitted by the process.
func startMetricsProcess(t *testing.T, values map[string]string) *persistenceProcess {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestPersistenceProcessHelper$")
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(key, "DAYNIGHT_") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	for key, value := range values {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	cmd.Env = append(cmd.Env, "DAYNIGHT_PERSISTENCE_PROCESS_HELPER=1", "DAYNIGHT_TEST_ROOT="+testStorageRoot(t))
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
				t.Errorf("cleanup server: %v", err)
			}
		}
	})
	return process
}

func listeningAddresses(logs string) map[string]string {
	addresses := make(map[string]string)
	for _, line := range strings.Split(logs, "\n") {
		var event struct {
			Component string `json:"component"`
			Phase     string `json:"phase"`
			Address   string `json:"address"`
		}
		if json.Unmarshal([]byte(line), &event) == nil && event.Phase == "listening" {
			addresses[event.Component] = event.Address
		}
	}
	return addresses
}

func waitListening(t *testing.T, p *persistenceProcess, count int) map[string]string {
	t.Helper()
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		addresses := listeningAddresses(p.logs.String())
		if len(addresses) >= count {
			return addresses
		}
		select {
		case err := <-p.finished:
			p.stopped = true
			t.Fatalf("server exited before listening: %v: %s", err, p.logs.String())
		case <-deadline.C:
			t.Fatalf("server did not listen: %s", p.logs.String())
		case <-ticker.C:
		}
	}
}

func TestMetricsProcessLifecycle(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		t.Run(map[bool]string{false: "disabled", true: "enabled"}[enabled], func(t *testing.T) {
			values := processAPIEnvironmentAt(t, "127.0.0.1:0")
			values["DAYNIGHT_PUBLIC_ORIGIN"] = "http://127.0.0.1:8787"
			values["DAYNIGHT_UNIAUTH_CALLBACK_URL"] = values["DAYNIGHT_PUBLIC_ORIGIN"] + "/api/v1/auth/callback"
			values["DAYNIGHT_METRICS_LISTEN_ADDR"] = ""
			if enabled {
				values["DAYNIGHT_METRICS_LISTEN_ADDR"] = "127.0.0.1:0"
			}
			p := startMetricsProcess(t, values)
			count := 1
			if enabled {
				count = 2
			}
			addresses := waitListening(t, p, count)
			business := addresses["server"]
			if business == "" {
				t.Fatalf("missing business address: %v", addresses)
			}
			client := &http.Client{Timeout: 5 * time.Second}
			defer client.CloseIdleConnections()
			response, err := client.Get("http://" + business + "/metrics")
			if err != nil {
				t.Fatal(err)
			}
			_ = response.Body.Close()
			if response.StatusCode != http.StatusNotFound {
				t.Fatalf("business /metrics: %s", response.Status)
			}
			if enabled {
				metrics := addresses["metrics"]
				if metrics == "" || metrics == business {
					t.Fatalf("independent address missing: %v", addresses)
				}
				response, err = client.Get("http://" + metrics + "/metrics")
				if err != nil {
					t.Fatal(err)
				}
				if response.StatusCode != http.StatusOK {
					_ = response.Body.Close()
					t.Fatalf("scrape: %s", response.Status)
				}
				decoder := expfmt.NewDecoder(response.Body, expfmt.ResponseFormat(response.Header))
				families := map[string]bool{}
				for {
					var family dto.MetricFamily
					err := decoder.Decode(&family)
					if errors.Is(err, io.EOF) {
						break
					}
					if err != nil {
						_ = response.Body.Close()
						t.Fatalf("parse metrics: %v", err)
					}
					families[family.GetName()] = true
				}
				if err := response.Body.Close(); err != nil {
					t.Fatal(err)
				}
				for _, name := range []string{"go_goroutines", "go_gc_duration_seconds", "go_memstats_alloc_bytes", "process_cpu_seconds_total", "process_resident_memory_bytes", "process_start_time_seconds", "process_open_fds"} {
					if !families[name] {
						t.Errorf("missing metric %s", name)
					}
				}
			} else if addresses["metrics"] != "" {
				t.Fatalf("disabled metrics listener: %v", addresses)
			}
			if err := p.stop(); err != nil {
				t.Fatalf("shutdown: %v: %s", err, p.logs.String())
			}
			for _, address := range addresses {
				listener, err := net.Listen("tcp", address)
				if err != nil {
					t.Errorf("listener %s not released: %v", address, err)
					continue
				}
				_ = listener.Close()
			}
		})
	}
}

func TestMetricsProcessBindFailure(t *testing.T) {
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	values := processAPIEnvironmentAt(t, "127.0.0.1:0")
	values["DAYNIGHT_PUBLIC_ORIGIN"] = "http://127.0.0.1:8787"
	values["DAYNIGHT_UNIAUTH_CALLBACK_URL"] = values["DAYNIGHT_PUBLIC_ORIGIN"] + "/api/v1/auth/callback"
	values["DAYNIGHT_METRICS_LISTEN_ADDR"] = occupied.Addr().String()
	p := startMetricsProcess(t, values)
	select {
	case err := <-p.finished:
		p.stopped = true
		var exit *exec.ExitError
		if !errors.As(err, &exit) || exit.ExitCode() != 1 {
			t.Fatalf("bind failure exit: %v: %s", err, p.logs.String())
		}
		if !strings.Contains(p.logs.String(), `"component":"metrics"`) || !strings.Contains(p.logs.String(), `"phase":"listen"`) {
			t.Fatalf("missing bind diagnostic: %s", p.logs.String())
		}
	case <-time.After(30 * time.Second):
		t.Fatal("server did not exit after metrics bind failure")
	}
}
