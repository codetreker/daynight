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
	ArchiveSessionsObservation *storedConfigurationItemSlot `json:"archiveSessionsObservation,omitempty"`
}

type storedConfigurationItemSlot struct {
	Index int                           `json:"index"`
	Item  model.WorkerConfigurationItem `json:"item"`
}

// EncodeObservation measures and writes the actual stored shape, including the
// private extension slots. Legacy servers ignore unknown slots without exposing a new item
// kind to strict clients. Public responses still use the inline model encoding.
func EncodeObservation(w io.Writer, value model.WorkerConfigurationReportedObservation, max int64) (int64, error) {
	stored := storedConfigurationObservation{WorkerConfigurationReportedObservationWire: model.WorkerConfigurationReportedObservationWire(value)}
	stored.Items = make([]model.WorkerConfigurationItem, 0, len(value.Items))
	for index, item := range value.Items {
		switch item.Key.Kind {
		case "agentControlMode":
			return 0, fmt.Errorf("worker control mode observations are no longer supported")
		case "archiveSessions":
			if stored.ArchiveSessionsObservation != nil {
				return 0, fmt.Errorf("duplicate stored worker archive sessions observation")
			}
			stored.ArchiveSessionsObservation = &storedConfigurationItemSlot{Index: index, Item: item}
		default:
			stored.Items = append(stored.Items, item)
		}
	}
	if value.Items == nil {
		stored.Items = nil
	}
	return measure.JSON(w, "worker.configuration.observation", max, stored, false)
}

// DecodeStoredObservation accepts historical inline rows and reconstructs the
// current model from private slots. A legacy replacement drops unknown slots, so a
// subsequent read cannot revive stale evidence.
func DecodeStoredObservation(encoded []byte) (*model.WorkerConfigurationReportedObservation, error) {
	var stored *struct {
		model.WorkerConfigurationReportedObservationWire
		ControlModeObservation     json.RawMessage `json:"controlModeObservation"`
		ArchiveSessionsObservation json.RawMessage `json:"archiveSessionsObservation"`
	}
	if err := json.Unmarshal(encoded, &stored); err != nil {
		return nil, err
	}
	if stored == nil {
		return nil, nil
	}
	value := model.WorkerConfigurationReportedObservation(stored.WorkerConfigurationReportedObservationWire)
	insertSlot := func(raw json.RawMessage, kind string) error {
		if len(raw) == 0 {
			return nil
		}
		var slot struct {
			Index *int                           `json:"index"`
			Item  *model.WorkerConfigurationItem `json:"item"`
		}
		if err := json.Unmarshal(raw, &slot); err != nil {
			return fmt.Errorf("decode stored worker %s observation: %w", kind, err)
		}
		if slot.Index == nil || slot.Item == nil || slot.Item.Key.Kind != kind || slot.Item.Key.ProjectID != "" || value.Items == nil || *slot.Index < 0 || *slot.Index > len(value.Items) {
			return fmt.Errorf("invalid stored worker %s observation", kind)
		}
		for _, item := range value.Items {
			if item.Key.Kind == kind {
				return fmt.Errorf("duplicate stored worker %s observation", kind)
			}
		}
		value.Items = slices.Insert(value.Items, *slot.Index, *slot.Item)
		return nil
	}
	// Historical mode indices exclude the archive slot; restore mode first so
	// that the archive index still addresses the original observation.
	if err := insertSlot(stored.ControlModeObservation, "agentControlMode"); err != nil {
		return nil, err
	}
	if err := insertSlot(stored.ArchiveSessionsObservation, "archiveSessions"); err != nil {
		return nil, err
	}
	return &value, nil
}
