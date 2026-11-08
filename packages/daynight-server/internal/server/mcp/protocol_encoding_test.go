package mcp

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

func TestTaskEnvelopeSharedEncodingMatchesOriginal(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	task := MapTaskFull(model.Task{ID: "id", Title: "<&世界", Description: "description", Properties: model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"<","title":"&"}]`)}, Version: 9223372036854775807, CreatedAt: now, UpdatedAt: now})
	want, err := json.Marshal(envelope{Data: task, Meta: &envelopeMeta{RequestID: "r<&", Outcome: "changed"}})
	if err != nil {
		t.Fatal(err)
	}
	var got bytes.Buffer
	n, err := taskprotocol.EncodeMCPProjection(&got, task, "r<&", "changed", int64(len(want)))
	if err != nil || n != int64(len(want)) || !bytes.Equal(got.Bytes(), want) {
		t.Fatalf("got %s want %s err=%v", got.Bytes(), want, err)
	}
	// The full list intentionally shadows description; sharing the encoder must
	// not promote a MarshalJSON method through this embedding.
	list, err := json.Marshal(taskListFull{TaskFull: task})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(list, []byte(`"description"`)) {
		t.Fatalf("list acquired description: %s", list)
	}
}
