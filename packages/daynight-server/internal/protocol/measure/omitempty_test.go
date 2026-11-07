package measure_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/measure"
)

func TestOmitEmptyPreservesZeroWorkerTelemetryStruct(t *testing.T) {
	// A zero struct is retained by encoding/json even when tagged omitempty;
	// nullable Worker telemetry fields within it remain independently omitted.
	value := struct {
		Telemetry model.WorkerTelemetryWire `json:"telemetry,omitempty"`
	}{}
	want, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var got bytes.Buffer
	_, err = measure.JSON(&got, "worker", int64(len(want)), value, false)
	if err != nil || !bytes.Equal(got.Bytes(), want) || !bytes.Contains(got.Bytes(), []byte(`"telemetry"`)) {
		t.Fatalf("got %s want %s err=%v", got.Bytes(), want, err)
	}
}

type stoppedWriter struct{ remaining int }

func (w *stoppedWriter) Write(p []byte) (int, error) {
	if len(p) > w.remaining {
		return 0, io.ErrClosedPipe
	}
	w.remaining -= len(p)
	return len(p), nil
}

func TestWorkerEncodingPropagatesWriterFailures(t *testing.T) {
	value := struct {
		Telemetry model.WorkerTelemetryWire `json:"telemetry,omitempty"`
		Revision  string                    `json:"revision"`
	}{Revision: "2"}
	expected, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	for _, stop := range []int{1, 4, 12, 20, len(expected) - 2} {
		_, err := measure.JSON(&stoppedWriter{remaining: stop}, "worker", int64(len(expected)), value, false)
		if !errors.Is(err, io.ErrClosedPipe) {
			t.Fatalf("stop=%d error=%v", stop, err)
		}
	}
}
