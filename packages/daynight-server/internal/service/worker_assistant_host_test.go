package service

import (
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"strings"
	"testing"
	"time"
)

func TestWorkerAssistantHostValidationRejectsUnknownProtocol(t *testing.T) {
	report := validWorkerReportForValidation()
	if err := json.Unmarshal([]byte(`{"assistantHost":{"protocolVersion":2,"observedAt":"2026-11-04T12:00:00Z","defaultCwd":"/workspace","defaultProvider":"copilot","providers":[]}}`), &report.Telemetry); err != nil {
		t.Fatal(err)
	}
	if _, err := validateWorkerReport(report); err == nil {
		t.Fatal("unsupported assistant host protocol accepted")
	}
}

func validAssistantHost() *model.WorkerAssistantHost {
	return &model.WorkerAssistantHost{ProtocolVersion: 1, ObservedAt: time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC), DefaultCwd: "/workspace", DefaultProvider: model.AgentCopilot, Providers: []model.WorkerAssistantProvider{
		{Provider: model.AgentCodex, Available: true, Args: []string{}},
		{Provider: model.AgentClaude, Reason: workerValidationValue("not_found"), Args: []string{}},
		{Provider: model.AgentCopilot, Available: true, Model: workerValidationValue("gpt-5"), Args: []string{"--effort", "high"}},
	}}
}

func TestWorkerAssistantHostDomainValidation(t *testing.T) {
	report := validWorkerReportForValidation()
	report.TaskInventory = nil
	report.Telemetry.AssistantHost = validAssistantHost()
	if _, err := validateWorkerReport(report); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(*model.WorkerAssistantHost){
		"protocol":              func(h *model.WorkerAssistantHost) { h.ProtocolVersion = 2 },
		"time":                  func(h *model.WorkerAssistantHost) { h.ObservedAt = time.Time{} },
		"default provider":      func(h *model.WorkerAssistantHost) { h.DefaultProvider = "unknown" },
		"relative directory":    func(h *model.WorkerAssistantHost) { h.DefaultCwd = "workspace" },
		"control directory":     func(h *model.WorkerAssistantHost) { h.DefaultCwd = "/work\nspace" },
		"large directory":       func(h *model.WorkerAssistantHost) { h.DefaultCwd = "/" + strings.Repeat("x", 4096) },
		"missing provider":      func(h *model.WorkerAssistantHost) { h.Providers = h.Providers[:2] },
		"unknown provider":      func(h *model.WorkerAssistantHost) { h.Providers[0].Provider = "unknown" },
		"duplicate provider":    func(h *model.WorkerAssistantHost) { h.Providers[0].Provider = model.AgentCopilot },
		"available reason":      func(h *model.WorkerAssistantHost) { h.Providers[0].Reason = workerValidationValue("timeout") },
		"unavailable no reason": func(h *model.WorkerAssistantHost) { h.Providers[1].Reason = nil },
		"unknown reason":        func(h *model.WorkerAssistantHost) { h.Providers[1].Reason = workerValidationValue("credential-secret") },
		"blank model":           func(h *model.WorkerAssistantHost) { h.Providers[0].Model = workerValidationValue(" ") },
		"large model": func(h *model.WorkerAssistantHost) {
			h.Providers[0].Model = workerValidationValue(strings.Repeat("x", 257))
		},
		"nil args":              func(h *model.WorkerAssistantHost) { h.Providers[0].Args = nil },
		"large args":            func(h *model.WorkerAssistantHost) { h.Providers[0].Args = make([]string, 129) },
		"blank argument":        func(h *model.WorkerAssistantHost) { h.Providers[0].Args = []string{""} },
		"invalid UTF8 argument": func(h *model.WorkerAssistantHost) { h.Providers[0].Args = []string{string([]byte{255})} },
		"large argument":        func(h *model.WorkerAssistantHost) { h.Providers[0].Args = []string{strings.Repeat("x", 4097)} },
		"unsupported configuration": func(h *model.WorkerAssistantHost) {
			h.Providers[1].Reason = workerValidationValue("unsupported_arguments")
			h.Providers[1].Args = []string{"--token", "secret"}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			report.Telemetry.AssistantHost = validAssistantHost()
			mutate(report.Telemetry.AssistantHost)
			if _, err := validateWorkerReport(report); err == nil {
				t.Fatal("invalid assistant host accepted")
			}
		})
	}
	for _, path := range []string{`C:\work`, `c:/work`, `\\server\share\work`} {
		report.Telemetry.AssistantHost = validAssistantHost()
		report.Telemetry.Platform = model.PlatformWindows
		report.Telemetry.AssistantHost.DefaultCwd = path
		if _, err := validateWorkerReport(report); err != nil {
			t.Fatal(path, err)
		}
	}
	for _, path := range []string{`C:work`, `/work`, `\work`, `\\server`, `\\server\`, `\\?\C:\work`, `1:/work`} {
		report.Telemetry.AssistantHost = validAssistantHost()
		report.Telemetry.AssistantHost.DefaultCwd = path
		if _, err := validateWorkerReport(report); err == nil {
			t.Fatal("invalid Windows absolute path", path)
		}
	}
}

func TestWorkerAssistantHostStateKeepsLivenessAndPreflightSeparate(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name                string
		host                bool
		reportAge, probeAge time.Duration
		fail                bool
		want                string
	}{
		{name: "legacy", want: "unsupported"},
		{name: "fresh", host: true, want: "available"},
		{name: "offline boundary", host: true, reportAge: 120 * time.Second, want: "offline"},
		{name: "future report", host: true, reportAge: -time.Second, want: "offline"},
		{name: "old probe", host: true, probeAge: 120 * time.Second, want: "stale"},
		{name: "future probe", host: true, probeAge: -time.Second, want: "stale"},
		{name: "failed preflight", host: true, fail: true, want: "unavailable"},
		{name: "inside boundary", host: true, reportAge: 119 * time.Second, probeAge: 119 * time.Second, want: "available"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			worker := model.WorkerSnapshot{LastReportedAt: now.Add(-tc.reportAge)}
			if tc.host {
				worker.Telemetry.AssistantHost = validAssistantHost()
				worker.Telemetry.AssistantHost.ObservedAt = now.Add(-tc.probeAge)
				if tc.fail {
					for i := range worker.Telemetry.AssistantHost.Providers {
						worker.Telemetry.AssistantHost.Providers[i].Available = false
						worker.Telemetry.AssistantHost.Providers[i].Reason = workerValidationValue("unavailable")
					}
				}
			}
			if got := WorkerAssistantHostState(worker, now); got != tc.want {
				t.Fatalf("got %s, want %s", got, tc.want)
			}
		})
	}
}
