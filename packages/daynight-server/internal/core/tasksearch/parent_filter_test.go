package tasksearch

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"testing"
)

func TestOrdinaryParentContextAndCursorBinding(t *testing.T) {
	f := testFixture()
	f.rows.Items[0].ParentType = model.TaskTypeTask
	f.onMatches = func(_ context.Context, _ string, q store.TaskSearchQuery) {
		if q.ParentTask == nil || *q.ParentTask != root {
			t.Fatalf("parent task filter: %+v", q)
		}
	}
	parent := root
	request := Request{Query: "cache", ParentTask: &parent, Limit: 1}
	page, err := Search(t.Context(), f, principal(), projectID, request)
	if err != nil {
		t.Fatal(err)
	}
	if page.Items[0].ParentType != model.TaskTypeTask || page.Items[0].Context == nil || page.Items[0].Context.TaskID != root {
		t.Fatalf("ordinary parent context: %+v", page)
	}
	request.Cursor = page.NextCursor
	request.ParentTask = nil
	if _, err = Search(t.Context(), f, principal(), projectID, request); err == nil {
		t.Fatal("search cursor accepted removed parent filter")
	}
	other := child
	request.ParentTask = &other
	if _, err = Search(t.Context(), f, principal(), projectID, request); err == nil {
		t.Fatal("search cursor accepted another parent")
	}
	request.Cursor = nil
	request.Parent = &parent
	if _, err = Search(t.Context(), f, principal(), projectID, request); err == nil {
		t.Fatal("both parent selectors accepted")
	}
}
