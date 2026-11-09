package task_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestStepsHTTPMovePlacementsAndUnchangedReceipts(t *testing.T) {
	for _, tc := range []struct {
		name, id string
		input    taskservice.MoveTaskStep
		order    []int
		changed  bool
	}{
		{"after", "ABCDEF01", taskservice.MoveTaskStep{Version: 9007199254740993, After: stepHTTPString("FEDCBA98")}, []int{1, 2, 0, 3}, true},
		{"before", "FEDCBA98", taskservice.MoveTaskStep{Version: 9007199254740993, Before: stepHTTPString("ABCDEF01")}, []int{2, 0, 1, 3}, true},
		{"first", "11111111", taskservice.MoveTaskStep{Version: 9007199254740993, Position: stepHTTPString("first")}, []int{3, 0, 1, 2}, true},
		{"last", "ABCDEF01", taskservice.MoveTaskStep{Version: 9007199254740993, Position: stepHTTPString("last")}, []int{1, 2, 3, 0}, true},
		{"unchanged before", "ABCDEF01", taskservice.MoveTaskStep{Version: 9007199254740993, Before: stepHTTPString("00000000")}, []int{0, 1, 2, 3}, false},
		{"unchanged after", "FEDCBA98", taskservice.MoveTaskStep{Version: 9007199254740993, After: stepHTTPString("00000000")}, []int{0, 1, 2, 3}, false},
		{"unchanged first", "ABCDEF01", taskservice.MoveTaskStep{Version: 9007199254740993, Position: stepHTTPString("first")}, []int{0, 1, 2, 3}, false},
		{"unchanged last at max", "11111111", taskservice.MoveTaskStep{Version: 9223372036854775807, Position: stepHTTPString("last")}, []int{0, 1, 2, 3}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs bytes.Buffer
			h := newHTTPFixture(t, &logs)
			before := stepHTTPRows()
			rows := make([]api.TaskStep, len(tc.order))
			for i, index := range tc.order {
				rows[i] = before[index]
			}
			version := tc.input.Version
			if tc.changed {
				version++
			}
			result := stepHTTPWrite(t, version, rows, tc.changed)
			h.Steps.MoveFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
				checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
				if id != strings.ToLower(tc.id) || !reflect.DeepEqual(input, tc.input) {
					t.Fatalf("Move arguments changed: %s %+v", id, input)
				}
				return result, nil
			}
			values := map[string]any{"version": tc.input.Version}
			if tc.input.Before != nil {
				values["before"] = *tc.input.Before
			}
			if tc.input.After != nil {
				values["after"] = *tc.input.After
			}
			if tc.input.Position != nil {
				values["position"] = *tc.input.Position
			}
			response := projectRequest(h, "PUT", stepHTTPPath()+"/"+tc.id+"/position", jsonBody(t, values))
			resource := decodeResponse[api.StepsResource](t, response, 200)
			if resource.ProjectID != testProjectID || resource.TaskID != testTaskID || resource.Version != version || !reflect.DeepEqual(resource.Steps, rows) || !bytes.Equal(response.Body.Bytes(), result.JSON) || response.Header().Get("Location") != "" || response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != h.principal.UserID {
				t.Fatal("move result or metadata changed")
			}
			if tc.changed != strings.Contains(logs.String(), `"phase":"persist"`) || !strings.Contains(logs.String(), `"operation":"move"`) || !strings.Contains(logs.String(), `"tx_outcome":"committed"`) {
				t.Fatal("move diagnostic facts changed")
			}
			if !tc.changed && !strings.Contains(logs.String(), `"outcome":"unchanged"`) {
				t.Fatal("unchanged result claimed mutation")
			}
			if strings.Contains(logs.String(), "完整 Markdown") || strings.Contains(logs.String(), "<同名") {
				t.Fatal("move content leaked")
			}
		})
	}
}

func TestStepsHTTPMoveStrictInputAndMethods(t *testing.T) {
	h := newHTTPFixture(t, io.Discard)
	endpoint := stepHTTPPath() + "/abcdef01/position"
	good := `{"version":1,"position":"first"}`
	bad := []string{"", `{}`, `null`, `[]`, `{`, good + ` {}`, `{"position":"first"}`, `{"version":1,"first":true}`, `{"version":1,"last":true}`, `{"version":1,"position":"\ud800"}`, `{"version":1,"before":"\udfff"}`, `{"version":1,"position":"` + string([]byte{0xff}) + `"}`, `{"version":1,"position":"first","\u0070osition":"last"}`}
	for _, field := range []string{"version", "before", "after", "position"} {
		for _, value := range []string{"null", "false", "1", "[]", "{}"} {
			input := map[string]json.RawMessage{"version": json.RawMessage("1")}
			if field == "version" {
				input["position"] = json.RawMessage(`"first"`)
			}
			input[field] = json.RawMessage(value)
			encoded, err := json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
			if field == "version" && value == "1" {
				continue
			}
			bad = append(bad, string(encoded))
		}
	}
	for _, version := range []string{`0`, `-1`, `1.0`, `1e0`, `9223372036854775808`, `"1"`} {
		bad = append(bad, strings.Replace(good, `"version":1`, `"version":`+version, 1))
	}
	for _, field := range []string{"id", "title", "description", "status", "createdAt", "updatedAt", "unknown"} {
		bad = append(bad, strings.TrimSuffix(good, "}")+`,"`+field+`":"x"}`)
	}
	for index, body := range bad {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			assertProjectError(t, projectRequest(h, "PUT", endpoint, body), 400, "invalid_input")
		})
	}
	for _, suffix := range []string{"?", "?x=1", "?bad=%xx"} {
		assertProjectError(t, projectRequest(h, "PUT", endpoint+suffix, good), 400, "invalid_input")
	}
	for _, id := range []string{"abc", "000000000", "0000000g"} {
		assertProjectError(t, projectRequest(h, "PUT", stepHTTPPath()+"/"+id+"/position", good), 400, "invalid_input")
	}
	request := httptest.NewRequest("PUT", endpoint, strings.NewReader(good))
	authorizeResourceRequest(h, request)
	request.Header.Set("X-Request-ID", "project-test")
	request.Header.Set("Content-Type", "text/plain")
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	assertProjectError(t, response, 400, "invalid_input")
	assertProjectError(t, projectRequest(h, "PUT", endpoint, `{"version":1,"position":"`+strings.Repeat("x", httpx.MaxJSONBody)+`"}`), 413, "payload_too_large")
	for _, method := range []string{"GET", "HEAD", "POST", "PATCH", "DELETE", "OPTIONS"} {
		response := projectRequest(h, method, endpoint, `{}`)
		if response.Code != 405 || response.Header().Get("Allow") != "PUT" || response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("position method fallback changed")
		}
	}
	if h.Steps.TotalCalls() != 0 {
		t.Fatal("protocol rejection invoked Step service")
	}
}

func TestStepsHTTPMoveDomainRefusalsAndExactBodyBoundary(t *testing.T) {
	invalid := []map[string]any{{"version": 1}, {"version": 1, "before": "00000000", "after": "12345678"}, {"version": 1, "before": "00000000", "position": "first"}, {"version": 1, "after": "00000000", "position": "last"}}
	for _, position := range []string{"FIRST", "", "middle"} {
		invalid = append(invalid, map[string]any{"version": 1, "position": position})
	}
	for _, field := range []string{"before", "after"} {
		for _, id := range []string{"", "abc", "000000000", "0000000g"} {
			invalid = append(invalid, map[string]any{"version": 1, field: id})
		}
	}
	for i, values := range invalid {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			expected := taskservice.MoveTaskStep{Version: 1}
			if value, ok := values["before"].(string); ok {
				expected.Before = &value
			}
			if value, ok := values["after"].(string); ok {
				expected.After = &value
			}
			if value, ok := values["position"].(string); ok {
				expected.Position = &value
			}
			h.Steps.MoveFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
				checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
				if id != "abcdef01" || !reflect.DeepEqual(input, expected) {
					t.Fatal("placement value changed before service")
				}
				return taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}, &model.Fault{Code: "invalid_input", Message: "Invalid Step placement."}
			}
			assertProjectError(t, projectRequest(h, "PUT", stepHTTPPath()+"/ABCDEF01/position", jsonBody(t, values)), 400, "invalid_input")
		})
	}
	for _, tc := range []struct {
		name, id, code string
		version        int64
		status         int
	}{
		{"stale", "abcdef01", "version_conflict", 1, 409}, {"missing target", "ffffffff", "not_found", 1, 404},
		{"missing anchor", "abcdef01", "not_found", 1, 404}, {"exhausted", "abcdef01", "version_exhausted", 9223372036854775807, 409}, {"deleted parent", "ffffffff", "task_deleted", 1, 410},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHTTPFixture(t, io.Discard)
			h.Steps.MoveFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
				checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
				if id != tc.id || input.Version != tc.version || input.Before == nil || *input.Before != "ffffffff" {
					t.Fatal("Move refusal arguments changed")
				}
				return taskservice.StepsWriteResult{Phase: "prepare", TransactionOutcome: store.TransactionNotCommitted}, &model.Fault{Code: tc.code, Message: "Step move refused."}
			}
			assertProjectError(t, projectRequest(h, "PUT", stepHTTPPath()+"/"+strings.ToUpper(tc.id)+"/position", jsonBody(t, map[string]any{"version": tc.version, "before": "ffffffff"})), tc.status, tc.code)
		})
	}
	t.Run("exact body boundary", func(t *testing.T) {
		h := newHTTPFixture(t, io.Discard)
		result := stepHTTPWrite(t, 2, stepHTTPRows(), true)
		h.Steps.MoveFunc = func(ctx context.Context, p model.Principal, projectID, taskID, id string, input taskservice.MoveTaskStep) (taskservice.StepsWriteResult, error) {
			checkStepHTTPCall(t, h, ctx, p, projectID, taskID)
			if id != "abcdef01" || input.Version != 1 || input.Position == nil || *input.Position != "first" || input.Before != nil || input.After != nil {
				t.Fatal("body whitespace changed placement")
			}
			return result, nil
		}
		body := `{"version":1,"position":"first"}`
		exact := body + strings.Repeat(" ", httpx.MaxJSONBody-len(body))
		response := projectRequest(h, "PUT", stepHTTPPath()+"/ABCDEF01/position", exact)
		if len(exact) != httpx.MaxJSONBody || response.Code != 200 || !bytes.Equal(response.Body.Bytes(), result.JSON) {
			t.Fatal("exact request boundary failed")
		}
	})
}

func TestStepsHTTPMoveCommittedResponseLossAndReadOnlyReconcile(t *testing.T) {
	stepHTTPResponseLoss(t, "move")
}
