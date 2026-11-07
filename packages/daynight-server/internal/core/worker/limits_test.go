package worker

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

func checkViolation(t *testing.T, err error, field string, actual, max int64, unit string) {
	t.Helper()
	var v *limit.Violation
	if !errors.As(err, &v) || v.Field != field || v.Actual != actual || v.Max != max || v.Unit != unit {
		t.Fatalf("violation = %#v (%v), want %s %d/%d %s", v, err, field, actual, max, unit)
	}
}

func TestTelemetryFieldLimits(t *testing.T) {
	cases := []struct {
		field string
		max   int
		set   func(*model.WorkerTelemetry, string)
	}{
		{"machine.name", MaxMachineNameBytes, func(v *model.WorkerTelemetry, s string) { v.Machine.Name = s }},
		{"workingDirectory", MaxWorkingDirectoryBytes, func(v *model.WorkerTelemetry, s string) { v.WorkingDirectory = s }},
		{"versions.daynight", MaxVersionBytes, func(v *model.WorkerTelemetry, s string) { v.Versions.Daynight = s }},
		{"os.type", MaxOSTypeBytes, func(v *model.WorkerTelemetry, s string) { v.OS.Value.Type = s }},
		{"os.arch", MaxOSArchBytes, func(v *model.WorkerTelemetry, s string) { v.OS.Value.Arch = s }},
		{"os.release", MaxOSReleaseBytes, func(v *model.WorkerTelemetry, s string) { v.OS.Value.Release = s }},
		{"os.version", MaxOSVersionBytes, func(v *model.WorkerTelemetry, s string) { v.OS.Value.Version = s }},
		{"cpu.model", MaxCPUModelBytes, func(v *model.WorkerTelemetry, s string) { v.CPU.Value.Model = s }},
		{"versions.herdr", MaxVersionBytes, func(v *model.WorkerTelemetry, s string) { v.Versions.Herdr.Value = &s }},
		{"versions.codex", MaxVersionBytes, func(v *model.WorkerTelemetry, s string) { v.Versions.Codex.Value = &s }},
		{"versions.copilot", MaxVersionBytes, func(v *model.WorkerTelemetry, s string) { v.Versions.Copilot.Value = &s }},
		{"assistantHost.defaultCwd", MaxWorkingDirectoryBytes, func(v *model.WorkerTelemetry, s string) { v.AssistantHost.DefaultCwd = s }},
		{"assistantHost.providers.model", MaxNativeModelBytes, func(v *model.WorkerTelemetry, s string) { v.AssistantHost.Providers[0].Model = &s }},
		{"assistantHost.providers.args", MaxNativeArgBytes, func(v *model.WorkerTelemetry, s string) { v.AssistantHost.Providers[0].Args = []string{s} }},
	}
	for _, tc := range cases {
		t.Run(tc.field, func(t *testing.T) {
			v := model.WorkerTelemetry{OS: model.WorkerProbe[model.WorkerOS]{Value: &model.WorkerOS{}}, CPU: model.WorkerProbe[model.WorkerCPU]{Value: &model.WorkerCPU{}}, AssistantHost: &model.WorkerAssistantHost{Providers: make([]model.WorkerAssistantProvider, 1)}}
			// The same byte count applies to multi-byte text, not rune count.
			valid := strings.Repeat("é", tc.max/2)
			tc.set(&v, valid)
			if err := AdmitTelemetry(v); err != nil {
				t.Fatalf("boundary rejected: %v", err)
			}
			tc.set(&v, valid+"x")
			checkViolation(t, AdmitTelemetry(v), tc.field, int64(tc.max+1), int64(tc.max), "bytes")
		})
	}
	v := model.WorkerTelemetry{AssistantHost: &model.WorkerAssistantHost{Providers: []model.WorkerAssistantProvider{{Args: make([]string, MaxNativeArgs)}}}}
	if err := AdmitTelemetry(v); err != nil {
		t.Fatal(err)
	}
	v.AssistantHost.Providers[0].Args = append(v.AssistantHost.Providers[0].Args, "x")
	checkViolation(t, AdmitTelemetry(v), "assistantHost.providers.args", MaxNativeArgs+1, MaxNativeArgs, "items")
}

func boundedConfiguration() model.WorkerConfiguration {
	return model.WorkerConfiguration{MaxConcurrent: MinConcurrent, PollIntervalMs: MinPollIntervalMs, RecoveryLimit: MinRecoveryLimit}
}

func TestConfigurationRangesAndCollections(t *testing.T) {
	ranges := []struct {
		field    string
		min, max int64
		set      func(*model.WorkerConfiguration, int64)
	}{
		{"maxConcurrent", MinConcurrent, MaxConcurrent, func(v *model.WorkerConfiguration, n int64) { v.MaxConcurrent = n }},
		{"pollIntervalMs", MinPollIntervalMs, MaxPollIntervalMs, func(v *model.WorkerConfiguration, n int64) { v.PollIntervalMs = n }},
		{"recoveryLimit", MinRecoveryLimit, MaxRecoveryLimit, func(v *model.WorkerConfiguration, n int64) { v.RecoveryLimit = n }},
	}
	for _, tc := range ranges {
		t.Run(tc.field, func(t *testing.T) {
			for _, n := range []int64{tc.min, tc.max} {
				v := boundedConfiguration()
				tc.set(&v, n)
				if err := AdmitConfiguration(v); err != nil {
					t.Fatalf("%d rejected: %v", n, err)
				}
			}
			v := boundedConfiguration()
			tc.set(&v, tc.min-1)
			err := AdmitConfiguration(v)
			checkViolation(t, err, tc.field, tc.min-1, tc.max, "value")
			var violation *limit.Violation
			errors.As(err, &violation)
			if violation.Min == nil || *violation.Min != tc.min {
				t.Fatalf("minimum = %v", violation.Min)
			}
			tc.set(&v, tc.max+1)
			checkViolation(t, AdmitConfiguration(v), tc.field, tc.max+1, tc.max, "value")
		})
	}
	v := boundedConfiguration()
	v.Projects = make([]model.WorkerProjectConfiguration, MaxProjects)
	if err := AdmitConfiguration(v); err != nil {
		t.Fatal(err)
	}
	v.Projects = append(v.Projects, model.WorkerProjectConfiguration{})
	checkViolation(t, AdmitConfiguration(v), "projects", MaxProjects+1, MaxProjects, "items")

	inventory := model.WorkerTaskInventory{Claims: make([]model.WorkerTaskReference, MaxInventoryClaims)}
	if err := AdmitInventory(inventory); err != nil {
		t.Fatal(err)
	}
	inventory.Claims = append(inventory.Claims, model.WorkerTaskReference{})
	checkViolation(t, AdmitInventory(inventory), "taskInventory.claims", MaxInventoryClaims+1, MaxInventoryClaims, "items")
}

func TestConfigurationNativeAndOverrideLimits(t *testing.T) {
	for _, override := range []bool{false, true} {
		t.Run(fmt.Sprint(override), func(t *testing.T) {
			v := boundedConfiguration()
			set := func(modelText string, args []string) {
				if !override {
					v.Native.Model = &modelText
					v.Native.Args = args
					return
				}
				modelJSON, _ := json.Marshal(modelText)
				argsJSON, _ := json.Marshal(args)
				v.Projects = []model.WorkerProjectConfiguration{{NativeOverrides: map[string]json.RawMessage{"model": modelJSON, "args": argsJSON}}}
			}
			prefix := "native"
			if override {
				prefix = "projects.nativeOverrides"
			}
			set(strings.Repeat("é", MaxNativeModelBytes/2), []string{strings.Repeat("é", MaxNativeArgBytes/2)})
			if err := AdmitConfiguration(v); err != nil {
				t.Fatal(err)
			}
			set(strings.Repeat("m", MaxNativeModelBytes+1), nil)
			checkViolation(t, AdmitConfiguration(v), prefix+".model", MaxNativeModelBytes+1, MaxNativeModelBytes, "bytes")
			set("m", []string{strings.Repeat("a", MaxNativeArgBytes+1)})
			checkViolation(t, AdmitConfiguration(v), prefix+".args", MaxNativeArgBytes+1, MaxNativeArgBytes, "bytes")
			set("m", make([]string, MaxNativeArgs))
			if err := AdmitConfiguration(v); err != nil {
				t.Fatal(err)
			}
			set("m", make([]string, MaxNativeArgs+1))
			checkViolation(t, AdmitConfiguration(v), prefix+".args", MaxNativeArgs+1, MaxNativeArgs, "items")
		})
	}
	v := boundedConfiguration()
	v.Projects = []model.WorkerProjectConfiguration{{NativeOverrides: map[string]json.RawMessage{"model": []byte(`true`)}}}
	if err := AdmitConfiguration(v); err == nil {
		t.Fatal("invalid model accepted")
	}
	v.Projects[0].NativeOverrides = map[string]json.RawMessage{"args": []byte(`false`)}
	if err := AdmitConfiguration(v); err == nil {
		t.Fatal("invalid args accepted")
	}
}

func TestObservationLimits(t *testing.T) {
	value := model.WorkerConfigurationObservation{Items: make([]model.WorkerConfigurationItem, MaxObservationItems)}
	if err := AdmitObservation(value); err != nil {
		t.Fatal(err)
	}
	value.Items = append(value.Items, model.WorkerConfigurationItem{})
	checkViolation(t, AdmitObservation(value), "observation.items", MaxObservationItems+1, MaxObservationItems, "items")
	for _, tc := range []struct {
		kind, valid, invalid string
		actual, max          int64
	}{
		{"maxConcurrent", `64`, `65`, 65, MaxConcurrent},
		{"pollIntervalMs", `60000`, `60001`, 60001, MaxPollIntervalMs},
		{"recoveryLimit", `10`, `11`, 11, MaxRecoveryLimit},
	} {
		v := model.WorkerConfigurationObservation{Items: []model.WorkerConfigurationItem{{Key: model.WorkerConfigurationItemKey{Kind: tc.kind}, AppliedValue: json.RawMessage(tc.valid)}}}
		if err := AdmitObservation(v); err != nil {
			t.Fatal(err)
		}
		v.Items[0].AppliedValue = json.RawMessage(tc.invalid)
		checkViolation(t, AdmitObservation(v), "observation.items.appliedValue", tc.actual, tc.max, "value")
		v.Items[0].AppliedValue = json.RawMessage(`false`)
		if err := AdmitObservation(v); err == nil {
			t.Fatal("invalid integer accepted")
		}
	}
	for _, kind := range []string{"native", "projectNative"} {
		v := model.WorkerConfigurationObservation{Items: []model.WorkerConfigurationItem{{Key: model.WorkerConfigurationItemKey{Kind: kind}}}}
		native, _ := json.Marshal(model.WorkerNativeConfiguration{Args: []string{strings.Repeat("x", MaxNativeArgBytes+1)}})
		v.Items[0].AppliedValue = native
		checkViolation(t, AdmitObservation(v), "observation.items.appliedValue.args", MaxNativeArgBytes+1, MaxNativeArgBytes, "bytes")
		v.Items[0].AppliedValue = []byte(`false`)
		if err := AdmitObservation(v); err == nil {
			t.Fatal("invalid native accepted")
		}
	}
}

func TestReportComposesIndependentLimits(t *testing.T) {
	v := model.WorkerReport{}
	if err := AdmitReport(v); err != nil {
		t.Fatal(err)
	}
	v.Telemetry.Machine.Name = strings.Repeat("x", MaxMachineNameBytes+1)
	checkViolation(t, AdmitReport(v), "machine.name", MaxMachineNameBytes+1, MaxMachineNameBytes, "bytes")
	v.Telemetry.Machine.Name = "ok"
	v.TaskInventory = &model.WorkerTaskInventory{Claims: make([]model.WorkerTaskReference, MaxInventoryClaims+1)}
	checkViolation(t, AdmitReport(v), "taskInventory.claims", MaxInventoryClaims+1, MaxInventoryClaims, "items")
	v.TaskInventory = nil
	bootstrap := boundedConfiguration()
	bootstrap.MaxConcurrent = MaxConcurrent + 1
	v.Configuration = &model.WorkerConfigurationExchange{Bootstrap: &bootstrap}
	checkViolation(t, AdmitReport(v), "maxConcurrent", MaxConcurrent+1, MaxConcurrent, "value")
	v.Configuration.Bootstrap = nil
	v.Configuration.Observation = &model.WorkerConfigurationObservation{Items: make([]model.WorkerConfigurationItem, MaxObservationItems+1)}
	checkViolation(t, AdmitReport(v), "observation.items", MaxObservationItems+1, MaxObservationItems, "items")
}

func TestRuntimeConfigurationLimits(t *testing.T) {
	value := model.WorkerTelemetry{RuntimeConfiguration: &model.WorkerRuntimeConfiguration{Projects: make([]model.WorkerRuntimeProject, MaxProjects)}}
	if err := AdmitTelemetry(value); err != nil {
		t.Fatal(err)
	}
	value.RuntimeConfiguration.Projects = append(value.RuntimeConfiguration.Projects, model.WorkerRuntimeProject{})
	checkViolation(t, AdmitTelemetry(value), "runtimeConfiguration.projects", MaxProjects+1, MaxProjects, "items")
	value.RuntimeConfiguration.Projects = value.RuntimeConfiguration.Projects[:MaxProjects]
	modelText := strings.Repeat("é", MaxNativeModelBytes/2)
	value.RuntimeConfiguration.Native = &model.WorkerRuntimeNative{Model: model.WorkerConfigurationValue{Value: &modelText}}
	if err := AdmitTelemetry(value); err != nil {
		t.Fatal(err)
	}
	modelText += "x"
	checkViolation(t, AdmitTelemetry(value), "runtimeConfiguration.native.model.value", MaxNativeModelBytes+1, MaxNativeModelBytes, "bytes")
	value.RuntimeConfiguration.Native = nil
	value.RuntimeConfiguration.Projects[0].Native = &model.WorkerRuntimeNative{Model: model.WorkerConfigurationValue{Value: &modelText}}
	checkViolation(t, AdmitTelemetry(value), "runtimeConfiguration.projects.native.model.value", MaxNativeModelBytes+1, MaxNativeModelBytes, "bytes")
}

func TestConfigurationResourceAndNormalizedReport(t *testing.T) {
	value := model.WorkerConfigurationResource{Desired: &model.WorkerDesiredConfiguration{Value: boundedConfiguration()}, Observation: &model.WorkerConfigurationReportedObservation{}}
	if err := AdmitConfigurationResource(value); err != nil {
		t.Fatal(err)
	}
	value.Desired.Value.MaxConcurrent = MaxConcurrent + 1
	checkViolation(t, AdmitConfigurationResource(value), "maxConcurrent", MaxConcurrent+1, MaxConcurrent, "value")
	value.Desired = nil
	value.Observation.Items = make([]model.WorkerConfigurationItem, MaxObservationItems+1)
	checkViolation(t, AdmitConfigurationResource(value), "observation.items", MaxObservationItems+1, MaxObservationItems, "items")

	report := validWorkerReportForValidation()
	report.Telemetry.Machine.Name = strings.Repeat("é", MaxMachineNameBytes/2)
	normalized, err := ValidateReport(report)
	if err != nil {
		t.Fatal(err)
	}
	if err := AdmitReport(normalized); err != nil {
		t.Fatal(err)
	}
	report.Telemetry.Machine.Name += "x"
	_, err = ValidateReport(report)
	requireFault(t, err, "invalid_input")
}

func TestLimitsAfterExistingStructuralValidation(t *testing.T) {
	report := validWorkerReportForValidation()
	for i := 0; i < MaxInventoryClaims+1; i++ {
		report.TaskInventory.Claims = append(report.TaskInventory.Claims, model.WorkerTaskReference{
			ProjectID: "00000000-0000-4000-8000-000000000001", TaskID: fmt.Sprintf("00000000-0000-4000-8000-%012x", i+1), ClaimID: "00000000-0000-4000-8000-000000000002",
		})
	}
	_, err := ValidateReport(report)
	requireFault(t, err, "invalid_input")
	report.TaskInventory.Claims = report.TaskInventory.Claims[:MaxInventoryClaims]
	if _, err := ValidateReport(report); err != nil {
		t.Fatal(err)
	}

	config := boundedConfiguration()
	config.Native = model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}}
	for i := 0; i < MaxProjects+1; i++ {
		config.Projects = append(config.Projects, model.WorkerProjectConfiguration{ProjectID: fmt.Sprintf("00000000-0000-4000-8000-%012x", i+1), NativeOverrides: map[string]json.RawMessage{}})
	}
	raw, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	_, err = ParseWorkerConfiguration(raw)
	requireFault(t, err, "invalid_input")
	config.Projects = config.Projects[:MaxProjects]
	raw, _ = json.Marshal(config)
	if _, err := ParseWorkerConfiguration(raw); err != nil {
		t.Fatal(err)
	}

	observation := model.WorkerConfigurationObservation{BaseRevision: "0", DesiredRevision: "1"}
	for i := 0; i < MaxObservationItems+1; i++ {
		observation.Items = append(observation.Items, model.WorkerConfigurationItem{Key: model.WorkerConfigurationItemKey{Kind: "projectPreparation", ProjectID: fmt.Sprintf("00000000-0000-4000-8000-%012x", i+1)}, TargetRevision: "1", AppliedValue: json.RawMessage(`null`), State: "pending"})
	}
	raw, err = json.Marshal(model.WorkerConfigurationExchange{Observation: &observation})
	if err != nil {
		t.Fatal(err)
	}
	_, err = ParseWorkerConfigurationExchange(raw)
	requireFault(t, err, "invalid_input")
	observation.Items = observation.Items[:MaxObservationItems]
	raw, _ = json.Marshal(model.WorkerConfigurationExchange{Observation: &observation})
	if _, err := ParseWorkerConfigurationExchange(raw); err != nil {
		t.Fatal(err)
	}
}
