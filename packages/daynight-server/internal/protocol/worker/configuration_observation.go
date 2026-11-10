package worker

import (
	"encoding/json"
	"fmt"
	"io"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/measure"
)

type storedConfigurationObservation struct {
	model.WorkerConfigurationReportedObservationWire
	ControlModeObservation *storedControlModeObservation `json:"controlModeObservation,omitempty"`
}

type storedControlModeObservation struct {
	Index int                           `json:"index"`
	Item  model.WorkerConfigurationItem `json:"item"`
}

// EncodeObservation measures and writes the actual stored shape, including the
// private mode slot. Legacy servers ignore that slot without exposing a new item
// kind to strict clients. Public responses still use the inline model encoding.
func EncodeObservation(w io.Writer, value model.WorkerConfigurationReportedObservation, max int64) (int64, error) {
	stored := storedConfigurationObservation{WorkerConfigurationReportedObservationWire: model.WorkerConfigurationReportedObservationWire(value)}
	for index, item := range value.Items {
		if item.Key.Kind != "agentControlMode" {
			continue
		}
		if stored.ControlModeObservation != nil {
			return 0, fmt.Errorf("duplicate stored worker control mode observation")
		}
		stored.ControlModeObservation = &storedControlModeObservation{Index: index, Item: item}
		stored.Items = make([]model.WorkerConfigurationItem, 0, len(value.Items)-1)
		stored.Items = append(stored.Items, value.Items[:index]...)
		stored.Items = append(stored.Items, value.Items[index+1:]...)
	}
	return measure.JSON(w, "worker.configuration.observation", max, stored, false)
}

// DecodeStoredObservation accepts historical inline rows and reconstructs the
// current model from the private slot. A legacy replacement drops the slot, so a
// subsequent read cannot revive stale mode evidence.
func DecodeStoredObservation(encoded []byte) (*model.WorkerConfigurationReportedObservation, error) {
	var stored *struct {
		model.WorkerConfigurationReportedObservationWire
		ControlModeObservation json.RawMessage `json:"controlModeObservation"`
	}
	if err := json.Unmarshal(encoded, &stored); err != nil {
		return nil, err
	}
	if stored == nil {
		return nil, nil
	}
	value := model.WorkerConfigurationReportedObservation(stored.WorkerConfigurationReportedObservationWire)
	if len(stored.ControlModeObservation) == 0 {
		return &value, nil
	}
	var mode struct {
		Index *int                           `json:"index"`
		Item  *model.WorkerConfigurationItem `json:"item"`
	}
	if err := json.Unmarshal(stored.ControlModeObservation, &mode); err != nil {
		return nil, fmt.Errorf("decode stored worker control mode observation: %w", err)
	}
	if mode.Index == nil || mode.Item == nil || mode.Item.Key.Kind != "agentControlMode" || mode.Item.Key.ProjectID != "" || value.Items == nil || *mode.Index < 0 || *mode.Index > len(value.Items) {
		return nil, fmt.Errorf("invalid stored worker control mode observation")
	}
	for _, item := range value.Items {
		if item.Key.Kind == "agentControlMode" {
			return nil, fmt.Errorf("duplicate stored worker control mode observation")
		}
	}
	value.Items = slices.Insert(value.Items, *mode.Index, *mode.Item)
	return &value, nil
}
