package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func toolTelemetryFixture() *model.ToolPathTelemetry {
	stamp := time.Date(2026, 11, 11, 12, 0, 0, 123, time.UTC)
	zero := int64(0)
	choice := model.ToolPathChoice{Kind: "path", Path: "/opt/codex"}
	actual := &model.ToolPathActual{Selection: choice, SelectionKey: strings.Repeat("a", 64), EntryPath: "/opt/codex", ExecutablePath: "/opt/native/codex", Source: "explicit", Version: "1.2.3", CheckedAt: stamp}
	return &model.ToolPathTelemetry{SchemaVersion: 1, ObservedAt: stamp, Entries: []model.ToolPathObservation{{Tool: "codex", Context: "web", ConfigurationSource: "local", Target: choice, State: "applied", Actual: actual, ActiveSelectionCount: &zero, ActiveSelectionsComplete: true, ActiveSelections: []model.ToolPathActiveSelection{}}}}
}

func TestToolPathsReportPreservesForeignPlatformTargetFailure(t *testing.T) {
	input := validWorkerReportForValidation()
	ordinary := input.Telemetry
	paths := toolTelemetryFixture()
	entry := &paths.Entries[0]
	entry.ConfigurationSource = "cloud"
	entry.TargetRevision = workerValidationValue("7")
	entry.Target = model.ToolPathChoice{Kind: "path", Path: `C:\tools\codex.exe`}
	entry.State = "error"
	entry.Actual = nil
	entry.Error = &model.ToolPathError{Code: "invalid_path", OccurredAt: paths.ObservedAt}
	input.Telemetry.ToolPaths = paths
	result, err := ValidateReport(input)
	if err != nil {
		t.Fatalf("foreign-platform target failure rejected the ordinary report: %v", err)
	}
	if !reflect.DeepEqual(result.Telemetry.ToolPaths, paths) {
		t.Fatalf("tool target or failure changed: %+v", result.Telemetry.ToolPaths)
	}
	result.Telemetry.ToolPaths = nil
	if !reflect.DeepEqual(result.Telemetry, ordinary) || !reflect.DeepEqual(result.TaskInventory, input.TaskInventory) {
		t.Fatal("tool failure changed ordinary telemetry or task inventory")
	}
}

func TestToolPathsReportRejectsForeignPlatformActualSelections(t *testing.T) {
	for _, location := range []string{"actual", "candidate", "active"} {
		t.Run(location, func(t *testing.T) {
			input := validWorkerReportForValidation()
			paths := toolTelemetryFixture()
			entry := &paths.Entries[0]
			entry.State = "pending"
			actual := *entry.Actual
			actual.Selection.Path = `C:\tools\codex.exe`
			entry.Actual = nil
			switch location {
			case "actual":
				entry.Actual = &actual
			case "candidate":
				entry.Candidate = &actual
			case "active":
				entry.ActiveSelectionCount = workerValidationValue(int64(1))
				entry.ActiveSelections = []model.ToolPathActiveSelection{{Actual: actual}}
			}
			input.Telemetry.ToolPaths = paths
			if _, err := ValidateReport(input); err == nil {
				t.Fatal("foreign-platform actual selection accepted")
			}
		})
	}
}

func TestToolPathsTelemetryStructureAndSemantics(t *testing.T) {
	good := toolTelemetryFixture()
	raw, err := json.Marshal(good)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseToolPathTelemetry(raw)
	if err != nil || parsed.Entries[0].Actual.SelectionKey != good.Entries[0].Actual.SelectionKey {
		t.Fatalf("valid report rejected: %+v %v", parsed, err)
	}
	bad := map[string]func(*model.ToolPathTelemetry){
		"schema":                 func(v *model.ToolPathTelemetry) { v.SchemaVersion = 2 },
		"zero time":              func(v *model.ToolPathTelemetry) { v.ObservedAt = time.Time{} },
		"year zero":              func(v *model.ToolPathTelemetry) { v.ObservedAt = time.Date(0, 1, 1, 0, 0, 0, 0, time.UTC) },
		"null entries":           func(v *model.ToolPathTelemetry) { v.Entries = nil },
		"many entries":           func(v *model.ToolPathTelemetry) { v.Entries = make([]model.ToolPathObservation, 6) },
		"tool":                   func(v *model.ToolPathTelemetry) { v.Entries[0].Tool = "claude" },
		"context":                func(v *model.ToolPathTelemetry) { v.Entries[0].Context = "bot" },
		"herdr web":              func(v *model.ToolPathTelemetry) { v.Entries[0].Tool = "herdr" },
		"duplicate":              func(v *model.ToolPathTelemetry) { v.Entries = append(v.Entries, v.Entries[0]) },
		"target":                 func(v *model.ToolPathTelemetry) { v.Entries[0].Target.Path = "relative" },
		"source":                 func(v *model.ToolPathTelemetry) { v.Entries[0].ConfigurationSource = "other" },
		"local revision":         func(v *model.ToolPathTelemetry) { v.Entries[0].TargetRevision = workerValidationValue("1") },
		"cloud missing revision": func(v *model.ToolPathTelemetry) { v.Entries[0].ConfigurationSource = "cloud" },
		"cloud invalid revision": func(v *model.ToolPathTelemetry) {
			v.Entries[0].ConfigurationSource = "cloud"
			v.Entries[0].TargetRevision = workerValidationValue("01")
		},
		"state":        func(v *model.ToolPathTelemetry) { v.Entries[0].State = "ready" },
		"error absent": func(v *model.ToolPathTelemetry) { v.Entries[0].State = "error" },
		"error unexpected": func(v *model.ToolPathTelemetry) {
			v.Entries[0].Error = &model.ToolPathError{Code: "io_error", OccurredAt: v.ObservedAt}
		},
		"reason state": func(v *model.ToolPathTelemetry) { v.Entries[0].Reason = workerValidationValue("active_instance") },
		"reason unknown": func(v *model.ToolPathTelemetry) {
			v.Entries[0].State = "pending"
			v.Entries[0].Reason = workerValidationValue("other")
		},
		"not checked actual":   func(v *model.ToolPathTelemetry) { v.Entries[0].State = "not_checked" },
		"applied absent":       func(v *model.ToolPathTelemetry) { v.Entries[0].Actual = nil },
		"applied wrong choice": func(v *model.ToolPathTelemetry) { v.Entries[0].Target.Path = "/other" },
		"invalid key":          func(v *model.ToolPathTelemetry) { v.Entries[0].Actual.SelectionKey = strings.Repeat("A", 64) },
		"entry path":           func(v *model.ToolPathTelemetry) { v.Entries[0].Actual.EntryPath = "relative" },
		"executable path":      func(v *model.ToolPathTelemetry) { v.Entries[0].Actual.ExecutablePath = "relative" },
		"interpreter path": func(v *model.ToolPathTelemetry) {
			v.Entries[0].Actual.InterpreterPath = workerValidationValue("relative")
		},
		"source choice":  func(v *model.ToolPathTelemetry) { v.Entries[0].Actual.Source = "path" },
		"version":        func(v *model.ToolPathTelemetry) { v.Entries[0].Actual.Version = "\nsecret" },
		"long version":   func(v *model.ToolPathTelemetry) { v.Entries[0].Actual.Version = strings.Repeat("x", 257) },
		"checked future": func(v *model.ToolPathTelemetry) { v.Entries[0].Actual.CheckedAt = v.ObservedAt.Add(time.Nanosecond) },
		"unknown failure": func(v *model.ToolPathTelemetry) {
			v.Entries[0].State = "error"
			v.Entries[0].Error = &model.ToolPathError{Code: "secret", OccurredAt: v.ObservedAt}
		},
		"failure future": func(v *model.ToolPathTelemetry) {
			v.Entries[0].State = "error"
			v.Entries[0].Error = &model.ToolPathError{Code: "io_error", OccurredAt: v.ObservedAt.Add(time.Nanosecond)}
		},
		"null active":            func(v *model.ToolPathTelemetry) { v.Entries[0].ActiveSelections = nil },
		"unknown complete count": func(v *model.ToolPathTelemetry) { v.Entries[0].ActiveSelectionCount = nil },
		"negative total":         func(v *model.ToolPathTelemetry) { v.Entries[0].ActiveSelectionCount = workerValidationValue(int64(-1)) },
		"complete wrong count":   func(v *model.ToolPathTelemetry) { v.Entries[0].ActiveSelectionCount = workerValidationValue(int64(1)) },
		"complete error": func(v *model.ToolPathTelemetry) {
			v.Entries[0].ActiveObservationError = workerValidationValue("cleanup_unknown")
		},
		"unknown active error": func(v *model.ToolPathTelemetry) {
			v.Entries[0].ActiveSelectionsComplete = false
			v.Entries[0].ActiveObservationError = workerValidationValue("other")
		},
	}
	for name, mutate := range bad {
		t.Run(name, func(t *testing.T) {
			v := toolTelemetryFixture()
			mutate(v)
			if err := ValidateToolPaths(v, model.PlatformLinux); err == nil {
				t.Fatal("invalid tool observation accepted")
			}
		})
	}
	for _, code := range toolErrorCodes {
		v := toolTelemetryFixture()
		v.Entries[0].State = "error"
		v.Entries[0].Error = &model.ToolPathError{Code: code, OccurredAt: v.ObservedAt}
		if err := ValidateToolPaths(v, model.PlatformLinux); err != nil {
			t.Fatalf("allowed error %s rejected: %v", code, err)
		}
	}
	v := toolTelemetryFixture()
	v.Entries[0].State = "pending"
	v.Entries[0].Reason = workerValidationValue("report_budget_exceeded")
	v.Entries[0].Actual = nil
	v.Entries[0].ActiveSelectionsComplete = false
	v.Entries[0].ActiveSelectionCount = nil
	v.Entries[0].ActiveObservationError = workerValidationValue("legacy_tool_identity_missing")
	if err := ValidateToolPaths(v, model.PlatformLinux); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{`C:\Tools\tool.exe`, `\\server\share\tool.exe`, `//server/share/tool.exe`, `\\?\C:\tools\tool.exe`, `\\.\pipe\tool.exe`} {
		v := toolTelemetryFixture()
		v.Entries[0].Target.Path = path
		v.Entries[0].Actual.Selection.Path = path
		v.Entries[0].Actual.EntryPath = path
		v.Entries[0].Actual.ExecutablePath = path
		if err := ValidateToolPaths(v, model.PlatformWindows); err != nil {
			t.Fatalf("Windows path rejected %s: %v", path, err)
		}
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		parsed, err := ParseToolPathTelemetry(raw)
		if err != nil || parsed.Entries[0].Actual.EntryPath != path {
			t.Fatalf("Windows report roundtrip: %+v %v", parsed, err)
		}
	}
	if err := ValidateToolPaths(toolTelemetryFixture(), model.PlatformWindows); err == nil {
		t.Fatal("Windows accepted POSIX root")
	}
}

func TestToolPathsTelemetryStrictWireFields(t *testing.T) {
	good, _ := json.Marshal(toolTelemetryFixture())
	for _, mutate := range []func(map[string]any){
		func(v map[string]any) { v["argv"] = []any{} },
		func(v map[string]any) { v["entries"].([]any)[0].(map[string]any)["env"] = map[string]any{} },
		func(v map[string]any) { delete(v["entries"].([]any)[0].(map[string]any), "activeSelectionCount") },
		func(v map[string]any) {
			v["entries"].([]any)[0].(map[string]any)["actual"].(map[string]any)["argv"] = []any{}
		},
		func(v map[string]any) {
			v["entries"].([]any)[0].(map[string]any)["target"].(map[string]any)["unknown"] = true
		},
		func(v map[string]any) { v["entries"].([]any)[0].(map[string]any)["activeSelectionsComplete"] = nil },
	} {
		var document map[string]any
		if err := json.Unmarshal(good, &document); err != nil {
			t.Fatal(err)
		}
		mutate(document)
		raw, _ := json.Marshal(document)
		if _, err := ParseToolPathTelemetry(raw); err == nil {
			t.Fatalf("invalid wire accepted: %s", raw)
		}
	}
	for _, raw := range []string{`null`, `{"schemaVersion":1,"observedAt":"2026-01-01T00:00:00Z","entries":null}`, `{"schemaVersion":1,"schemaVersion":1,"observedAt":"2026-01-01T00:00:00Z","entries":[]}`, strings.Replace(string(good), "/opt/codex", `/opt/\ud800`, 1)} {
		if _, err := ParseToolPathTelemetry([]byte(raw)); err == nil {
			t.Fatalf("invalid raw accepted: %s", raw)
		}
	}
}

func TestToolPathsTelemetryActiveGroupsAndBudget(t *testing.T) {
	v := toolTelemetryFixture()
	e := &v.Entries[0]
	e.ActiveSelectionCount = workerValidationValue(int64(2))
	e.ActiveSelectionsComplete = false
	first := model.ToolPathActiveSelection{Actual: *e.Actual, ExecutionCount: workerValidationValue(int64(2)), UnconfirmedCount: 1}
	e.ActiveSelections = []model.ToolPathActiveSelection{first}
	if _, err := ParseToolPathTelemetry(configurationInputJSON(t, v)); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*model.ToolPathObservation){
		"duplicate": func(e *model.ToolPathObservation) {
			e.ActiveSelections = append(e.ActiveSelections, e.ActiveSelections[0])
		},
		"too many": func(e *model.ToolPathObservation) { e.ActiveSelections = make([]model.ToolPathActiveSelection, 9) },
		"negative execution": func(e *model.ToolPathObservation) {
			e.ActiveSelections[0].ExecutionCount = workerValidationValue(int64(-1))
		},
		"unsafe instance": func(e *model.ToolPathObservation) {
			e.ActiveSelections[0].InstanceCount = workerValidationValue(workerSafeInteger + 1)
		},
		"negative unknown": func(e *model.ToolPathObservation) { e.ActiveSelections[0].UnconfirmedCount = -1 },
		"invalid actual":   func(e *model.ToolPathObservation) { e.ActiveSelections[0].Actual.Version = "" },
	} {
		t.Run(name, func(t *testing.T) {
			bad := *v
			bad.Entries = append([]model.ToolPathObservation{}, v.Entries...)
			bad.Entries[0].ActiveSelections = append([]model.ToolPathActiveSelection{}, e.ActiveSelections...)
			mutate(&bad.Entries[0])
			if err := ValidateToolPaths(&bad, model.PlatformLinux); err == nil {
				t.Fatal("bad active group accepted")
			}
		})
	}
	path := "/" + strings.Repeat("<", 4095)
	for i := 0; i < 8; i++ {
		actual := *e.Actual
		actual.Selection.Path = path
		actual.EntryPath = path
		actual.ExecutablePath = path
		actual.InterpreterPath = &path
		actual.SelectionKey = fmt.Sprintf("%064x", i+1)
		e.ActiveSelections = append(e.ActiveSelections[:min(i, len(e.ActiveSelections))], model.ToolPathActiveSelection{Actual: actual})
	}
	e.ActiveSelectionCount = workerValidationValue(int64(8))
	if err := ValidateToolPaths(v, model.PlatformLinux); err == nil {
		t.Fatal("escaped tool report exceeded 256 KiB without refusal")
	}
}

func TestToolPathsCloudTargetsUseLockedRevision(t *testing.T) {
	v := toolTelemetryFixture()
	v.Entries[0].ConfigurationSource = "cloud"
	v.Entries[0].TargetRevision = workerValidationValue("7")
	dao := configuredDAO("7")
	choice := v.Entries[0].Target
	dao.current.Desired.Value.ToolPaths.Codex = &choice
	principal := model.Principal{UserID: "user"}
	if err := ValidateToolPathTargets(t.Context(), checkedConfigurationScope(t, dao), principal, "worker", v); err != nil {
		t.Fatal(err)
	}
	v.Entries[0].TargetRevision = workerValidationValue("8")
	requireFault(t, ValidateToolPathTargets(t.Context(), dao, principal, "worker", v), "invalid_input")
	v.Entries[0].TargetRevision = workerValidationValue("7")
	v.Entries[0].Target = model.ToolPathChoice{Kind: "auto"}
	requireFault(t, ValidateToolPathTargets(t.Context(), dao, principal, "worker", v), "invalid_input")
	v.Entries[0].TargetRevision = workerValidationValue("6")
	if err := ValidateToolPathTargets(t.Context(), dao, principal, "worker", v); err != nil {
		t.Fatal("historical target rejected", err)
	}
	dao.readErr = errors.New("offline")
	if err := ValidateToolPathTargets(t.Context(), dao, principal, "worker", v); !errors.Is(err, dao.readErr) {
		t.Fatal(err)
	}
	dao.readErr = nil
	dao.current.Desired = nil
	requireFault(t, ValidateToolPathTargets(t.Context(), dao, principal, "worker", v), "invalid_input")
}

func TestToolPathsRejectNoncanonicalTime(t *testing.T) {
	raw, err := json.Marshal(toolTelemetryFixture())
	if err != nil {
		t.Fatal(err)
	}
	offset := strings.Replace(string(raw), "Z\"", "+00:00\"", 1)
	if _, err := ParseToolPathTelemetry([]byte(offset)); err == nil {
		t.Error("offset tool timestamp accepted")
	}
}
