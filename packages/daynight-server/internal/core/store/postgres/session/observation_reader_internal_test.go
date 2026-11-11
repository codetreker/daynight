package session

import (
	"errors"
	"testing"
)

func TestObservationReaderPreservesQueryFailures(t *testing.T) {
	cause := errors.New("observation query failed")
	reader := NewReader(failedQueryTx{err: cause})
	if _, err := reader.TaskSessionSources(t.Context(), "project", []string{"task"}); !errors.Is(err, cause) {
		t.Fatalf("source cause lost: %v", err)
	}
	if _, err := reader.TaskSessionInspectionSource(t.Context(), "project", "task", "session"); !errors.Is(err, cause) {
		t.Fatalf("inspection cause lost: %v", err)
	}
}
