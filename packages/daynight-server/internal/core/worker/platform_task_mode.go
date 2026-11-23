package worker

import (
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

// Legacy protocol conversion is confined to client inputs; persisted targets use the enum.
func parseLegacyPlatformConfiguration(raw json.RawMessage) (model.WorkerConfiguration, error) {
	if !jsonunicode.Valid(raw) {
		return model.WorkerConfiguration{}, invalidInput("Worker configuration must contain valid Unicode.")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return model.WorkerConfiguration{}, invalidInput("Worker configuration is invalid.")
	}
	if _, exists := fields["platformTaskMode"]; exists {
		return model.WorkerConfiguration{}, invalidInput("Legacy configuration cannot contain platformTaskMode.")
	}
	var prefer bool
	if err := configurationDecode(fields["preferPlatformSpecificTasks"], &prefer); err != nil {
		return model.WorkerConfiguration{}, err
	}
	mode := model.PlatformTaskAll
	if prefer {
		mode = model.PlatformTaskPrefer
	}
	delete(fields, "preferPlatformSpecificTasks")
	fields["platformTaskMode"], _ = json.Marshal(mode)
	converted, err := json.Marshal(fields)
	if err != nil {
		return model.WorkerConfiguration{}, err
	}
	value, err := ParseWorkerConfiguration(converted)
	value.LegacyPlatformTaskMode = true
	return value, err
}

func preparePlatformTaskMode(current model.WorkerConfigurationResource, fields map[string]json.RawMessage, value *model.WorkerConfiguration) error {
	var previous model.WorkerPlatformTaskMode
	if err := json.Unmarshal(fields["platformTaskMode"], &previous); err != nil || !previous.Valid() {
		// An explicit replacement can repair an unsupported target, but cannot enable only without support.
		previous = ""
	}
	if value.LegacyPlatformTaskMode && previous == model.PlatformTaskOnly {
		if value.PlatformTaskMode != model.PlatformTaskPrefer {
			return &model.Fault{Code: "worker_platform_task_mode_upgrade_required", Message: "Upgrade the client to change the Worker's only-platform target."}
		}
		value.PlatformTaskMode = model.PlatformTaskOnly
	}
	value.LegacyPlatformTaskMode = false
	if value.PlatformTaskMode != model.PlatformTaskOnly || previous == model.PlatformTaskOnly {
		return nil
	}
	if current.Observation != nil {
		for _, item := range current.Observation.Items {
			if item.Key.Kind == "platformTaskMode" {
				return nil
			}
		}
	}
	return &model.Fault{Code: "worker_platform_task_mode_unsupported", Message: "Worker has not reported support for platform task modes."}
}
