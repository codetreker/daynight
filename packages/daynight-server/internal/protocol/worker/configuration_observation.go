package worker

import (
	"encoding/json"
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/measure"
)

func EncodeObservation(w io.Writer, value model.WorkerConfigurationReportedObservation, max int64) (int64, error) {
	return measure.JSON(w, "worker.configuration.observation", max, model.WorkerConfigurationReportedObservationWire(value), false)
}

// The private slot in old observations is ignored; the remaining observations
// are retained as historical facts without synthesizing a mode projection.
func DecodeStoredObservation(encoded []byte) (*model.WorkerConfigurationReportedObservation, error) {
	var stored *model.WorkerConfigurationReportedObservationWire
	if err := json.Unmarshal(encoded, &stored); err != nil {
		return nil, err
	}
	if stored == nil {
		return nil, nil
	}
	value := model.WorkerConfigurationReportedObservation(*stored)
	items := make([]model.WorkerConfigurationItem, 0, len(value.Items))
	for _, item := range value.Items {
		if item.Key.Kind != "agentControlMode" {
			items = append(items, item)
		}
	}
	value.Items = items
	return &value, nil
}
