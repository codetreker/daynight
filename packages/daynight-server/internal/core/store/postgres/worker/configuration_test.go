package worker

import (
	"errors"
	"testing"
	"time"
)

type workerSnapshotRow func(...any) error

func (row workerSnapshotRow) Scan(values ...any) error { return row(values...) }

func TestWorkerConfigurationStoredDecodeErrors(t *testing.T) {
	sentinel := errors.New("worker configuration scan failed")
	if _, err := scanWorkerConfiguration(workerSnapshotRow(func(...any) error { return sentinel })); !errors.Is(err, sentinel) {
		t.Fatalf("scan error lost: %v", err)
	}
	for _, test := range []struct{ desired, observation string }{{`{"native":"bad"}`, `null`}, {`{}`, `{"items":"bad"}`}} {
		_, err := scanWorkerConfiguration(workerSnapshotRow(func(destinations ...any) error {
			revision := int64(1)
			stamp := time.Now().UTC()
			*destinations[0].(**int64) = &revision
			*destinations[1].(**time.Time) = &stamp
			*destinations[2].(*[]byte) = []byte(test.desired)
			*destinations[4].(*[]byte) = []byte(test.observation)
			return nil
		}))
		if err == nil {
			t.Fatal("typed stored corruption hidden")
		}
	}
}
