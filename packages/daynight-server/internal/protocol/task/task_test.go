package task

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
)

func TestTaskWireMatchesProductionEncoding(t *testing.T) {
	now := time.Date(2026, 11, 7, 9, 0, 0, 0, time.FixedZone("other", 3600))
	task := model.Task{ID: "id", ProjectID: "project", Title: "<&世界", Description: "line\nquote\"", Properties: model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"<","title":"&"}]`), "paused": json.RawMessage(`false`)}, Version: 9223372036854775807, CreatedAt: now, UpdatedAt: now, DependsOn: []string{"d"}}
	for _, extended := range []bool{false, true} {
		value, err := RESTTask(task, extended)
		if err != nil {
			t.Fatal(err)
		}
		var want, got bytes.Buffer
		if err := json.NewEncoder(&want).Encode(restWire(value)); err != nil {
			t.Fatal(err)
		}
		n, err := EncodeREST(&got, task, extended, int64(want.Len()))
		if err != nil || n != int64(want.Len()) || !bytes.Equal(got.Bytes(), want.Bytes()) {
			t.Fatalf("REST err=%v got %s want %s", err, got.Bytes(), want.Bytes())
		}
		_, err = EncodeREST(io.Discard, task, extended, int64(want.Len()-1))
		var limit *limit.Violation
		if !errors.As(err, &limit) {
			t.Fatalf("REST budget: %v", err)
		}
	}
	value := MCPEnvelope{Data: MCPTask(task), Meta: &MCPMeta{RequestID: "r<&", Outcome: "changed"}}
	want, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var got bytes.Buffer
	n, err := EncodeMCP(&got, task, "r<&", "changed", int64(len(want)))
	if err != nil || n != int64(len(want)) || !bytes.Equal(got.Bytes(), want) {
		t.Fatalf("MCP err=%v got %s want %s", err, got.Bytes(), want)
	}
	if !strings.Contains(string(want), `"version":"9223372036854775807"`) {
		t.Fatal("MCP version is not a decimal string")
	}
}

func TestLegacyWorkerProjection(t *testing.T) {
	id := "d41a4e82-6bf0-4c7f-b519-47076dafc425"
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	claim := &model.WorkerClaim{ClaimID: id, State: model.WorkerActive, UserID: id, WorkerID: id, Machine: model.WorkerMachine{ID: id, Name: "x"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: id, Phase: model.WorkerExecuting, Herdr: &model.WorkerHerdr{Session: "s", WorkspaceID: "w", PaneID: "p"}, ClaimedAt: now}
	raw, err := taskproperty.EncodeWorker(claim)
	if err != nil {
		t.Fatal(err)
	}
	v := model.Task{Properties: model.TaskProperties{"worker": raw}, CreatedAt: now, UpdatedAt: now}
	legacy, err := RESTTask(v, false)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(legacy.Properties["worker"], []byte("agentControlMode")) {
		t.Fatal("legacy leaks new field")
	}
	extended, err := RESTTask(v, true)
	if err != nil || !bytes.Contains(extended.Properties["worker"], []byte("agentControlMode")) {
		t.Fatalf("extended: %s %v", extended.Properties["worker"], err)
	}
	claim.Agent = model.AgentClaude
	raw, err = taskproperty.EncodeWorker(claim)
	if err != nil {
		t.Fatal(err)
	}
	v.Properties["worker"] = raw
	legacy, err = RESTTask(v, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := legacy.Properties["worker"]; exists {
		t.Fatal("incompatible worker retained")
	}
	v.Properties["worker"] = json.RawMessage(`{`)
	if _, err = RESTTask(v, false); err == nil {
		t.Fatal("invalid worker accepted")
	}
	if _, err = EncodeREST(io.Discard, v, false, 1000); err == nil {
		t.Fatal("invalid worker measured")
	}
}

func TestRESTProductionMarshalMatchesOriginal(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	task := model.Task{ID: "id", Title: "<&世界", Properties: model.TaskProperties{"pullRequests": json.RawMessage(`[ { "url": "<", "title": "q" } ]`)}, CreatedAt: now, UpdatedAt: now}
	value, err := RESTTask(task, true)
	if err != nil {
		t.Fatal(err)
	}
	got, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	want, err := json.Marshal(restWire(value))
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("REST production mismatch: got %s want %s err %v", got, want, err)
	}
	value.Properties["worker"] = json.RawMessage(`{`)
	if _, err = json.Marshal(value); err == nil {
		t.Fatal("invalid raw JSON hidden")
	}
	task.Properties["worker"] = json.RawMessage(strings.Repeat(" ", 1025))
	if _, err = EncodeREST(io.Discard, task, false, 1024); !errors.Is(err, ErrLegacyWorkerIndeterminate) {
		t.Fatalf("expected indeterminate, got %v", err)
	}
}
