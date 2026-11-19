package assistanttask

import (
	"cmp"
	"context"
	"errors"
	"reflect"
	"slices"
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

func TestRelatedAppendixMatchScoresDeclaredMatchesAndExcludesMismatches(t *testing.T) {
	full := RelatedAppendixInput{ProjectID: targetID, EventType: "report", ItemCategory: "build failure"}
	cases := []struct {
		name  string
		scope model.AssistantTaskAppendixScope
		input RelatedAppendixInput
		score int
		ok    bool
	}{
		{"all-declared-match", *fullScope(), full, 3, true},
		{"undeclared-is-neutral", model.AssistantTaskAppendixScope{}, full, 0, true},
		{"empty-sets-are-neutral", model.AssistantTaskAppendixScope{ProjectIDs: []string{}, EventTypes: []string{}, ItemCategories: []string{}}, full, 0, true},
		{"one-declared-match", model.AssistantTaskAppendixScope{EventTypes: []string{"escalation", "report"}}, full, 1, true},
		{"omitted-values-are-neutral", *fullScope(), RelatedAppendixInput{}, 0, true},
		{"omitted-value-skips-declared-set", *fullScope(), RelatedAppendixInput{EventType: "escalation"}, 1, true},
		{"project-mismatch", model.AssistantTaskAppendixScope{ProjectIDs: []string{entryID}}, full, 0, false},
		{"event-mismatch", model.AssistantTaskAppendixScope{EventTypes: []string{"escalation"}, ItemCategories: []string{"build failure"}}, full, 0, false},
		{"category-mismatch", model.AssistantTaskAppendixScope{ProjectIDs: []string{targetID}, ItemCategories: []string{"deploy"}}, full, 0, false},
		{"category-whitespace-is-verbatim", model.AssistantTaskAppendixScope{ItemCategories: []string{" build failure "}}, full, 0, false},
		{"category-case-is-verbatim", model.AssistantTaskAppendixScope{ItemCategories: []string{"Build Failure"}}, full, 0, false},
		{"category-padded-query-matches-padded-scope", model.AssistantTaskAppendixScope{ItemCategories: []string{" build "}}, RelatedAppendixInput{ItemCategory: " build "}, 1, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if score, ok := RelatedAppendixMatch(c.scope, c.input); score != c.score || ok != c.ok {
				t.Fatalf("match = %d %v, want %d %v", score, ok, c.score, c.ok)
			}
		})
	}
}

func TestCompareRelatedAppendicesOrdersByScoreValidationAndID(t *testing.T) {
	input := RelatedAppendixInput{ProjectID: targetID, EventType: "report"}
	early, late := epoch, epoch.Add(time.Minute)
	appendix := func(id string, scope model.AssistantTaskAppendixScope, validated *time.Time) model.AssistantTaskAppendix {
		return model.AssistantTaskAppendix{ID: id, Scope: scope, LastValidatedAt: validated}
	}
	both := model.AssistantTaskAppendixScope{ProjectIDs: []string{targetID}, EventTypes: []string{"report"}}
	one := model.AssistantTaskAppendixScope{EventTypes: []string{"report"}}
	want := []model.AssistantTaskAppendix{
		appendix("00000000-0000-4000-8000-000000000001", both, nil),
		appendix("00000000-0000-4000-8000-000000000002", one, &late),
		appendix("00000000-0000-4000-8000-000000000004", one, &early),
		appendix("00000000-0000-4000-8000-000000000003", one, &early),
		appendix("00000000-0000-4000-8000-000000000006", model.AssistantTaskAppendixScope{}, &early),
		appendix("00000000-0000-4000-8000-000000000009", model.AssistantTaskAppendixScope{}, nil),
		appendix("00000000-0000-4000-8000-000000000005", model.AssistantTaskAppendixScope{}, nil),
	}
	got := slices.Clone(want)
	slices.Reverse(got)
	slices.SortFunc(got, func(a, b model.AssistantTaskAppendix) int { return CompareRelatedAppendices(a, b, input) })
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("related order %v, want %v", got, want)
	}
	for i := range want {
		for j := range want {
			if got := CompareRelatedAppendices(want[i], want[j], input); got != cmp.Compare(i, j) {
				t.Fatalf("compare %d with %d = %d", i, j, got)
			}
		}
	}
}
