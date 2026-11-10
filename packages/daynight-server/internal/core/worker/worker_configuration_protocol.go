package worker

import (
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// ParseWorkerConfigurationProtocol keeps negotiated writes strict while the
// internal normalizer can still read configurations created before mode adoption.
func ParseWorkerConfigurationProtocol(raw json.RawMessage, controlMode bool) (model.WorkerConfiguration, error) {
	keys := []string{"maxConcurrent", "pollIntervalMs", "recoveryLimit", "preferPlatformSpecificTasks", "native", "projects"}
	if controlMode {
		keys = append(keys, "agentControlMode")
	}
	if _, err := configurationObject(raw, "configuration", false, keys...); err != nil {
		return model.WorkerConfiguration{}, err
	}
	value, err := ParseWorkerConfiguration(raw)
	value.PreserveAgentControlMode = !controlMode
	return value, err
}

func ParseWorkerConfigurationExchangeProtocol(raw json.RawMessage, controlMode bool) (*model.WorkerConfigurationExchange, error) {
	keys := []string{"bootstrap", "observation"}
	if controlMode {
		keys = append(keys, "controlModeBootstrap")
	}
	fields, err := configurationObject(raw, "configuration exchange", false, keys...)
	if err != nil {
		return nil, err
	}
	if !configurationNull(fields["bootstrap"]) {
		value, err := ParseWorkerConfigurationProtocol(fields["bootstrap"], controlMode)
		if err != nil {
			return nil, err
		}
		if controlMode && value.AgentControlMode == nil {
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
				if !controlMode {
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
