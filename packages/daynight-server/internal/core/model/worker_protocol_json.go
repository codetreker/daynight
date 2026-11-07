package model

import (
	"bytes"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/measure"
)

// The wire types avoid recursively invoking MarshalJSON while sharing the
// exact field layout with the persisted models.
type WorkerTelemetryWire WorkerTelemetry
type WorkerConfigurationWire WorkerConfiguration
type WorkerConfigurationReportedObservationWire WorkerConfigurationReportedObservation

func (v WorkerTelemetry) MarshalJSON() ([]byte, error) { return workerJSON(WorkerTelemetryWire(v)) }
func (v WorkerConfiguration) MarshalJSON() ([]byte, error) {
	return workerJSON(WorkerConfigurationWire(v))
}
func (v WorkerConfigurationReportedObservation) MarshalJSON() ([]byte, error) {
	return workerJSON(WorkerConfigurationReportedObservationWire(v))
}
func workerJSON(value any) ([]byte, error) {
	var b bytes.Buffer
	_, err := measure.JSON(&b, "worker", math.MaxInt64, value, false)
	return b.Bytes(), err
}
