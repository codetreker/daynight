package worker

import (
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

// ParseWorkerConfigurationProtocol enforces the negotiated configuration fields.
func ParseWorkerConfigurationProtocol(raw json.RawMessage, capabilities workerprotocol.Capabilities) (model.WorkerConfiguration, error) {
	keys := []string{"maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native", "projects"}
	if capabilities.ToolPaths {
		keys = append(keys, "toolPaths")
	}
	if capabilities.ArchiveSessions {
		keys = append(keys, "archiveSessions")
	}
	fields, err := configurationObject(raw, "configuration", true, append(keys, "enableSudoCleanup", "taskTagFilter")...)
	if err != nil {
		return model.WorkerConfiguration{}, err
	}
	for _, key := range keys {
		if _, ok := fields[key]; !ok {
			return model.WorkerConfiguration{}, invalidInput("configuration." + key + " is required.")
		}
	}
	if capabilities.ToolPaths {
		if _, err := configurationObject(fields["toolPaths"], "toolPaths", false, "codex", "copilot"); err != nil {
			return model.WorkerConfiguration{}, err
		}
	}
	value, err := ParseWorkerConfiguration(raw)
	value.PreserveToolPaths = !capabilities.ToolPaths
	value.PreserveArchiveSessions = !capabilities.ArchiveSessions
	_, present := fields["enableSudoCleanup"]
	value.PreserveSudoCleanup = !present
	_, present = fields["taskTagFilter"]
	value.PreserveTaskTagFilter = !present
	return value, err
}

func ParseWorkerConfigurationExchangeProtocol(raw json.RawMessage, capabilities workerprotocol.Capabilities) (*model.WorkerConfigurationExchange, error) {
	keys := []string{"bootstrap", "observation"}
	if capabilities.ToolPaths {
		keys = append(keys, "toolPathsBootstrap")
	}
	fields, err := configurationObject(raw, "configuration exchange", false, keys...)
	if err != nil {
		return nil, err
	}
	if !configurationNull(fields["bootstrap"]) {
		value, err := ParseWorkerConfigurationProtocol(fields["bootstrap"], capabilities)
		if err != nil {
			return nil, err
		}
		if capabilities.ToolPaths && (value.ToolPaths.Codex == nil || value.ToolPaths.Copilot == nil) {
			return nil, invalidInput("Initial configuration requires all tool path choices.")
		}
	}
	if capabilities.ToolPaths && !configurationNull(fields["toolPathsBootstrap"]) {
		if _, err := configurationObject(fields["toolPathsBootstrap"], "toolPathsBootstrap", false, "codex", "copilot"); err != nil {
			return nil, err
		}
	}
	exchange, err := ParseWorkerConfigurationExchange(raw)
	if err != nil {
		return nil, err
	}
	if exchange.Observation != nil {
		legacyItems := 0
		for _, item := range exchange.Observation.Items {
			if item.Key.Kind == "archiveSessions" {
				if !capabilities.ArchiveSessions {
					return nil, invalidInput("Archive sessions observations require the archive sessions capability.")
				}
			} else if item.Key.Kind != "enableSudoCleanup" && item.Key.Kind != "taskTagFilter" {
				legacyItems++
			}
		}
		if err := upper("observation.items", int64(legacyItems), MaxObservationItems-4, "items"); err != nil {
			return nil, InputLimit(err)
		}
	}
	return exchange, nil
}
