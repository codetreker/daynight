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
	parent := "d41a4e82-6bf0-4c7f-b519-47076dafc425"
	task := model.Task{ID: "id", ProjectID: "project", Type: model.TaskTypeTask, ParentID: &parent, Title: "<&世界", Description: "line\nquote\"", Properties: model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"<","title":"&"}]`), "paused": json.RawMessage(`false`)}, Tags: []model.TagReference{{ID: "tag-id", Name: "<&世界"}}, Version: 9223372036854775807, CreatedAt: now, UpdatedAt: now, DependsOn: []string{"d"}}
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
		if !bytes.Contains(got.Bytes(), []byte(`"tags":[{"id":"tag-id","name":"\u003c\u0026世界"}]`)) {
			t.Fatalf("actual tag reference missing or incorrectly encoded: %s", got.Bytes())
		}
		value.Tags[0].Name = "changed"
		if task.Tags[0].Name != "<&世界" {
			t.Fatal("REST projection aliases task tags")
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
	if !strings.Contains(string(want), `"type":"task","parentId":"`+parent+`"`) {
		t.Fatalf("MCP type and parent missing: %s", want)
	}
}

func TestRESTEmptyTagsAreAnArray(t *testing.T) {
	for _, tags := range [][]model.TagReference{nil, {}} {
		value, err := RESTTask(model.Task{Tags: tags}, true)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(value)
		if err != nil || !bytes.Contains(raw, []byte(`"tags":[]`)) {
			t.Fatalf("empty tags: %s, %v", raw, err)
		}
	}
}

func TestMCPTagProjections(t *testing.T) {
	for _, tags := range [][]model.TagReference{nil, {}, {{ID: "id", Name: "<&标签"}}} {
		task := model.Task{Tags: tags}
		for name, value := range map[string]any{"full": MCPTask(task), "summary": MCPTaskSummary(task)} {
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			want := `"tags":[]`
			if len(tags) > 0 {
				want = `"tags":[{"id":"id","name":"\u003c\u0026标签"}]`
			}
			if !bytes.Contains(raw, []byte(want)) {
				t.Fatalf("%s tags: %s", name, raw)
			}
		}
		if len(tags) > 0 {
			full, summary := MCPTask(task), MCPTaskSummary(task)
			full.Tags[0].Name = "full changed"
			summary.Tags[0].Name = "summary changed"
			if task.Tags[0].Name != "<&标签" {
				t.Fatal("MCP projection aliases task tags")
			}
		}
	}
}

func TestRESTSyncTags(t *testing.T) {
	for _, tags := range [][]model.TagReference{nil, {}, {{ID: "id", Name: "<&标签"}}} {
		value := RESTSyncRecord(model.TaskViewRecord{Tags: tags})
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		want := `"tags":[]`
		if len(tags) > 0 {
			want = `"tags":[{"id":"id","name":"\u003c\u0026标签"}]`
			value.Tags[0].Name = "changed"
			if tags[0].Name != "<&标签" {
				t.Fatal("sync projection aliases task tags")
			}
		}
		if !bytes.Contains(raw, []byte(want)) {
			t.Fatalf("sync tags: %s", raw)
		}
	}
}

func TestTypedTaskProjectionsAndByteCost(t *testing.T) {
	parent := "d41a4e82-6bf0-4c7f-b519-47076dafc425"
	for _, parentID := range []*string{nil, &parent} {
		task := model.Task{Type: model.TaskTypeTask, ParentID: parentID}
		rest, err := RESTTask(task, true)
		if err != nil {
			t.Fatal(err)
		}
		for name, value := range map[string]any{"rest": rest, "mcp-full": MCPTask(task), "mcp-summary": MCPTaskSummary(task), "sync": RESTSyncRecord(model.TaskViewRecord{Type: task.Type, ParentID: parentID})} {
			raw, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			var obj map[string]any
			if err := json.Unmarshal(raw, &obj); err != nil {
				t.Fatal(err)
			}
			if obj["type"] != "task" || (parentID == nil && obj["parentId"] != nil) || (parentID != nil && obj["parentId"] != parent) {
				t.Fatalf("%s: %s", name, raw)
			}
			delete(obj, "type")
			delete(obj, "parentId")
			without, err := json.Marshal(obj)
			if err != nil {
				t.Fatal(err)
			}
			want := 30
			if parentID != nil {
				want = 64
			}
			if len(raw)-len(without) != want {
				t.Fatalf("%s added %d bytes, want %d", name, len(raw)-len(without), want)
			}
		}
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
