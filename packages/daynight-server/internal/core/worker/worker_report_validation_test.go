package worker

import (
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func workerValidationValue[T any](value T) *T { return &value }

func validWorkerReportForValidation() model.WorkerReport {
	now := time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC)
	return model.WorkerReport{Telemetry: model.WorkerTelemetry{
		Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "test machine"}, Platform: model.PlatformLinux, WorkingDirectory: "/work", SampledAt: now,
		OS:     model.WorkerProbe[model.WorkerOS]{State: "ok", CheckedAt: now, Value: &model.WorkerOS{Type: "Linux", Release: "6.8", Version: "kernel", Arch: "x64"}},
		CPU:    model.WorkerProbe[model.WorkerCPU]{State: "ok", CheckedAt: now, Value: &model.WorkerCPU{Model: "CPU", LogicalProcessors: 4, UsagePercent: 12.5}},
		Memory: model.WorkerProbe[model.WorkerMemory]{State: "ok", CheckedAt: now, Value: &model.WorkerMemory{UsedBytes: 4, TotalBytes: 8}},
		Disk:   model.WorkerProbe[model.WorkerDisk]{State: "ok", CheckedAt: now, Value: &model.WorkerDisk{AvailableBytes: 8, TotalBytes: 16}},
		Versions: model.WorkerVersions{Daynight: "1.0.0", Herdr: model.WorkerProbe[string]{State: "ok", CheckedAt: now, Value: workerValidationValue("0.9.5")},
			Codex: model.WorkerProbe[string]{State: "not_installed", CheckedAt: now}, Copilot: model.WorkerProbe[string]{State: "error", CheckedAt: now, Code: workerValidationValue("timeout")}},
	}, TaskInventory: &model.WorkerTaskInventory{ObservedAt: now, Claims: []model.WorkerTaskReference{}}}
}

func TestWorkerReportValidationCanonicalCopyAndExplicitInventory(t *testing.T) {
	input := validWorkerReportForValidation()
	input.Telemetry.Machine.ID = strings.ToUpper(input.Telemetry.Machine.ID)
	input.TaskInventory.Claims = []model.WorkerTaskReference{{ProjectID: strings.ToUpper(uuid.NewString()), TaskID: strings.ToUpper(uuid.NewString()), ClaimID: strings.ToUpper(uuid.NewString())}}
	original := input.TaskInventory.Claims[0]
	result, err := ValidateReport(input)
	if err != nil {
		t.Fatal(err)
	}
	if result.Telemetry.Machine.ID != strings.ToLower(input.Telemetry.Machine.ID) || result.TaskInventory.Claims[0].TaskID != strings.ToLower(original.TaskID) || input.TaskInventory.Claims[0] != original || result.TaskInventory == input.TaskInventory {
		t.Fatal("validation did not return an independent canonical reference set")
	}
	input.TaskInventory = nil
	if result, err := ValidateReport(input); err != nil || result.TaskInventory != nil {
		t.Fatal("unknown inventory was changed or rejected", err)
	}
	input = validWorkerReportForValidation()
	input.Telemetry.Versions.Herdr = model.WorkerProbe[string]{State: "not_running", CheckedAt: input.Telemetry.SampledAt}
	input.Telemetry.OS = model.WorkerProbe[model.WorkerOS]{State: "error", CheckedAt: input.Telemetry.SampledAt, Code: workerValidationValue("io_error")}
	if _, err := ValidateReport(input); err != nil {
		t.Fatal("truthful collection states were rejected", err)
	}
}

func TestWorkerReportValidationRejectsInvalidDomainValues(t *testing.T) {
	cases := map[string]func(*model.WorkerReport){
		"machine ID":                 func(r *model.WorkerReport) { r.Telemetry.Machine.ID = "bad" },
		"blank machine":              func(r *model.WorkerReport) { r.Telemetry.Machine.Name = " " },
		"NUL directory":              func(r *model.WorkerReport) { r.Telemetry.WorkingDirectory = "/\x00" },
		"reported NUL directory":     func(r *model.WorkerReport) { r.Telemetry.WorkingDirectory = "NUL\x00" },
		"invalid UTF8":               func(r *model.WorkerReport) { r.Telemetry.Versions.Daynight = string([]byte{0xff}) },
		"platform":                   func(r *model.WorkerReport) { r.Telemetry.Platform = "unknown" },
		"sample time":                func(r *model.WorkerReport) { r.Telemetry.SampledAt = time.Time{} },
		"OS field":                   func(r *model.WorkerReport) { r.Telemetry.OS.Value.Arch = "" },
		"CPU model":                  func(r *model.WorkerReport) { r.Telemetry.CPU.Value.Model = "" },
		"CPU count":                  func(r *model.WorkerReport) { r.Telemetry.CPU.Value.LogicalProcessors = 0 },
		"CPU unsafe count":           func(r *model.WorkerReport) { r.Telemetry.CPU.Value.LogicalProcessors = workerSafeInteger + 1 },
		"CPU NaN":                    func(r *model.WorkerReport) { r.Telemetry.CPU.Value.UsagePercent = math.NaN() },
		"CPU infinite":               func(r *model.WorkerReport) { r.Telemetry.CPU.Value.UsagePercent = math.Inf(1) },
		"CPU negative":               func(r *model.WorkerReport) { r.Telemetry.CPU.Value.UsagePercent = -1 },
		"CPU over 100":               func(r *model.WorkerReport) { r.Telemetry.CPU.Value.UsagePercent = 101 },
		"negative memory":            func(r *model.WorkerReport) { r.Telemetry.Memory.Value.UsedBytes = -1 },
		"unsafe memory":              func(r *model.WorkerReport) { r.Telemetry.Memory.Value.TotalBytes = workerSafeInteger + 1 },
		"memory capacity":            func(r *model.WorkerReport) { r.Telemetry.Memory.Value.UsedBytes = 9 },
		"reported memory capacity":   func(r *model.WorkerReport) { r.Telemetry.Memory.Value.UsedBytes = 99 },
		"negative disk":              func(r *model.WorkerReport) { r.Telemetry.Disk.Value.AvailableBytes = -1 },
		"unsafe disk":                func(r *model.WorkerReport) { r.Telemetry.Disk.Value.TotalBytes = workerSafeInteger + 1 },
		"disk capacity":              func(r *model.WorkerReport) { r.Telemetry.Disk.Value.AvailableBytes = 17 },
		"probe time":                 func(r *model.WorkerReport) { r.Telemetry.CPU.CheckedAt = time.Time{} },
		"probe missing value":        func(r *model.WorkerReport) { r.Telemetry.CPU.Value = nil },
		"probe wrong code":           func(r *model.WorkerReport) { r.Telemetry.CPU.Code = workerValidationValue("timeout") },
		"probe wrong state":          func(r *model.WorkerReport) { r.Telemetry.CPU.State = "not_installed" },
		"error code":                 func(r *model.WorkerReport) { r.Telemetry.Versions.Copilot.Code = workerValidationValue("unknown") },
		"error missing code":         func(r *model.WorkerReport) { r.Telemetry.Versions.Copilot.Code = nil },
		"error value":                func(r *model.WorkerReport) { r.Telemetry.Versions.Copilot.Value = workerValidationValue("version") },
		"missing installation value": func(r *model.WorkerReport) { r.Telemetry.Versions.Codex.Value = workerValidationValue("version") },
		"installed blank version":    func(r *model.WorkerReport) { r.Telemetry.Versions.Herdr.Value = workerValidationValue(" ") },
		"inventory time":             func(r *model.WorkerReport) { r.TaskInventory.ObservedAt = time.Time{} },
		"null claims":                func(r *model.WorkerReport) { r.TaskInventory.Claims = nil },
		"reference project": func(r *model.WorkerReport) {
			r.TaskInventory.Claims = []model.WorkerTaskReference{{ProjectID: "bad", TaskID: uuid.NewString(), ClaimID: uuid.NewString()}}
		},
		"reference task": func(r *model.WorkerReport) {
			r.TaskInventory.Claims = []model.WorkerTaskReference{{ProjectID: uuid.NewString(), TaskID: "bad", ClaimID: uuid.NewString()}}
		},
		"reference claim": func(r *model.WorkerReport) {
			r.TaskInventory.Claims = []model.WorkerTaskReference{{ProjectID: uuid.NewString(), TaskID: uuid.NewString(), ClaimID: "bad"}}
		},
		"duplicate canonical task": func(r *model.WorkerReport) {
			id := uuid.NewString()
			r.TaskInventory.Claims = []model.WorkerTaskReference{{ProjectID: uuid.NewString(), TaskID: id, ClaimID: uuid.NewString()}, {ProjectID: uuid.NewString(), TaskID: strings.ToUpper(id), ClaimID: uuid.NewString()}}
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			input := validWorkerReportForValidation()
			mutate(&input)
			_, err := ValidateReport(input)
			if err == nil {
				t.Fatal("invalid report accepted")
			}
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "invalid_input" {
				t.Fatalf("wrong validation error: %T", err)
			}
		})
	}
}

func TestWorkerReportCapacityValidationAndSnapshot(t *testing.T) {
	const userID = "11111111-1111-4111-8111-111111111111"
	const workerID = "22222222-2222-4222-8222-222222222222"
	newReport := func() model.WorkerReport {
		report := validWorkerReportForValidation()
		report.Telemetry.Machine = model.WorkerMachine{ID: "33333333-3333-4333-8333-333333333333", Name: "Private worker machine"}
		report.Telemetry.WorkingDirectory = "/private/work"
		return report
	}
	checkSnapshot := func(t *testing.T, input, expected model.WorkerReport) {
		t.Helper()
		normalized, err := ValidateReport(input)
		if err != nil {
			t.Fatalf("normal capacity rejected: %v", err)
		}
		if !reflect.DeepEqual(normalized, expected) {
			t.Fatalf("normalized report differs: got %+v, want %+v", normalized, expected)
		}
		items, err := MatchTaskSnapshots(nil, *normalized.TaskInventory, userID, workerID)
		if err != nil || items == nil || len(items) != 0 {
			t.Fatalf("missing Task sources did not produce an explicit empty observation: %+v %v", items, err)
		}
		observedAt := time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)
		actual := SnapshotForReport(userID, workerID, normalized, observedAt, items)
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
			t.Fatalf("capacity snapshot differs: got %+v, want %+v", actual, want)
		}
	}
	cases := []struct {
		name string
		size int
		set  func(*model.WorkerTelemetry, string)
	}{
		{"machine", 256, func(v *model.WorkerTelemetry, s string) { v.Machine.Name = s }},
		{"cwd", 4096, func(v *model.WorkerTelemetry, s string) { v.WorkingDirectory = s }},
		{"daynight", 256, func(v *model.WorkerTelemetry, s string) { v.Versions.Daynight = s }},
		{"herdr", 256, func(v *model.WorkerTelemetry, s string) { v.Versions.Herdr.Value = workerValidationValue(s) }},
		{"codex", 256, func(v *model.WorkerTelemetry, s string) {
			v.Versions.Codex = model.WorkerProbe[string]{State: "ok", CheckedAt: v.SampledAt, Value: workerValidationValue(s)}
		}},
		{"copilot", 256, func(v *model.WorkerTelemetry, s string) {
			v.Versions.Copilot = model.WorkerProbe[string]{State: "ok", CheckedAt: v.SampledAt, Value: workerValidationValue(s)}
		}},
		{"os.type", 64, func(v *model.WorkerTelemetry, s string) { v.OS.Value.Type = s }},
		{"os.arch", 64, func(v *model.WorkerTelemetry, s string) { v.OS.Value.Arch = s }},
		{"os.release", 256, func(v *model.WorkerTelemetry, s string) { v.OS.Value.Release = s }},
		{"os.version", 1024, func(v *model.WorkerTelemetry, s string) { v.OS.Value.Version = s }},
		{"cpu.model", 512, func(v *model.WorkerTelemetry, s string) { v.CPU.Value.Model = s }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			input, expected := newReport(), newReport()
			value := strings.Repeat("界", tc.size/3) + strings.Repeat("x", tc.size%3)
			tc.set(&input.Telemetry, value)
			tc.set(&expected.Telemetry, value)
			checkSnapshot(t, input, expected)
			tc.set(&input.Telemetry, value+"x")
			_, err := ValidateReport(input)
			requireFault(t, err, "invalid_input")
		})
	}
	for _, kind := range []string{"claims", "projects"} {
		t.Run(kind, func(t *testing.T) {
			maximum := 256
			var claims []model.WorkerTaskReference
			var projects []model.WorkerRuntimeProject
			if kind == "claims" {
				claims = make([]model.WorkerTaskReference, maximum+1)
				for i := range claims {
					claims[i] = model.WorkerTaskReference{ProjectID: uuid.NewString(), TaskID: uuid.NewString(), ClaimID: uuid.NewString()}
				}
			} else {
				maximum = 128
				projects = make([]model.WorkerRuntimeProject, maximum+1)
				for i := range projects {
					projects[i] = model.WorkerRuntimeProject{ProjectID: uuid.NewString(), Native: nil}
				}
			}
			set := func(report *model.WorkerReport, count int) {
				if kind == "claims" {
					report.TaskInventory.Claims = append([]model.WorkerTaskReference{}, claims[:count]...)
				} else {
					report.Telemetry.RuntimeConfiguration = &model.WorkerRuntimeConfiguration{
						SchemaVersion: 1, Native: nil, Projects: append([]model.WorkerRuntimeProject{}, projects[:count]...),
					}
				}
			}
			input, expected := newReport(), newReport()
			set(&input, maximum)
			set(&expected, maximum)
			checkSnapshot(t, input, expected)
			set(&input, maximum+1)
			_, err := ValidateReport(input)
			requireFault(t, err, "invalid_input")
		})
	}
}
