package assistanttask

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestRelatedAppendixPassesTheBoundedContextToStorage(t *testing.T) {
	inputs := []RelatedAppendixInput{
		{},
		{ProjectID: targetID, EventType: "report", ItemCategory: " build failure "},
		{ItemCategory: strings.Repeat("x", MaxAppendixCategoryBytes)},
	}
	for _, actor := range []Actor{userActor(), botActor()} {
		for _, input := range inputs {
			d := baseDAO(t, baseTask())
			rows := []model.AssistantTaskAppendix{{ID: entryID, TaskID: taskID, State: "edited"}}
			d.relatedAppendices = func(_ context.Context, q store.AssistantTaskRelatedQuery) ([]model.AssistantTaskAppendix, error) {
				want := store.AssistantTaskRelatedQuery{OwnerUserID: ownerID, TaskID: taskID, ProjectID: input.ProjectID, EventType: input.EventType, ItemCategory: input.ItemCategory, Limit: MaxRelatedAppendices}
				if q != want {
					t.Fatalf("related query %#v, want %#v", q, want)
				}
				return rows, nil
			}
			got, err := New().RelatedAppendix(context.Background(), d, actor, taskID, input)
			if err != nil || !reflect.DeepEqual(got.Items, rows) || !got.ObservedAt.Equal(epoch) {
				t.Fatalf("related result %#v %v", got, err)
			}
		}
	}
}

func TestRelatedAppendixReturnsAnEmptyArrayWithoutMatches(t *testing.T) {
	d := baseDAO(t, baseTask())
	d.relatedAppendices = func(context.Context, store.AssistantTaskRelatedQuery) ([]model.AssistantTaskAppendix, error) {
		return nil, nil
	}
	got, err := New().RelatedAppendix(context.Background(), d, botActor(), taskID, RelatedAppendixInput{EventType: "escalation"})
	if err != nil || got.Items == nil || len(got.Items) != 0 {
		t.Fatalf("empty related result %#v %v", got, err)
	}
}

func TestRelatedAppendixRefusesInvalidContextBeforeStorage(t *testing.T) {
	cases := map[string]RelatedAppendixInput{
		"noncanonical-project": {ProjectID: strings.ReplaceAll(targetID, "-", "")},
		"zero-project":         {ProjectID: "00000000-0000-0000-0000-000000000000"},
		"unknown-event":        {EventType: "retro"},
		"blank-category":       {ItemCategory: " "},
		"long-category":        {ItemCategory: strings.Repeat("x", MaxAppendixCategoryBytes+1)},
		"invalid-utf8":         {ItemCategory: "\xff"},
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			// The empty stub fails on any storage call, proving refusal precedes reads.
			_, err := New().RelatedAppendix(context.Background(), &daoStub{}, botActor(), taskID, input)
			requireCode(t, err, "invalid_input")
		})
	}
	_, err := New().RelatedAppendix(context.Background(), &daoStub{}, botActor(), "bad", RelatedAppendixInput{})
	requireCode(t, err, "invalid_input")
}

func TestRelatedAppendixStopsOnTaskAndStorageFailures(t *testing.T) {
	deleted := baseTask()
	deleted.State = "deleted"
	_, err := New().RelatedAppendix(context.Background(), baseDAO(t, deleted), botActor(), taskID, RelatedAppendixInput{})
	requireCode(t, err, "task_deleted")

	d := baseDAO(t, baseTask())
	d.relatedAppendices = func(context.Context, store.AssistantTaskRelatedQuery) ([]model.AssistantTaskAppendix, error) {
		return nil, sentinel
	}
	if _, err = New().RelatedAppendix(context.Background(), d, botActor(), taskID, RelatedAppendixInput{}); !errors.Is(err, sentinel) {
		t.Fatalf("want storage failure, got %v", err)
	}

	d = baseDAO(t, baseTask())
	d.relatedAppendices = func(context.Context, store.AssistantTaskRelatedQuery) ([]model.AssistantTaskAppendix, error) {
		return []model.AssistantTaskAppendix{}, nil
	}
	d.now = func(context.Context) (time.Time, error) { return time.Time{}, sentinel }
	if _, err = New().RelatedAppendix(context.Background(), d, botActor(), taskID, RelatedAppendixInput{}); !errors.Is(err, sentinel) {
		t.Fatalf("want clock failure, got %v", err)
	}
}
