package task

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

func TestTaskFactsOnlyActualChanges(t *testing.T) {
	now := time.Date(2026, 11, 6, 8, 0, 0, 123000, time.UTC)
	old := model.Task{ID: "33333333-3333-4333-8333-333333333333", ProjectID: "22222222-2222-4222-8222-222222222222", Status: model.TaskTodo, Version: 1, CreatedAt: now, UpdatedAt: now, Properties: model.TaskProperties{}}
	current := old
	current.Version = 2
	current.UpdatedAt = now.Add(time.Second)
	current.Status = model.TaskInProgress
	current.Properties = model.TaskProperties{"blocked": json.RawMessage(`true`)}
	facts, err := taskFacts(false, old, current)
	if err != nil || len(facts) != 2 || facts[0].Type != protocol.StatusChanged || facts[1].Type != protocol.Paused || facts[0].TaskVersion != 2 || !facts[0].OccurredAt.Equal(current.UpdatedAt) {
		t.Fatalf("combined: %#v %v", facts, err)
	}
	for _, f := range facts {
		if _, err = protocol.Render("a0be4d96-fb33-41ba-a7bd-7885c1e94247", f); err != nil {
			t.Fatal(err)
		}
	}
	created, err := taskFacts(true, model.Task{}, current)
	if err != nil || len(created) != 1 || created[0].Type != protocol.Created || !created[0].Paused || !created[0].OccurredAt.Equal(now) {
		t.Fatalf("created: %#v %v", created, err)
	}
	facts, err = taskFacts(false, current, current)
	if err != nil || len(facts) != 0 {
		t.Fatalf("unchanged: %#v %v", facts, err)
	}
	next := current
	next.Properties = model.TaskProperties{"blocked": json.RawMessage(`false`)}
	facts, err = taskFacts(false, current, next)
	if err != nil || len(facts) != 0 {
		t.Fatalf("unpaused: %#v %v", facts, err)
	}
	next.Properties = model.TaskProperties{"blocked": json.RawMessage(`"true"`)}
	if _, err = taskFacts(false, current, next); err == nil {
		t.Fatal("blocked JSON type error was hidden")
	}
}
