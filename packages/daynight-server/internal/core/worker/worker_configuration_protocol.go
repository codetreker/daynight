package worker

import (
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

// ParseWorkerConfigurationProtocol keeps negotiated writes strict while the
// internal normalizer can still read configurations created before mode adoption.
func ParseWorkerConfigurationProtocol(raw json.RawMessage, capabilities workerprotocol.Capabilities) (model.WorkerConfiguration, error) {
	keys := []string{"maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native", "projects"}
	if capabilities.ControlMode {
		keys = append(keys, "agentControlMode")
	}
	if capabilities.ToolPaths {
		keys = append(keys, "toolPaths")
	}
	if _, err := configurationObject(raw, "configuration", false, keys...); err != nil {
		return model.WorkerConfiguration{}, err
	}
	value, err := ParseWorkerConfiguration(raw)
	value.PreserveAgentControlMode = !capabilities.ControlMode
	value.PreserveToolPaths = !capabilities.ToolPaths
	return value, err
}

func ParseWorkerConfigurationExchangeProtocol(raw json.RawMessage, capabilities workerprotocol.Capabilities) (*model.WorkerConfigurationExchange, error) {
	keys := []string{"bootstrap", "observation"}
	if capabilities.ControlMode {
		keys = append(keys, "controlModeBootstrap")
	}
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
		if capabilities.ToolPaths && (value.ToolPaths.Codex == nil || value.ToolPaths.Copilot == nil || value.ToolPaths.Herdr == nil) {
			return nil, invalidInput("Initial configuration requires all tool path choices.")
		}
		if capabilities.ControlMode && value.AgentControlMode == nil {
			return nil, invalidInput("Initial configuration requires an agent control mode.")
		}
	}
	exchange, err := ParseWorkerConfigurationExchange(raw)
	if err != nil {
		return nil, err
	}
	if exchange.Observation != nil {
		legacyItems := 0
		for _, item := range exchange.Observation.Items {
			if item.Key.Kind == "agentControlMode" {
				if !capabilities.ControlMode {
					return nil, invalidInput("Agent control mode observations require the control mode capability.")
				}
			} else {
				legacyItems++
			}
		}
		if err := upper("observation.items", int64(legacyItems), MaxObservationItems-1, "items"); err != nil {
			return nil, InputLimit(err)
		}
	}
	return exchange, nil
}
