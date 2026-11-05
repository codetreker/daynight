package worker

import (
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestWorkerCursorIsBoundToUserAndCreationPosition(t *testing.T) {
	user := "11111111-1111-4111-8111-111111111111"
	worker := "22222222-2222-4222-8222-222222222222"
	created := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	cursor, err := ListCursor(user, created, worker)
	if err != nil {
		t.Fatal(err)
	}
	page, err := ListPage(model.PageRequest{Limit: 10, Cursor: &cursor}, user)
	if err != nil || page.After == nil || page.After.ID != worker || !page.After.CreatedAt.Equal(created) {
		t.Fatalf("cursor round trip: %+v %v", page, err)
	}
	_, err = ListPage(model.PageRequest{Limit: 10, Cursor: &cursor}, "other")
	requireFault(t, err, "invalid_input")
	_, err = ListPage(model.PageRequest{Limit: 0}, user)
	requireFault(t, err, "invalid_input")
}
