package task

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"
)

type budgetReader struct {
	items []model.Task
	calls int
}

func (r *budgetReader) Task(context.Context, string, string) (model.Task, error) {
	panic("unexpected task read")
}
func (r *budgetReader) Tasks(_ context.Context, _ string, q store.TaskQuery) (store.TaskPage, error) {
	r.calls++
	if q.Page.Limit != 1 {
		return store.TaskPage{}, fmt.Errorf("candidate limit = %d", q.Page.Limit)
	}
	start := 0
	if q.Page.After != nil {
		for start < len(r.items) && r.items[start].ID != q.Page.After.ID {
			start++
		}
		if start == len(r.items) || !q.Page.After.CreatedAt.Equal(r.items[start].CreatedAt) {
			return store.TaskPage{}, fmt.Errorf("candidate cursor does not identify a supplied task: %+v", q.Page.After)
		}
		start++
	}
	if start >= len(r.items) {
		return store.TaskPage{Items: []model.Task{}}, nil
	}
	return store.TaskPage{Items: []model.Task{r.items[start]}, HasMore: start+1 < len(r.items)}, nil
}

func TestTaskPageBudgetContinuesAfterLastReturnedCandidate(t *testing.T) {
	project := "00000000-0000-4000-8000-000000000001"
	actor := "00000000-0000-4000-8000-000000000002"
	instant := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	reader := &budgetReader{}
	expected := make(map[string]taskprotocol.REST)
	for i := 0; i < 10; i++ {
		task := model.Task{ID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i+10), ProjectID: project, Title: fmt.Sprintf("Candidate %d", i), Status: model.TaskTodo, Version: 1, CreatedAt: instant, UpdatedAt: instant, Description: strings.Repeat("<", 80000), Properties: model.TaskProperties{}, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true}
		reader.items = append(reader.items, task)
		wire, err := taskprotocol.RESTTask(task, true)
		if err != nil {
			t.Fatal(err)
		}
		expected[task.ID] = wire
	}
	var cursor *string
	pages := 0
	for {
		selection, err := taskcore.SelectList(project, actor, taskcore.ListRequest{PageRequest: model.PageRequest{Limit: 100, Cursor: cursor}})
		if err != nil {
			t.Fatal(err)
		}
		page, refusal, err := readBoundedTaskPage(t.Context(), reader, project, selection, true)
		if err != nil || refusal != nil || len(page.Items) == 0 {
			t.Fatalf("page=%+v refusal=%v err=%v", page, refusal, err)
		}
		projected, err := taskcore.ProjectList(selection, page)
		if err != nil {
			t.Fatal(err)
		}
		wire := struct {
			Items      []taskprotocol.REST `json:"items"`
			NextCursor *string             `json:"nextCursor"`
		}{Items: make([]taskprotocol.REST, 0, len(page.Items)), NextCursor: projected.NextCursor}
		for _, item := range page.Items {
			result, err := taskprotocol.RESTTask(item, true)
			if err != nil {
				t.Fatal(err)
			}
			wire.Items = append(wire.Items, result)
		}
		var encoded bytes.Buffer
		if err := json.NewEncoder(&encoded).Encode(wire); err != nil || encoded.Len() > taskcore.MaxPageResponseJSONBytes || !strings.HasSuffix(encoded.String(), "\n") {
			t.Fatalf("wire length %d: %v", encoded.Len(), err)
		}
		var decoded struct {
			Items      []taskprotocol.REST `json:"items"`
			NextCursor *string             `json:"nextCursor"`
		}
		if err := json.Unmarshal(encoded.Bytes(), &decoded); err != nil || !reflect.DeepEqual(decoded, wire) {
			t.Fatalf("page wire changed complete resources or cursor: %v", err)
		}
		for _, item := range decoded.Items {
			want, present := expected[item.ID]
			if !present || !reflect.DeepEqual(item, want) {
				t.Fatalf("duplicate, foreign or incomplete task: %s", item.ID)
			}
			delete(expected, item.ID)
		}
		pages++
		cursor = decoded.NextCursor
		if cursor == nil {
			break
		}
		if pages >= len(reader.items) {
			t.Fatal("budget pagination did not terminate")
		}
	}
	if len(expected) != 0 || pages < 2 || cursor != nil {
		t.Fatalf("missing %d tasks after %d pages; cursor=%v", len(expected), pages, cursor)
	}
	if reader.calls > len(reader.items)+pages {
		t.Fatalf("too many candidates loaded: %d for %d pages", reader.calls, pages)
	}
}

func TestTaskPageBudgetRejectsOversizedFirstItem(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	selection, err := taskcore.SelectList(id, id, taskcore.ListRequest{PageRequest: model.PageRequest{Limit: 2}})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	r := &budgetReader{items: []model.Task{{ID: id, ProjectID: id, Status: model.TaskTodo, CreatedAt: now, UpdatedAt: now, Description: strings.Repeat("x", taskcore.MaxPageResponseJSONBytes)}}}
	_, fault, err := readBoundedTaskPage(context.Background(), r, id, selection, true)
	if err != nil || fault == nil || fault.Code != "resource_limit_exceeded" {
		t.Fatalf("unexpected fault: %v, error: %v", fault, err)
	}
}

func TestTaskPageCursorEncodingErrorRetainsCause(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	selection, err := taskcore.SelectList(id, id, taskcore.ListRequest{PageRequest: model.PageRequest{Limit: 2}})
	if err != nil {
		t.Fatal(err)
	}
	invalid := time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)
	r := &budgetReader{items: []model.Task{{ID: id, CreatedAt: invalid}, {ID: "00000000-0000-4000-8000-000000000002"}}}
	_, _, err = readBoundedTaskPage(context.Background(), r, id, selection, true)
	var local *taskPageEncodingError
	var marshal *json.MarshalerError
	if !errors.As(err, &local) || !errors.As(err, &marshal) || errors.Unwrap(local) == nil || !strings.Contains(err.Error(), "encode task cursor") {
		t.Fatalf("cursor encoding cause lost: %v", err)
	}
}
