package session

import (
	"context"
	"errors"
	"fmt"
	"strings"
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

func readerStateFields() [14]*string {
	var fields [14]*string
	for _, i := range []int{0, 1, 2, 3, 4, 5, 8, 9, 10, 11} {
		value := fmt.Sprintf("00000000-0000-4000-8000-%012d", i+1)
		fields[i] = &value
	}
	for i, value := range map[int]string{6: "1", 7: "0", 12: "web", 13: "active"} {
		fields[i] = &value
	}
	return fields
}

func TestSessionReaderMetadataRequiresAllSelectedFields(t *testing.T) {
	for i := range 14 {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			fields := readerStateFields()
			fields[i] = nil
			if err := decodeTaskSessionState(fields, &store.TaskSessionStateSource{}); err == nil {
				t.Fatalf("missing field %d accepted", i)
			}
		})
	}
	for _, i := range []int{0, 1, 2, 3, 4, 5, 8, 9, 10, 11} {
		t.Run("canonical "+fmt.Sprint(i), func(t *testing.T) {
			fields := readerStateFields()
			value := "00000000-0000-4000-8000-00000000000A"
			fields[i] = &value
			if err := decodeTaskSessionState(fields, &store.TaskSessionStateSource{}); err == nil {
				t.Fatalf("noncanonical field %d accepted", i)
			}
		})
	}
	for _, test := range []struct {
		index int
		value string
	}{{6, "-1"}, {6, "1.0"}, {7, "+1"}, {7, "00"}, {12, "invalid"}, {13, "invalid"}} {
		t.Run(fmt.Sprintf("%d %s", test.index, test.value), func(t *testing.T) {
			fields := readerStateFields()
			fields[test.index] = &test.value
			if err := decodeTaskSessionState(fields, &store.TaskSessionStateSource{}); err == nil {
				t.Fatalf("invalid field %d accepted", test.index)
			}
		})
	}
	fields := readerStateFields()
	mode, lifecycle := "herdr", "archived"
	fields[12], fields[13] = &mode, &lifecycle
	var state store.TaskSessionStateSource
	if err := decodeTaskSessionState(fields, &state); err != nil || state.Identity.AgentControlMode != mode || state.Lifecycle != lifecycle {
		t.Fatalf("supported durable metadata refused: %#v %v", state, err)
	}
}

func TestSessionReaderWorkerRejectsUnboundedAndInvalidValues(t *testing.T) {
	for _, raw := range []string{strings.Repeat(" ", 8193), `{"claimId":"invalid"}`, `null`} {
		if _, err := taskSessionWorker(raw); err == nil {
			t.Fatalf("invalid worker accepted: %q", raw[:min(len(raw), 60)])
		}
	}
}
