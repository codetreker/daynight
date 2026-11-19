package assistanttask

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestEventTypeFilterSelectsTypeAndPausedExclusion(t *testing.T) {
	for _, tc := range []struct {
		name               string
		input              PageInput
		include, exclude   string
		excludePausedTasks bool
	}{
		{"none", PageInput{}, "", "", false},
		{"inbound", PageInput{Type: InboundEventType}, InboundEventType, "", true},
		{"other type", PageInput{Type: "report"}, "report", "", false},
		{"exclude inbound", PageInput{ExcludeType: InboundEventType}, "", InboundEventType, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q, _, err := pageQuery(userActor(), taskID, "events", tc.input)
			if err != nil {
				t.Fatal(err)
			}
			if q.EventType != tc.include || q.ExcludeEventType != tc.exclude || q.ExcludePausedTasks != tc.excludePausedTasks {
				t.Fatalf("wrong event type query: %#v", q)
			}
		})
	}
}

func TestEventTypeFilterRejectsInvalidSelections(t *testing.T) {
	for _, tc := range []struct {
		name, resource string
		input          PageInput
	}{
		{"combined", "events", PageInput{Type: InboundEventType, ExcludeType: "report"}},
		{"unknown type", "events", PageInput{Type: "unknown"}},
		{"unknown exclusion", "events", PageInput{ExcludeType: "unknown"}},
		{"other resource type", "records", PageInput{Type: InboundEventType}},
		{"other resource exclusion", "tasks", PageInput{ExcludeType: InboundEventType}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := pageQuery(userActor(), taskID, tc.resource, tc.input)
			requireCode(t, err, "invalid_input")
		})
	}
}

func TestEventCursorBindsTypeFilter(t *testing.T) {
	position := func(v model.AssistantTaskEvent) store.AssistantTaskPosition {
		return store.AssistantTaskPosition{CreatedAt: v.CreatedAt, ID: v.ID}
	}
	events := []model.AssistantTaskEvent{{ID: entryID, CreatedAt: epoch}, {ID: operationID, CreatedAt: epoch}}
	nextCursor := func(input PageInput) string {
		t.Helper()
		q, c, err := pageQuery(userActor(), taskID, "events", input)
		if err != nil {
			t.Fatal(err)
		}
		page, err := makePage(events, q.Limit, c, epoch, position)
		if err != nil || page.NextCursor == nil {
			t.Fatal(page, err)
		}
		return *page.NextCursor
	}
	unfiltered, err := base64.RawURLEncoding.DecodeString(nextCursor(PageInput{Limit: 1}))
	if err != nil || strings.Contains(string(unfiltered), "EventType") || strings.Contains(string(unfiltered), "ExcludeType") {
		t.Fatalf("unfiltered cursor encodes type filters: %s %v", unfiltered, err)
	}
	for _, filter := range []PageInput{{Type: InboundEventType}, {ExcludeType: InboundEventType}} {
		filter.Limit = 1
		filter.Cursor = nextCursor(filter)
		q, _, err := pageQuery(userActor(), taskID, "events", filter)
		if err != nil || q.After == nil || q.After.ID != entryID {
			t.Fatal(q, err)
		}
		for _, changed := range []PageInput{{}, {Type: InboundEventType}, {ExcludeType: InboundEventType}, {Type: "report"}} {
			if changed.Type == filter.Type && changed.ExcludeType == filter.ExcludeType {
				continue
			}
			changed.Limit, changed.Cursor = 1, filter.Cursor
			_, _, err := pageQuery(userActor(), taskID, "events", changed)
			requireCode(t, err, "invalid_input")
		}
	}
}

func TestEventListsPassTypeFilterToStore(t *testing.T) {
	for _, id := range []string{taskID, ""} {
		d := baseDAO(t, baseTask())
		d.inquiries = func(context.Context, store.AssistantTaskQuery) ([]model.AssistantTaskInquiry, error) { return nil, nil }
		reads := 0
		d.events = func(_ context.Context, q store.AssistantTaskQuery) ([]model.AssistantTaskEvent, error) {
			reads++
			if q.TaskID != id || q.EventType != InboundEventType || !q.ExcludePausedTasks {
				t.Fatalf("lost event type filter: %#v", q)
			}
			return nil, nil
		}
		if _, err := New().ListEvents(context.Background(), d, userActor(), id, PageInput{Type: InboundEventType, TargetBotID: botID}); err != nil || reads != 1 {
			t.Fatal(reads, err)
		}
	}
}
