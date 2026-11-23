package worker

import (
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func validRuntimeConfiguration() *model.WorkerRuntimeConfiguration {
	return &model.WorkerRuntimeConfiguration{SchemaVersion: 1, Native: &model.WorkerRuntimeNative{Agent: model.AgentCodex,
		Model: model.WorkerConfigurationValue{Value: workerValidationValue("gpt-model"), Source: "local"}, ReasoningEffort: model.WorkerConfigurationValue{Source: "native"}},
		Projects: []model.WorkerRuntimeProject{{ProjectID: "11111111-1111-4111-8111-111111111111", Native: nil}}}
}

func TestWorkerRuntimeConfigurationValidation(t *testing.T) {
	const userID = "22222222-2222-4222-8222-222222222222"
	const workerID = "33333333-3333-4333-8333-333333333333"
	report := validWorkerReportForValidation()
	report.Telemetry.RuntimeConfiguration = validRuntimeConfiguration()
	normalized, err := ValidateReport(report)
	if err != nil {
		t.Fatal(err)
	}
	wantNative := &model.WorkerRuntimeNative{
		Agent:           model.AgentCodex,
		Model:           model.WorkerConfigurationValue{Value: workerValidationValue("gpt-model"), Source: "local"},
		ReasoningEffort: model.WorkerConfigurationValue{Source: "native"},
	}
	if runtime := normalized.Telemetry.RuntimeConfiguration; runtime == nil || !reflect.DeepEqual(runtime.Native, wantNative) {
		t.Fatalf("validated report lost the local runtime model: %#v", runtime)
	}
	snapshot := SnapshotForReport(userID, workerID, normalized, report.Telemetry.SampledAt, []model.WorkerObservedTask{})
	if runtime := snapshot.Telemetry.RuntimeConfiguration; runtime == nil || !reflect.DeepEqual(runtime.Native, wantNative) {
		t.Fatalf("snapshot lost the local runtime model: %#v", runtime)
	}

	report.Telemetry.RuntimeConfiguration.SchemaVersion = 2
	if _, err := ValidateReport(report); err == nil {
		t.Fatal("report bypassed runtime configuration validation")
	}
	report.Telemetry.RuntimeConfiguration = nil
	normalized, err = ValidateReport(report)
	if err != nil {
		t.Fatal(err)
	}
	snapshot = SnapshotForReport(userID, workerID, normalized, report.Telemetry.SampledAt, []model.WorkerObservedTask{})
	if normalized.Telemetry.RuntimeConfiguration != nil || snapshot.Telemetry.RuntimeConfiguration != nil {
		t.Fatalf("omitted runtime configuration was introduced by validation or snapshot: report=%#v snapshot=%#v", normalized.Telemetry.RuntimeConfiguration, snapshot.Telemetry.RuntimeConfiguration)
	}

	if err := validateWorkerRuntimeConfiguration(nil); err != nil {
		t.Fatal(err)
	}
	if err := validateWorkerRuntimeConfiguration(validRuntimeConfiguration()); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*model.WorkerRuntimeConfiguration){
		"schema":          func(c *model.WorkerRuntimeConfiguration) { c.SchemaVersion = 2 },
		"nil projects":    func(c *model.WorkerRuntimeConfiguration) { c.Projects = nil },
		"large projects":  func(c *model.WorkerRuntimeConfiguration) { c.Projects = make([]model.WorkerRuntimeProject, 1025) },
		"invalid project": func(c *model.WorkerRuntimeConfiguration) { c.Projects[0].ProjectID = "invalid" },
		"noncanonical project": func(c *model.WorkerRuntimeConfiguration) {
			c.Projects[0].ProjectID = "AAAAAAAA-1111-4111-8111-111111111111"
		},
		"duplicate project": func(c *model.WorkerRuntimeConfiguration) { c.Projects = append(c.Projects, c.Projects[0]) },
		"invalid agent":     func(c *model.WorkerRuntimeConfiguration) { c.Native.Agent = "other" },
		"invalid source":    func(c *model.WorkerRuntimeConfiguration) { c.Native.Model.Source = "other" },
		"null local":        func(c *model.WorkerRuntimeConfiguration) { c.Native.Model.Value = nil },
		"nonnull native":    func(c *model.WorkerRuntimeConfiguration) { c.Native.Model.Source = "native" },
		"empty model":       func(c *model.WorkerRuntimeConfiguration) { c.Native.Model.Value = workerValidationValue(" ") },
		"control model":     func(c *model.WorkerRuntimeConfiguration) { c.Native.Model.Value = workerValidationValue("a\n") },
		"invalid UTF8": func(c *model.WorkerRuntimeConfiguration) {
			c.Native.Model.Value = workerValidationValue(string([]byte{255}))
		},
		"large model": func(c *model.WorkerRuntimeConfiguration) {
			c.Native.Model.Value = workerValidationValue(strings.Repeat("x", 257))
		},
		"large effort": func(c *model.WorkerRuntimeConfiguration) {
			c.Native.ReasoningEffort = model.WorkerConfigurationValue{Source: "cloud", Value: workerValidationValue(strings.Repeat("x", 65))}
		},
		"project configuration": func(c *model.WorkerRuntimeConfiguration) {
			c.Projects[0].Native = &model.WorkerRuntimeNative{Agent: "other"}
		},
	} {
		t.Run(name, func(t *testing.T) {
			configuration := validRuntimeConfiguration()
			mutate(configuration)
			if err := validateWorkerRuntimeConfiguration(configuration); err == nil {
				t.Fatal("invalid configuration accepted")
			}
		})
	}
	configuration := validRuntimeConfiguration()
	configuration.Native.ReasoningEffort = model.WorkerConfigurationValue{Source: "cloud", Value: workerValidationValue("high")}
	configuration.Projects[0].Native = configuration.Native
	if err := validateWorkerRuntimeConfiguration(configuration); err != nil {
		t.Fatal(err)
	}
	configuration.Native = nil
	if err := validateWorkerRuntimeConfiguration(configuration); err != nil {
		t.Fatal(err)
	}
}
