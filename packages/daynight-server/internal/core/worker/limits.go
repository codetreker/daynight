package worker

import (
	"encoding/json"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

// Limits apply to normalized candidates; they do not change structural validation
// or the behavior of existing read and write paths.
const (
	MaxActiveWorkers          = 100
	ActiveWindow              = 120 * time.Second
	MaxMachineNameBytes       = 256
	MaxWorkingDirectoryBytes  = 4 << 10
	MaxVersionBytes           = 256
	MaxOSTypeBytes            = 64
	MaxOSArchBytes            = 64
	MaxOSReleaseBytes         = 256
	MaxOSVersionBytes         = 1 << 10
	MaxCPUModelBytes          = 512
	MaxNativeModelBytes       = 256
	MaxNativeArgs             = 128
	MaxNativeArgBytes         = 4 << 10
	MaxProjects               = 128
	MaxInventoryClaims        = 256
	MaxObservationItems       = 1025
	MaxTelemetryJSONBytes     = 4 << 20
	MaxConfigurationJSONBytes = 4 << 20
	MaxWorkerJSONBytes        = 4 << 20
	MinConcurrent             = 1
	MaxConcurrent             = 64
	MinPollIntervalMs         = 1000
	MaxPollIntervalMs         = 60000
	MinRecoveryLimit          = 0
	MaxRecoveryLimit          = 10
)

func upper(field string, actual, max int64, unit string) error {
	if actual > max {
		return &limit.Violation{Field: field, Actual: actual, Max: max, Unit: unit}
	}
	return nil
}

func bounded(field string, actual, min, max int64) error {
	if actual < min {
		return &limit.Violation{Field: field, Actual: actual, Max: max, Min: &min, Unit: "value"}
	}
	return upper(field, actual, max, "value")
}

func bytesLimit(field, value string, max int) error {
	return upper(field, int64(len(value)), int64(max), "bytes")
}

func nativeLimits(field string, value model.WorkerNativeConfiguration) error {
	if value.Model != nil {
		if err := bytesLimit(field+".model", *value.Model, MaxNativeModelBytes); err != nil {
			return err
		}
	}
	if err := upper(field+".args", int64(len(value.Args)), MaxNativeArgs, "items"); err != nil {
		return err
	}
	for _, arg := range value.Args {
		if err := bytesLimit(field+".args", arg, MaxNativeArgBytes); err != nil {
			return err
		}
	}
	return nil
}

func runtimeNativeLimits(field string, value *model.WorkerRuntimeNative) error {
	if value == nil || value.Model.Value == nil {
		return nil
	}
	return bytesLimit(field+".model.value", *value.Model.Value, MaxNativeModelBytes)
}

// AdmitTelemetry applies byte and collection limits to structurally validated telemetry.
func AdmitTelemetry(value model.WorkerTelemetry) error {
	if value.RuntimeConfiguration != nil {
		runtime := value.RuntimeConfiguration
		if err := upper("runtimeConfiguration.projects", int64(len(runtime.Projects)), MaxProjects, "items"); err != nil {
			return err
		}
		if err := runtimeNativeLimits("runtimeConfiguration.native", runtime.Native); err != nil {
			return err
		}
		for _, project := range runtime.Projects {
			if err := runtimeNativeLimits("runtimeConfiguration.projects.native", project.Native); err != nil {
				return err
			}
		}
	}
	for _, item := range []struct {
		field, value string
		max          int
	}{
		{"machine.name", value.Machine.Name, MaxMachineNameBytes},
		{"workingDirectory", value.WorkingDirectory, MaxWorkingDirectoryBytes},
		{"versions.daynight", value.Versions.Daynight, MaxVersionBytes},
	} {
		if err := bytesLimit(item.field, item.value, item.max); err != nil {
			return err
		}
	}
	if value.OS.Value != nil {
		os := value.OS.Value
		for _, item := range []struct {
			field, value string
			max          int
		}{
			{"os.type", os.Type, MaxOSTypeBytes}, {"os.arch", os.Arch, MaxOSArchBytes},
			{"os.release", os.Release, MaxOSReleaseBytes}, {"os.version", os.Version, MaxOSVersionBytes},
		} {
			if err := bytesLimit(item.field, item.value, item.max); err != nil {
				return err
			}
		}
	}
	if value.CPU.Value != nil {
		if err := bytesLimit("cpu.model", value.CPU.Value.Model, MaxCPUModelBytes); err != nil {
			return err
		}
	}
	for _, item := range []struct {
		field string
		value *string
	}{
		{"versions.herdr", value.Versions.Herdr.Value}, {"versions.codex", value.Versions.Codex.Value}, {"versions.copilot", value.Versions.Copilot.Value},
	} {
		if item.value != nil {
			if err := bytesLimit(item.field, *item.value, MaxVersionBytes); err != nil {
				return err
			}
		}
	}
	if value.AssistantHost != nil {
		host := value.AssistantHost
		if err := bytesLimit("assistantHost.defaultCwd", host.DefaultCwd, MaxWorkingDirectoryBytes); err != nil {
			return err
		}
		for _, provider := range host.Providers {
			if err := nativeLimits("assistantHost.providers", model.WorkerNativeConfiguration{Model: provider.Model, Args: provider.Args}); err != nil {
				return err
			}
		}
	}
	return nil
}

// AdmitInventory checks the complete claim collection, not an external subset.
func AdmitInventory(value model.WorkerTaskInventory) error {
	return upper("taskInventory.claims", int64(len(value.Claims)), MaxInventoryClaims, "items")
}

// AdmitConfiguration checks a structurally validated desired or bootstrap value.
func AdmitConfiguration(value model.WorkerConfiguration) error {
	for _, item := range []struct {
		field           string
		value, min, max int64
	}{
		{"maxConcurrent", value.MaxConcurrent, MinConcurrent, MaxConcurrent},
		{"pollIntervalMs", value.PollIntervalMs, MinPollIntervalMs, MaxPollIntervalMs},
		{"recoveryLimit", value.RecoveryLimit, MinRecoveryLimit, MaxRecoveryLimit},
	} {
		if err := bounded(item.field, item.value, item.min, item.max); err != nil {
			return err
		}
	}
	if err := nativeLimits("native", value.Native); err != nil {
		return err
	}
	if err := upper("projects", int64(len(value.Projects)), MaxProjects, "items"); err != nil {
		return err
	}
	for _, project := range value.Projects {
		var native model.WorkerNativeConfiguration
		if raw, ok := project.NativeOverrides["model"]; ok {
			if err := json.Unmarshal(raw, &native.Model); err != nil {
				return invalidInput("Native model is invalid.")
			}
		}
		if raw, ok := project.NativeOverrides["args"]; ok {
			if err := json.Unmarshal(raw, &native.Args); err != nil {
				return invalidInput("Native arguments are invalid.")
			}
		}
		if err := nativeLimits("projects.nativeOverrides", native); err != nil {
			return err
		}
	}
	return nil
}

// AdmitObservation checks the actual current collection and its applied values.
// Removal of acknowledged entries is a separate lifecycle operation.
func AdmitObservation(value model.WorkerConfigurationObservation) error {
	if err := upper("observation.items", int64(len(value.Items)), MaxObservationItems, "items"); err != nil {
		return err
	}
	for _, item := range value.Items {
		if len(item.AppliedValue) == 0 || string(item.AppliedValue) == "null" {
			continue
		}
		switch item.Key.Kind {
		case "preferPlatformSpecificTasks":
			var enabled bool
			if err := configurationDecode(item.AppliedValue, &enabled); err != nil {
				return err
			}
		case "native", "projectNative":
			var native model.WorkerNativeConfiguration
			if err := json.Unmarshal(item.AppliedValue, &native); err != nil {
				return invalidInput("Applied native configuration is invalid.")
			}
			if err := nativeLimits("observation.items.appliedValue", native); err != nil {
				return err
			}
		case "maxConcurrent", "pollIntervalMs", "recoveryLimit":
			var n int64
			if err := json.Unmarshal(item.AppliedValue, &n); err != nil {
				return invalidInput("Applied configuration integer is invalid.")
			}
			min, max := int64(MinConcurrent), int64(MaxConcurrent)
			if item.Key.Kind == "pollIntervalMs" {
				min, max = MinPollIntervalMs, MaxPollIntervalMs
			}
			if item.Key.Kind == "recoveryLimit" {
				min, max = MinRecoveryLimit, MaxRecoveryLimit
			}
			if err := bounded("observation.items.appliedValue", n, min, max); err != nil {
				return err
			}
		}
	}
	return nil
}

// AdmitConfigurationResource checks desired and reported values as stored.
func AdmitConfigurationResource(value model.WorkerConfigurationResource) error {
	if value.Desired != nil {
		if err := AdmitConfiguration(value.Desired.Value); err != nil {
			return err
		}
	}
	if value.Observation != nil {
		return AdmitObservation(value.Observation.WorkerConfigurationObservation)
	}
	return nil
}

// AdmitReport applies field rules independently of persistence and quota decisions.
func AdmitReport(value model.WorkerReport) error {
	if err := AdmitTelemetry(value.Telemetry); err != nil {
		return err
	}
	if value.TaskInventory != nil {
		if err := AdmitInventory(*value.TaskInventory); err != nil {
			return err
		}
	}
	if value.Configuration != nil {
		if value.Configuration.Bootstrap != nil {
			if err := AdmitConfiguration(*value.Configuration.Bootstrap); err != nil {
				return err
			}
		}
		if value.Configuration.Observation != nil {
			if err := AdmitObservation(*value.Configuration.Observation); err != nil {
				return err
			}
		}
	}
	return nil
}
