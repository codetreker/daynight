package worker

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"

func validateWorkerRuntimeConfiguration(configuration *model.WorkerRuntimeConfiguration) error {
	if configuration == nil {
		return nil
	}
	if configuration.SchemaVersion != 1 || configuration.Projects == nil || len(configuration.Projects) > 1024 {
		return invalidInput("Runtime configuration requires schema v1 and at most 1024 projects.")
	}
	if err := validateWorkerRuntimeNative(configuration.Native); err != nil {
		return err
	}
	seen := make(map[string]bool, len(configuration.Projects))
	for _, project := range configuration.Projects {
		id, err := model.CanonicalID(project.ProjectID)
		if err != nil || id != project.ProjectID || seen[id] {
			return invalidInput("Runtime configuration project IDs must be unique canonical UUIDs.")
		}
		seen[id] = true
		if err := validateWorkerRuntimeNative(project.Native); err != nil {
			return err
		}
	}
	return nil
}

func validateWorkerRuntimeNative(native *model.WorkerRuntimeNative) error {
	if native == nil {
		return nil
	}
	if !native.Agent.Valid() || !validWorkerConfigurationValue(native.Model, 256) || !validWorkerConfigurationValue(native.ReasoningEffort, 64) {
		return invalidInput("Runtime configuration requires a supported agent and bounded model/effort values with local, cloud or native sources; only native values may be null.")
	}
	return nil
}

func validWorkerConfigurationValue(value model.WorkerConfigurationValue, limit int) bool {
	if value.Source == "native" {
		return value.Value == nil
	}
	return (value.Source == "local" || value.Source == "cloud") && value.Value != nil && workerAssistantText(*value.Value, limit)
}
