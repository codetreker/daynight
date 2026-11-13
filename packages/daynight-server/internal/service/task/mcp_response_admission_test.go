package task

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

func mcpAdmissionTask() model.Task {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return model.Task{
		ID: "22222222-2222-4222-8222-222222222222", ProjectID: "11111111-1111-4111-8111-111111111111",
		Title: "Task", Version: 1, Status: model.TaskTodo, Ready: true,
		CreatedAt: now, UpdatedAt: now, Properties: model.TaskProperties{},
		DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{},
	}
}

func mcpAdmissionSize(t *testing.T, task model.Task, changed bool, rpcID any, modern, batch, full bool) int {
	t.Helper()
	outcome := "unchanged"
	if changed {
		outcome = "changed"
	}
	n, err := taskprotocol.EncodeMCPResponse(io.Discard, task, "rpc-test", outcome, rpcID, modern, full, math.MaxInt64)
	if err != nil {
		t.Fatal(err)
	}
	if id, ok := rpcID.(string); ok && !batch {
		n -= int64(5 * (strings.Count(id, "<") + strings.Count(id, ">") + strings.Count(id, "&")))
	}
	return int(n)
}

func TestMCPResponseAdmissionExactSingleAndBatchBoundaries(t *testing.T) {
	task := mcpAdmissionTask()
	for _, tc := range []struct {
		name      string
		character string
		batch     bool
	}{
		{"single ASCII", "x", false},
		{"single unescaped HTML ID", "<", false},
		{"batch item", "x", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			length := taskcore.MaxTaskResponseJSONBytes - mcpAdmissionSize(t, task, false, tc.character, false, tc.batch, true) + 1
			exact := strings.Repeat(tc.character, length)
			if size := mcpAdmissionSize(t, task, false, exact, false, tc.batch, true); size != taskcore.MaxTaskResponseJSONBytes {
				t.Fatalf("exact response fixture=%d, want %d", size, taskcore.MaxTaskResponseJSONBytes)
			}
			if err := admitTaskResponse(WithMCPTaskResponse(t.Context(), "rpc-test", exact, false, tc.batch, true), task, false); err != nil {
				t.Fatalf("exact response refused: %v", err)
			}
			excess := exact + tc.character
			if size := mcpAdmissionSize(t, task, false, excess, false, tc.batch, true); size != taskcore.MaxTaskResponseJSONBytes+1 {
				t.Fatalf("excess response fixture=%d, want %d", size, taskcore.MaxTaskResponseJSONBytes+1)
			}
			assertResponseLimit(t, admitTaskResponse(WithMCPTaskResponse(t.Context(), "rpc-test", excess, false, tc.batch, true), task, false))
		})
	}
}

func TestMCPResponseAdmissionSeparatesSummaryAndFullPropertyResults(t *testing.T) {
	task := mcpAdmissionTask()
	task.Description = strings.Repeat("d", 65536)
	rpcID := strings.Repeat("x", 490000)
	if size := mcpAdmissionSize(t, task, false, rpcID, false, false, false); size > taskcore.MaxTaskResponseJSONBytes {
		t.Fatalf("summary fixture is already oversized: %d", size)
	}
	if err := admitTaskResponse(WithMCPTaskResponse(t.Context(), "rpc-test", rpcID, false, false, false), task, false); err != nil {
		t.Fatalf("summary response refused: %v", err)
	}
	if size := mcpAdmissionSize(t, task, false, rpcID, false, false, true); size <= taskcore.MaxTaskResponseJSONBytes {
		t.Fatalf("full fixture does not exceed budget: %d", size)
	}
	assertResponseLimit(t, admitTaskResponse(WithMCPTaskResponse(t.Context(), "rpc-test", rpcID, false, false, true), task, false))
	task.Version++
	task.Properties = model.TaskProperties{"pullRequests": json.RawMessage(`[]`)}
	if err := admitTaskResponse(WithMCPTaskResponse(t.Context(), "rpc-test", rpcID, false, false, false), task, true); err != nil {
		t.Fatalf("changed property summary refused: %v", err)
	}
}

func TestMCPResponseAdmissionUsesEachBatchCallID(t *testing.T) {
	task := mcpAdmissionTask()
	if err := admitTaskResponse(WithMCPTaskResponse(t.Context(), "rpc-test", strings.Repeat("<", 30000), false, true, true), task, false); err != nil {
		t.Fatalf("bounded escaped batch ID refused: %v", err)
	}
	if err := admitTaskResponse(WithMCPTaskResponse(t.Context(), "rpc-test", "small", false, true, true), task, true); err != nil {
		t.Fatalf("small batch call refused: %v", err)
	}
	assertResponseLimit(t, admitTaskResponse(WithMCPTaskResponse(t.Context(), "rpc-test", strings.Repeat("<", 90000), false, true, true), task, true))
}

func TestMCPResponseAdmissionUsesCompleteWireForBothProtocols(t *testing.T) {
	task := mcpAdmissionTask()
	for _, modern := range []bool{false, true} {
		for i, rpcID := range []any{int64(0), "<&世界", strings.Repeat("<", 100000)} {
			changed := i == 0
			if size := mcpAdmissionSize(t, task, changed, rpcID, modern, false, true); size > taskcore.MaxTaskResponseJSONBytes {
				t.Fatalf("accepted response fixture is oversized: modern=%t id=%T size=%d", modern, rpcID, size)
			}
			if err := admitTaskResponse(WithMCPTaskResponse(t.Context(), "rpc-test", rpcID, modern, false, true), task, changed); err != nil {
				t.Fatalf("complete response refused: modern=%t id=%T: %v", modern, rpcID, err)
			}
		}
		assertResponseLimit(t, admitTaskResponse(WithMCPTaskResponse(t.Context(), "rpc-test", strings.Repeat("x", 600*1024), modern, false, true), task, true))
	}
}

func TestMCPTaggedResponseAdmissionReservesRenameInWireEnvelope(t *testing.T) {
	actual := mcpAdmissionTask()
	actual.Tags = []model.TagReference{{ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Name: "short"}, {ID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", Name: "标签"}}
	actual.Description = strings.Repeat("d", 65536)
	reserved := actual
	reserved.Tags = []model.TagReference{{ID: actual.Tags[0].ID, Name: strings.Repeat("&", 64)}, {ID: actual.Tags[1].ID, Name: strings.Repeat("&", 64)}}
	reserved.Version = math.MaxInt64
	reserved.UpdatedAt = time.Date(9999, 12, 31, 23, 59, 59, 999999999, time.UTC)
	before := actual
	before.Tags = append([]model.TagReference(nil), actual.Tags...)
	for _, modern := range []bool{false, true} {
		for _, batch := range []bool{false, true} {
			for _, full := range []bool{false, true} {
				for _, changed := range []bool{false, true} {
					t.Run(fmt.Sprintf("modern=%t/batch=%t/full=%t/changed=%t", modern, batch, full, changed), func(t *testing.T) {
						prefix := "<&世界"
						base := mcpAdmissionSize(t, reserved, changed, prefix, modern, batch, full)
						rpcID := prefix + strings.Repeat("x", taskcore.MaxTaskResponseJSONBytes-base)
						if size := mcpAdmissionSize(t, reserved, changed, rpcID, modern, batch, full); size != taskcore.MaxTaskResponseJSONBytes {
							t.Fatalf("reserved wire size=%d", size)
						}
						ctx := WithMCPTaskResponse(t.Context(), "rpc-test", rpcID, modern, batch, full)
						if err := admitTaskResponse(ctx, actual, changed); err != nil {
							t.Fatalf("exact reserved envelope rejected: %v", err)
						}
						if !reflect.DeepEqual(actual, before) {
							t.Fatal("admission changed actual tag references")
						}
						excess := rpcID + "x"
						if size := mcpAdmissionSize(t, actual, changed, excess, modern, batch, full); size >= taskcore.MaxTaskResponseJSONBytes {
							t.Fatalf("actual short names should fit: %d", size)
						}
						assertResponseLimit(t, admitTaskResponse(WithMCPTaskResponse(t.Context(), "rpc-test", excess, modern, batch, full), actual, changed))
					})
				}
			}
		}
	}
}
