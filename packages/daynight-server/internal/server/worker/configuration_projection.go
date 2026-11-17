package worker

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

type projectedConfiguration struct {
	model.WorkerConfigurationWire
	ToolPaths       any `json:"toolPaths,omitempty"`
	ArchiveSessions any `json:"archiveSessions,omitempty"`
}

type projectedDesiredConfiguration struct {
	Revision  string    `json:"revision"`
	UpdatedAt time.Time `json:"updatedAt"`
	Value     any       `json:"value"`
}

// rawConfigurationProjection retains fields the current input schema cannot
// interpret. Capability fields are projected without changing the saved target.
type rawConfigurationProjection struct {
	raw          json.RawMessage
	archive      *bool
	capabilities workerprotocol.Capabilities
}

func (v rawConfigurationProjection) MarshalJSON() ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(v.raw, &fields); err != nil {
		return nil, err
	}
	if fields == nil {
		return nil, errors.New("stored worker configuration is not an object")
	}
	if _, exists := fields["enableSudoCleanup"]; !exists {
		fields["enableSudoCleanup"] = json.RawMessage(`false`)
	}
	if !v.capabilities.ToolPaths {
		delete(fields, "toolPaths")
	}
	if v.capabilities.ArchiveSessions {
		if v.archive == nil {
			fields["archiveSessions"] = json.RawMessage(`null`)
		} else if *v.archive {
			fields["archiveSessions"] = json.RawMessage(`true`)
		} else {
			fields["archiveSessions"] = json.RawMessage(`false`)
		}
	} else {
		delete(fields, "archiveSessions")
	}
	return json.Marshal(fields)
}

func projectDesiredConfiguration(desired *model.WorkerDesiredConfiguration, capabilities workerprotocol.Capabilities) *projectedDesiredConfiguration {
	if desired == nil {
		return nil
	}
	if len(desired.Raw) != 0 {
		return &projectedDesiredConfiguration{Revision: desired.Revision, UpdatedAt: desired.UpdatedAt, Value: rawConfigurationProjection{raw: desired.Raw, archive: desired.ArchiveSessions, capabilities: capabilities}}
	}
	value := projectedConfiguration{WorkerConfigurationWire: model.WorkerConfigurationWire(desired.Value)}
	if capabilities.ToolPaths {
		value.ToolPaths = desired.Value.ToolPaths
	}
	if capabilities.ArchiveSessions {
		value.ArchiveSessions = desired.Value.ArchiveSessions
	}
	return &projectedDesiredConfiguration{Revision: desired.Revision, UpdatedAt: desired.UpdatedAt, Value: value}
}

type projectedConfigurationResource struct {
	Desired             *projectedDesiredConfiguration                `json:"desired"`
	ObservationRevision string                                        `json:"observationRevision"`
	Observation         *model.WorkerConfigurationReportedObservation `json:"observation"`
}

func projectConfiguration(resource model.WorkerConfigurationResource, capabilities workerprotocol.Capabilities) projectedConfigurationResource {
	observation := resource.Observation
	if observation != nil {
		copied := *observation
		copied.Items = make([]model.WorkerConfigurationItem, 0, len(observation.Items))
		for _, item := range observation.Items {
			if item.Key.Kind != "agentControlMode" && (item.Key.Kind != "archiveSessions" || capabilities.ArchiveSessions) {
				copied.Items = append(copied.Items, item)
			}
		}
		observation = &copied
	}
	return projectedConfigurationResource{Desired: projectDesiredConfiguration(resource.Desired, capabilities), ObservationRevision: resource.ObservationRevision, Observation: observation}
}

type WorkerConfigurationReceipt struct {
	Desired             *projectedDesiredConfiguration `json:"desired"`
	ObservationRevision string                         `json:"observationRevision"`
	ObservationAccepted bool                           `json:"observationAccepted"`
}

func projectConfigurationReceipt(receipt *model.WorkerConfigurationReceipt, capabilities workerprotocol.Capabilities) *WorkerConfigurationReceipt {
	if receipt == nil {
		return nil
	}
	return &WorkerConfigurationReceipt{Desired: projectDesiredConfiguration(receipt.Desired, capabilities), ObservationRevision: receipt.ObservationRevision, ObservationAccepted: receipt.ObservationAccepted}
}
