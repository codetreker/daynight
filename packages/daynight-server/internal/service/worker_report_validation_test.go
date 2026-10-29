package service

import (
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
)

func workerValidationValue[T any](value T) *T { return &value }

func validWorkerReportForValidation() core.WorkerReport {
	now := time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC)
	return core.WorkerReport{Telemetry: core.WorkerTelemetry{
		Machine: core.WorkerMachine{ID: uuid.NewString(), Name: "test machine"}, Platform: core.PlatformLinux, WorkingDirectory: "/work", SampledAt: now,
		OS:     core.WorkerProbe[core.WorkerOS]{State: "ok", CheckedAt: now, Value: &core.WorkerOS{Type: "Linux", Release: "6.8", Version: "kernel", Arch: "x64"}},
		CPU:    core.WorkerProbe[core.WorkerCPU]{State: "ok", CheckedAt: now, Value: &core.WorkerCPU{Model: "CPU", LogicalProcessors: 4, UsagePercent: 12.5}},
		Memory: core.WorkerProbe[core.WorkerMemory]{State: "ok", CheckedAt: now, Value: &core.WorkerMemory{UsedBytes: 4, TotalBytes: 8}},
		Disk:   core.WorkerProbe[core.WorkerDisk]{State: "ok", CheckedAt: now, Value: &core.WorkerDisk{AvailableBytes: 8, TotalBytes: 16}},
		Versions: core.WorkerVersions{Daynight: "1.0.0", Herdr: core.WorkerProbe[string]{State: "ok", CheckedAt: now, Value: workerValidationValue("0.9.5")},
			Codex: core.WorkerProbe[string]{State: "not_installed", CheckedAt: now}, Copilot: core.WorkerProbe[string]{State: "error", CheckedAt: now, Code: workerValidationValue("timeout")}},
	}, TaskInventory: &core.WorkerTaskInventory{ObservedAt: now, Claims: []core.WorkerTaskReference{}}}
}

func TestWorkerReportValidationCanonicalCopyAndExplicitInventory(t *testing.T) {
	input := validWorkerReportForValidation()
	input.Telemetry.Machine.ID = strings.ToUpper(input.Telemetry.Machine.ID)
	input.TaskInventory.Claims = []core.WorkerTaskReference{{ProjectID: strings.ToUpper(uuid.NewString()), TaskID: strings.ToUpper(uuid.NewString()), ClaimID: strings.ToUpper(uuid.NewString())}}
	original := input.TaskInventory.Claims[0]
	result, err := validateWorkerReport(input)
	if err != nil {
		t.Fatal(err)
	}
	if result.Telemetry.Machine.ID != strings.ToLower(input.Telemetry.Machine.ID) || result.TaskInventory.Claims[0].TaskID != strings.ToLower(original.TaskID) || input.TaskInventory.Claims[0] != original || result.TaskInventory == input.TaskInventory {
		t.Fatal("validation did not return an independent canonical reference set")
	}
	input.TaskInventory = nil
	if result, err := validateWorkerReport(input); err != nil || result.TaskInventory != nil {
		t.Fatal("unknown inventory was changed or rejected", err)
	}
	input = validWorkerReportForValidation()
	input.Telemetry.Versions.Herdr = core.WorkerProbe[string]{State: "not_running", CheckedAt: input.Telemetry.SampledAt}
	input.Telemetry.OS = core.WorkerProbe[core.WorkerOS]{State: "error", CheckedAt: input.Telemetry.SampledAt, Code: workerValidationValue("io_error")}
	if _, err := validateWorkerReport(input); err != nil {
		t.Fatal("truthful collection states were rejected", err)
	}
}

func TestWorkerReportValidationRejectsInvalidDomainValues(t *testing.T) {
	cases := map[string]func(*core.WorkerReport){
		"machine ID":                 func(r *core.WorkerReport) { r.Telemetry.Machine.ID = "bad" },
		"blank machine":              func(r *core.WorkerReport) { r.Telemetry.Machine.Name = " " },
		"NUL directory":              func(r *core.WorkerReport) { r.Telemetry.WorkingDirectory = "/\x00" },
		"invalid UTF8":               func(r *core.WorkerReport) { r.Telemetry.Versions.Daynight = string([]byte{0xff}) },
		"platform":                   func(r *core.WorkerReport) { r.Telemetry.Platform = "unknown" },
		"sample time":                func(r *core.WorkerReport) { r.Telemetry.SampledAt = time.Time{} },
		"OS field":                   func(r *core.WorkerReport) { r.Telemetry.OS.Value.Arch = "" },
		"CPU model":                  func(r *core.WorkerReport) { r.Telemetry.CPU.Value.Model = "" },
		"CPU count":                  func(r *core.WorkerReport) { r.Telemetry.CPU.Value.LogicalProcessors = 0 },
		"CPU unsafe count":           func(r *core.WorkerReport) { r.Telemetry.CPU.Value.LogicalProcessors = workerSafeInteger + 1 },
		"CPU NaN":                    func(r *core.WorkerReport) { r.Telemetry.CPU.Value.UsagePercent = math.NaN() },
		"CPU infinite":               func(r *core.WorkerReport) { r.Telemetry.CPU.Value.UsagePercent = math.Inf(1) },
		"CPU negative":               func(r *core.WorkerReport) { r.Telemetry.CPU.Value.UsagePercent = -1 },
		"CPU over 100":               func(r *core.WorkerReport) { r.Telemetry.CPU.Value.UsagePercent = 101 },
		"negative memory":            func(r *core.WorkerReport) { r.Telemetry.Memory.Value.UsedBytes = -1 },
		"unsafe memory":              func(r *core.WorkerReport) { r.Telemetry.Memory.Value.TotalBytes = workerSafeInteger + 1 },
		"memory capacity":            func(r *core.WorkerReport) { r.Telemetry.Memory.Value.UsedBytes = 9 },
		"negative disk":              func(r *core.WorkerReport) { r.Telemetry.Disk.Value.AvailableBytes = -1 },
		"unsafe disk":                func(r *core.WorkerReport) { r.Telemetry.Disk.Value.TotalBytes = workerSafeInteger + 1 },
		"disk capacity":              func(r *core.WorkerReport) { r.Telemetry.Disk.Value.AvailableBytes = 17 },
		"probe time":                 func(r *core.WorkerReport) { r.Telemetry.CPU.CheckedAt = time.Time{} },
		"probe missing value":        func(r *core.WorkerReport) { r.Telemetry.CPU.Value = nil },
		"probe wrong code":           func(r *core.WorkerReport) { r.Telemetry.CPU.Code = workerValidationValue("timeout") },
		"probe wrong state":          func(r *core.WorkerReport) { r.Telemetry.CPU.State = "not_installed" },
		"error code":                 func(r *core.WorkerReport) { r.Telemetry.Versions.Copilot.Code = workerValidationValue("unknown") },
		"error missing code":         func(r *core.WorkerReport) { r.Telemetry.Versions.Copilot.Code = nil },
		"error value":                func(r *core.WorkerReport) { r.Telemetry.Versions.Copilot.Value = workerValidationValue("version") },
		"missing installation value": func(r *core.WorkerReport) { r.Telemetry.Versions.Codex.Value = workerValidationValue("version") },
		"installed blank version":    func(r *core.WorkerReport) { r.Telemetry.Versions.Herdr.Value = workerValidationValue(" ") },
		"inventory time":             func(r *core.WorkerReport) { r.TaskInventory.ObservedAt = time.Time{} },
		"null claims":                func(r *core.WorkerReport) { r.TaskInventory.Claims = nil },
		"reference project": func(r *core.WorkerReport) {
			r.TaskInventory.Claims = []core.WorkerTaskReference{{ProjectID: "bad", TaskID: uuid.NewString(), ClaimID: uuid.NewString()}}
		},
		"reference task": func(r *core.WorkerReport) {
			r.TaskInventory.Claims = []core.WorkerTaskReference{{ProjectID: uuid.NewString(), TaskID: "bad", ClaimID: uuid.NewString()}}
		},
		"reference claim": func(r *core.WorkerReport) {
			r.TaskInventory.Claims = []core.WorkerTaskReference{{ProjectID: uuid.NewString(), TaskID: uuid.NewString(), ClaimID: "bad"}}
		},
		"duplicate canonical task": func(r *core.WorkerReport) {
			id := uuid.NewString()
			r.TaskInventory.Claims = []core.WorkerTaskReference{{ProjectID: uuid.NewString(), TaskID: id, ClaimID: uuid.NewString()}, {ProjectID: uuid.NewString(), TaskID: strings.ToUpper(id), ClaimID: uuid.NewString()}}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			input := validWorkerReportForValidation()
			mutate(&input)
			_, err := validateWorkerReport(input)
			if err == nil {
				t.Fatal("invalid report accepted")
			}
			var fault *Fault
			if !errors.As(err, &fault) || fault.Code != "invalid_input" {
				t.Fatalf("wrong validation error: %T", err)
			}
		})
	}
}
