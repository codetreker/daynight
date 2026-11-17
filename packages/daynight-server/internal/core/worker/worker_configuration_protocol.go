package worker

import (
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// ParseWorkerConfigurationProtocol keeps negotiated writes strict while the
// internal normalizer can still read configurations created before mode adoption.
func ParseWorkerConfigurationProtocol(raw json.RawMessage) (model.WorkerConfiguration, error) {
	keys := []string{"maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native", "projects"}
	keys = append(keys, "toolPaths")
	fields, err := configurationObject(raw, "configuration", true, append(keys, "enableSudoCleanup")...)
	if err != nil {
		return model.WorkerConfiguration{}, err
	}
	for _, key := range keys {
		if _, ok := fields[key]; !ok {
			return model.WorkerConfiguration{}, invalidInput("configuration." + key + " is required.")
		}
	}
	value, err := ParseWorkerConfiguration(raw)
	_, present := fields["enableSudoCleanup"]
	value.PreserveSudoCleanup = !present
	return value, err
}

func ParseWorkerConfigurationExchangeProtocol(raw json.RawMessage) (*model.WorkerConfigurationExchange, error) {
	keys := []string{"bootstrap", "observation"}
	keys = append(keys, "toolPathsBootstrap")
	fields, err := configurationObject(raw, "configuration exchange", false, keys...)
	if err != nil {
		return nil, err
	}
	if !configurationNull(fields["bootstrap"]) {
		value, err := ParseWorkerConfigurationProtocol(fields["bootstrap"])
		if err != nil {
			return nil, err
		}
		if value.ToolPaths.Codex == nil || value.ToolPaths.Copilot == nil {
			return nil, invalidInput("Initial configuration requires all tool path choices.")
		}

	}
	exchange, err := ParseWorkerConfigurationExchange(raw)
	if err != nil {
		return nil, err
	}

	return exchange, nil
}
