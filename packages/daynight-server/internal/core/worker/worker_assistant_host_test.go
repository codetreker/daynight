package worker

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestWorkerAssistantHostValidationRejectsUnknownProtocol(t *testing.T) {
	report := validWorkerReportForValidation()
	if err := json.Unmarshal([]byte(`{"assistantHost":{"protocolVersion":2,"observedAt":"2026-11-04T12:00:00Z","defaultCwd":"/workspace","defaultProvider":"copilot","providers":[]}}`), &report.Telemetry); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateReport(report); err == nil {
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

func TestWorkerAssistantHostReportValidationAndSnapshot(t *testing.T) {
	const userID = "11111111-1111-4111-8111-111111111111"
	const workerID = "22222222-2222-4222-8222-222222222222"
	newReport := func() model.WorkerReport {
		report := validWorkerReportForValidation()
		report.Telemetry.Machine = model.WorkerMachine{ID: "33333333-3333-4333-8333-333333333333", Name: "Private worker machine"}
		report.Telemetry.WorkingDirectory = "/private/work"
		report.Telemetry.AssistantHost = validAssistantHost()
		return report
	}
	for _, tc := range []struct {
		name    string
		prepare func(*model.WorkerReport)
		invalid bool
	}{
		{name: "successful host", prepare: func(report *model.WorkerReport) {
			report.Telemetry.AssistantHost.DefaultCwd = "/private/assistant-host-marker"
		}},
		{name: "failed providers", prepare: func(report *model.WorkerReport) {
			report.Telemetry.AssistantHost.DefaultCwd = "/private/assistant-host-marker"
			for i := range report.Telemetry.AssistantHost.Providers {
				report.Telemetry.AssistantHost.Providers[i].Available = false
				report.Telemetry.AssistantHost.Providers[i].Reason = workerValidationValue("timeout")
			}
		}},
		{name: "legacy host", prepare: func(report *model.WorkerReport) {
			report.Telemetry.AssistantHost = nil
		}},
		{name: "unknown protocol", prepare: func(report *model.WorkerReport) {
			report.Telemetry.AssistantHost.ProtocolVersion = 2
		}, invalid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input, expected := newReport(), newReport()
			tc.prepare(&input)
			tc.prepare(&expected)
			normalized, err := ValidateReport(input)
			if tc.invalid {
				requireFault(t, err, "invalid_input")
				return
			}
			if err != nil {
				t.Fatalf("valid assistant-host report rejected: %v", err)
			}
			if !reflect.DeepEqual(normalized, expected) {
				t.Fatalf("normalized assistant-host report differs: got %+v, want %+v", normalized, expected)
			}
			observedAt := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
			actual := SnapshotForReport(userID, workerID, normalized, observedAt, []model.WorkerObservedTask{})
			expectedObservedAt := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
			expectedInventoryAt := expected.TaskInventory.ObservedAt
			want := model.WorkerSnapshot{
				UserID: userID, WorkerID: workerID, CreatedAt: expectedObservedAt, LastReportedAt: expectedObservedAt,
				Telemetry: expected.Telemetry,
				TaskSnapshot: model.WorkerTaskObservation{
					State: model.WorkerTasksObserved, ObservedAt: &expectedObservedAt,
					InventoryObservedAt: &expectedInventoryAt, Items: []model.WorkerObservedTask{},
				},
			}
			if !reflect.DeepEqual(actual, want) {
				t.Fatalf("assistant-host snapshot differs: got %+v, want %+v", actual, want)
			}
		})
	}
}

func TestWorkerAssistantHostDomainValidation(t *testing.T) {
	report := validWorkerReportForValidation()
	report.TaskInventory = nil
	report.Telemetry.AssistantHost = validAssistantHost()
	if _, err := ValidateReport(report); err != nil {
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
			if _, err := ValidateReport(report); err == nil {
				t.Fatal("invalid assistant host accepted")
			}
		})
	}
	for _, path := range []string{`C:\work`, `c:/work`, `\\server\share\work`} {
		report.Telemetry.AssistantHost = validAssistantHost()
		report.Telemetry.Platform = model.PlatformWindows
		report.Telemetry.AssistantHost.DefaultCwd = path
		if _, err := ValidateReport(report); err != nil {
			t.Fatal(path, err)
		}
	}
	for _, path := range []string{`C:work`, `/work`, `\work`, `\\server`, `\\server\`, `\\?\C:\work`, `1:/work`} {
		report.Telemetry.AssistantHost = validAssistantHost()
		report.Telemetry.AssistantHost.DefaultCwd = path
		if _, err := ValidateReport(report); err == nil {
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
