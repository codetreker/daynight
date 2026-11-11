package session

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestSessionReaderPreservesQueryAndRowFailures(t *testing.T) {
	cause := errors.New("session state read failed")
	if _, err := NewReader(failedQueryTx{err: cause}).CurrentTaskSessionSources(t.Context(), "project"); !errors.Is(err, cause) {
		t.Fatalf("query cause lost: %v", err)
	}
	for _, stage := range []string{"scan", "iteration"} {
		t.Run(stage, func(t *testing.T) {
			rows := &failedRows{}
			if stage == "scan" {
				rows.next, rows.scanError = true, cause
			} else {
				rows.errorAfterRows = cause
			}
			_, err := NewReader(rowsTx{rows: rows}).CurrentTaskSessionSources(context.Background(), "project")
			if !errors.Is(err, cause) {
				t.Fatalf("row cause lost: %v", err)
			}
			if !rows.closed {
				t.Fatal("row stream was not closed")
			}
		})
	}
}

func TestSessionReaderMetadataDecodesSelectedFields(t *testing.T) {
	var state store.TaskSessionStateSource
	raw := []byte(`{"sessionId":"session","claimId":"claim","executionGeneration":"1","connectionEpoch":"0","identity":{"projectId":"project","taskId":"task","workerId":"worker","worktreeId":"worktree","agentControlMode":"herdr"},"lifecycle":"archived"}`)
	if err := decodeTaskSessionState(raw, &state); err != nil || state.Fence.SessionID != "session" || state.Fence.ExecutionGeneration != "1" || state.Identity.TaskID != "task" || state.Identity.AgentControlMode != "herdr" || state.Lifecycle != "archived" {
		t.Fatalf("selected metadata changed: %#v %v", state, err)
	}
	var invalid *json.UnmarshalTypeError
	if err := decodeTaskSessionState([]byte(`{"executionGeneration":1}`), &state); !errors.As(err, &invalid) {
		t.Fatalf("typed decode cause lost: %v", err)
	}
}

func TestSessionReaderWorkerPreservesJSONDecodeFailure(t *testing.T) {
	var invalid *json.UnmarshalTypeError
	if _, err := taskSessionWorker(`{"claimId":1}`); !errors.As(err, &invalid) {
		t.Fatalf("typed decode cause lost: %v", err)
	}
}
