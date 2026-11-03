package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func TestAcceptanceCLIWaitSuccessfulPatchLogsRequiresBothRequests(t *testing.T) {
	first := `{"type":"http_request","method":"PATCH","status":200,"request_id":"external-flags-only"}` + "\n"
	second := `{"type":"http_request","method":"PATCH","status":200,"request_id":"external-flags-noop"}` + "\n"
	for _, test := range []struct {
		name string
		logs string
	}{
		{"unrelated_count_trap", `{"type":"http_request","method":"PATCH","status":200,"request_id":"earlier-write-one"}` + "\n" + `{"type":"http_request","method":"PATCH","status":200,"request_id":"earlier-write-two"}` + "\n"},
		{"first_only", first},
		{"second_only", second},
		{"duplicate_first", first + first},
		{"duplicate_second", second + second},
		{"wrong_type", first + `{"type":"operation_error","method":"PATCH","status":200,"request_id":"external-flags-noop"}` + "\n"},
		{"wrong_method", first + `{"type":"http_request","method":"PUT","status":200,"request_id":"external-flags-noop"}` + "\n"},
		{"refused_status", first + `{"type":"http_request","method":"PATCH","status":409,"request_id":"external-flags-noop"}` + "\n"},
		{"other_success_status", first + `{"type":"http_request","method":"PATCH","status":201,"request_id":"external-flags-noop"}` + "\n"},
		{"wrong_request_id", first + `{"type":"http_request","method":"PATCH","status":200,"request_id":"external-flags-noop-other"}` + "\n"},
		{"missing_request_id", first + `{"type":"http_request","method":"PATCH","status":200}` + "\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			logs := &acceptanceLogs{}
			if count, err := logs.Write([]byte(test.logs)); err != nil || count != len(test.logs) || logs.invalid {
				t.Fatal("cannot supply complete acceptance log records")
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if err := acceptanceCLIWaitSuccessfulPatchLogs(ctx, logs, "external-flags-only", "external-flags-noop"); !errors.Is(err, context.Canceled) {
				t.Fatalf("incomplete request identities released the log barrier: %v", err)
			}
			complete := first + second
			if count, err := logs.Write([]byte(complete)); err != nil || count != len(complete) || logs.invalid {
				t.Fatal("cannot supply the required acceptance request records")
			}
			if err := acceptanceCLIWaitSuccessfulPatchLogs(ctx, logs, "external-flags-only", "external-flags-noop"); err != nil {
				t.Fatalf("complete request identities were not observed before cancellation: %v", err)
			}
		})
	}
}

func TestAcceptanceCLIWaitSuccessfulPatchLogsRequiresCompleteJSONLine(t *testing.T) {
	logs := &acceptanceLogs{}
	first := `{"type":"http_request","method":"PATCH","status":200,"request_id":"external-flags-only"}` + "\n"
	second := `{"type":"http_request","method":"PATCH","status":200,"request_id":"external-flags-noop"}`
	partial := first + second
	if count, err := logs.Write([]byte(partial)); err != nil || count != len(partial) || logs.invalid {
		t.Fatal("cannot supply the acceptance log chunks")
	}
	if len(logs.events) != 1 || string(logs.pending) != second {
		t.Fatal("the fixture did not withhold the unterminated request record")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := acceptanceCLIWaitSuccessfulPatchLogs(ctx, logs, "external-flags-only", "external-flags-noop"); !errors.Is(err, context.Canceled) {
		t.Fatalf("an unterminated JSON record released the log barrier: %v", err)
	}
	if count, err := logs.Write([]byte("\n")); err != nil || count != 1 || logs.invalid {
		t.Fatal("cannot complete the pending acceptance log record")
	}
	if err := acceptanceCLIWaitSuccessfulPatchLogs(ctx, logs, "external-flags-only", "external-flags-noop"); err != nil {
		t.Fatalf("the completed request record did not release the log barrier: %v", err)
	}
	if len(logs.events) != 2 || len(logs.pending) != 0 {
		t.Fatal("the request log barrier changed the parsed or pending records")
	}
}

func TestAcceptanceCLIWaitSuccessfulPatchLogsPreservesRecordsInEitherOrder(t *testing.T) {
	first := `{"type":"http_request","method":"PATCH","status":200,"request_id":"external-flags-only"}` + "\n"
	second := `{"type":"http_request","method":"PATCH","status":200,"request_id":"external-flags-noop"}` + "\n"
	unrelated := `{"type":"http_request","method":"PATCH","status":200,"request_id":"unrelated-write"}` + "\n"
	for _, test := range []struct {
		name, records string
	}{
		{"request_order", unrelated + first + unrelated + second},
		{"reverse_order", unrelated + second + unrelated + first},
	} {
		t.Run(test.name, func(t *testing.T) {
			logs := &acceptanceLogs{}
			if count, err := logs.Write([]byte(test.records)); err != nil || count != len(test.records) || logs.invalid {
				t.Fatal("cannot supply the ordered acceptance request records")
			}
			before, err := json.Marshal(logs.events)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			if err := acceptanceCLIWaitSuccessfulPatchLogs(ctx, logs, "external-flags-only", "external-flags-noop"); err != nil {
				t.Fatalf("request arrival order changed the completed log barrier: %v", err)
			}
			after, err := json.Marshal(logs.events)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(before, after) || len(logs.pending) != 0 || !logs.matches(map[string]any{"type": "http_request", "request_id": "unrelated-write"}) {
				t.Fatal("the log barrier consumed or changed existing acceptance records")
			}
		})
	}
}
