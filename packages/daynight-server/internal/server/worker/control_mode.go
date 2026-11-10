package worker

import (
	"net/http"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const workerControlModeHeader = "Daynight-Worker-Control-Mode"

func controlModeProtocol(header http.Header) (bool, error) {
	values, exists := header[workerControlModeHeader]
	if !exists {
		return false, nil
	}
	if len(values) != 1 || values[0] != "1" {
		return false, httpx.InvalidInput("Unsupported Worker control mode protocol.")
	}
	return true, nil
}

type projectedConfiguration struct {
	model.WorkerConfigurationWire
	AgentControlMode any `json:"agentControlMode,omitempty"`
}

type projectedDesiredConfiguration struct {
	Revision  string                 `json:"revision"`
	UpdatedAt time.Time              `json:"updatedAt"`
	Value     projectedConfiguration `json:"value"`
}

func projectDesiredConfiguration(desired *model.WorkerDesiredConfiguration, controlMode bool) *projectedDesiredConfiguration {
	if desired == nil {
		return nil
	}
	value := projectedConfiguration{WorkerConfigurationWire: model.WorkerConfigurationWire(desired.Value)}
	value.WorkerConfigurationWire.AgentControlMode = nil
	if controlMode {
		// An interface holding a typed nil emits explicit null; omission belongs only to legacy clients.
		value.AgentControlMode = desired.Value.AgentControlMode
	}
	return &projectedDesiredConfiguration{Revision: desired.Revision, UpdatedAt: desired.UpdatedAt, Value: value}
}

type projectedConfigurationResource struct {
	Desired             *projectedDesiredConfiguration                `json:"desired"`
	ObservationRevision string                                        `json:"observationRevision"`
	Observation         *model.WorkerConfigurationReportedObservation `json:"observation"`
}

func projectConfiguration(resource model.WorkerConfigurationResource, controlMode bool) projectedConfigurationResource {
	observation := resource.Observation
	if !controlMode && observation != nil {
		copied := *observation
		copied.Items = make([]model.WorkerConfigurationItem, 0, len(observation.Items))
		for _, item := range observation.Items {
			if item.Key.Kind != "agentControlMode" {
				copied.Items = append(copied.Items, item)
			}
		}
		observation = &copied
	}
	return projectedConfigurationResource{Desired: projectDesiredConfiguration(resource.Desired, controlMode), ObservationRevision: resource.ObservationRevision, Observation: observation}
}

type WorkerConfigurationReceipt struct {
	Desired             *projectedDesiredConfiguration `json:"desired"`
	ObservationRevision string                         `json:"observationRevision"`
	ObservationAccepted bool                           `json:"observationAccepted"`
}

func projectConfigurationReceipt(receipt *model.WorkerConfigurationReceipt, controlMode bool) *WorkerConfigurationReceipt {
	if receipt == nil {
		return nil
	}
	return &WorkerConfigurationReceipt{Desired: projectDesiredConfiguration(receipt.Desired, controlMode), ObservationRevision: receipt.ObservationRevision, ObservationAccepted: receipt.ObservationAccepted}
}
