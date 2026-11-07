package task

import (
	"context"
	"encoding/json"
	"fmt"
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
	for i := 0; i < 10; i++ {
		reader.items = append(reader.items, model.Task{ID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i+10), ProjectID: project, Status: model.TaskTodo, CreatedAt: instant, UpdatedAt: instant, Description: strings.Repeat("<", 80000)})
	}
	selection, err := taskcore.SelectList(project, actor, taskcore.ListRequest{PageRequest: model.PageRequest{Limit: 10}})
	if err != nil {
		t.Fatal(err)
	}
	page, refusal, err := readBoundedTaskPage(context.Background(), reader, project, selection, true)
	if err != nil || refusal != nil || !page.HasMore || len(page.Items) == 0 || len(page.Items) >= len(reader.items) {
		t.Fatalf("page=%+v refusal=%v err=%v", page, refusal, err)
	}
	projected, err := taskcore.ProjectList(selection, page)
	if err != nil || projected.NextCursor == nil {
		t.Fatal(projected, err)
	}
	wire := struct {
		Items      []taskprotocol.REST `json:"items"`
		NextCursor *string             `json:"nextCursor"`
	}{NextCursor: projected.NextCursor}
	for _, item := range page.Items {
		v, e := taskprotocol.RESTTask(item, true)
		if e != nil {
			t.Fatal(e)
		}
		wire.Items = append(wire.Items, v)
	}
	encoded, err := json.Marshal(wire)
	if err != nil || len(encoded)+1 > taskcore.MaxPageResponseJSONBytes {
		t.Fatalf("wire length %d: %v", len(encoded)+1, err)
	}
	next, err := taskcore.SelectList(project, actor, taskcore.ListRequest{PageRequest: model.PageRequest{Limit: 10, Cursor: projected.NextCursor}})
	if err != nil {
		t.Fatal(err)
	}
	rest, refusal, err := readBoundedTaskPage(context.Background(), reader, project, next, true)
	if err != nil || refusal != nil || len(rest.Items) == 0 || rest.Items[0].ID != reader.items[len(page.Items)].ID {
		t.Fatalf("rest=%+v refusal=%v err=%v", rest, refusal, err)
	}
	if reader.calls > len(reader.items)+2 {
		t.Fatalf("too many candidates loaded: %d", reader.calls)
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
