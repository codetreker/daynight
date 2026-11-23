package task

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type tagFilterLookup struct {
	resolve func(context.Context, string, []string) ([]model.Tag, error)
}

func (r tagFilterLookup) ResolveTags(ctx context.Context, project string, ids []string) ([]model.Tag, error) {
	return r.resolve(ctx, project, ids)
}

func TestTagFilterNormalizationAndQualification(t *testing.T) {
	a, b := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	filter, err := NormalizeTagFilter(store.TagFilter{TagIDs: []string{b, strings.ToUpper(a), a}})
	if err != nil || filter.TagMatch != "all" || !reflect.DeepEqual(filter.TagIDs, []string{a, b}) {
		t.Fatalf("normalization: %#v %v", filter, err)
	}
	for _, invalid := range []store.TagFilter{{TagIDs: []string{"bad"}}, {TagMatch: "ALL"}, {TagIDs: []string{a}, Untagged: true}} {
		_, err := NormalizeTagFilter(invalid)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "invalid_tag_filter" {
			t.Fatalf("invalid filter: %#v %v", invalid, err)
		}
	}
	ctx := t.Context()
	for _, count := range []int{0, 1, 2} {
		err := RequireTagFilter(ctx, tagFilterLookup{resolve: func(actual context.Context, project string, ids []string) ([]model.Tag, error) {
			if actual != ctx || project != a || !reflect.DeepEqual(ids, filter.TagIDs) {
				t.Fatalf("lookup arguments: %s %#v", project, ids)
			}
			return make([]model.Tag, count), nil
		}}, a, filter)
		if (err == nil) != (count == 2) {
			t.Fatalf("resolved %d: %v", count, err)
		}
	}
	sentinel := errors.New("tag lookup failed")
	if err := RequireTagFilter(ctx, tagFilterLookup{resolve: func(context.Context, string, []string) ([]model.Tag, error) { return nil, sentinel }}, a, filter); !errors.Is(err, sentinel) {
		t.Fatal(err)
	}
	if err := RequireTagFilter(ctx, tagFilterLookup{}, a, store.TagFilter{}); err != nil {
		t.Fatal(err)
	}
}

func TestTagFilterCursorIdentityAndSelections(t *testing.T) {
	a, b := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	request := ListRequest{TagFilter: store.TagFilter{TagIDs: []string{b, a, a}}, PageRequest: model.PageRequest{Limit: 1}}
	first, err := SelectList(a, b, request)
	if err != nil {
		t.Fatal(err)
	}
	page, err := ProjectList(first, store.TaskPage{Items: []model.Task{{ID: a, CreatedAt: time.Now()}}, HasMore: true})
	if err != nil || page.NextCursor == nil {
		t.Fatalf("cursor: %#v %v", page, err)
	}
	request.Cursor = page.NextCursor
	request.TagFilter.TagIDs = []string{a, b}
	if _, err := SelectList(a, b, request); err != nil {
		t.Fatal(err)
	}
	for _, filter := range []store.TagFilter{{TagIDs: []string{a}}, {TagIDs: []string{a, b}, TagMatch: "any"}, {Untagged: true}} {
		request.TagFilter = filter
		if _, err := SelectList(a, b, request); err == nil {
			t.Fatalf("accepted changed cursor filter %#v", filter)
		}
	}
	ready, err := SelectMCPReady(MCPReadyRequest{Limit: 1, TagFilter: store.TagFilter{TagIDs: []string{b, a, a}, TagMatch: "any"}})
	if err != nil || !reflect.DeepEqual(ready.TagFilter, store.TagFilter{TagIDs: []string{a, b}, TagMatch: "any"}) {
		t.Fatalf("ready filter %#v %v", ready, err)
	}
	mcpRequest := MCPListRequest{Limit: 1, TagFilter: store.TagFilter{TagIDs: []string{b, a}}}
	mcp, err := SelectMCPList(a, b, mcpRequest)
	if err != nil {
		t.Fatal(err)
	}
	cursor, err := (MCPListPage{fence: store.TaskListFence{Count: "1", VersionSum: "1"}}).CursorAfter(mcp, model.Task{ID: a, ProjectID: a, CreatedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	mcpRequest.Cursor = &cursor
	mcpRequest.TagFilter.TagIDs = []string{a, b, a}
	if _, err := SelectMCPList(a, b, mcpRequest); err != nil {
		t.Fatal(err)
	}
	mcpRequest.TagFilter.TagMatch = "any"
	if _, err := SelectMCPList(a, b, mcpRequest); err == nil {
		t.Fatal("priority cursor accepted another tag match mode")
	}
	large := make([]string, 600)
	for i := range large {
		large[i] = fmt.Sprintf("00000000-0000-4000-8000-%012d", i)
	}
	largeSelection, err := SelectList(a, b, ListRequest{TagFilter: store.TagFilter{TagIDs: large}, PageRequest: model.PageRequest{Limit: 1}})
	if err != nil {
		t.Fatal(err)
	}
	largePage, err := ProjectList(largeSelection, store.TaskPage{Items: []model.Task{{ID: a, CreatedAt: time.Now()}}, HasMore: true})
	if err != nil || largePage.NextCursor == nil || len(*largePage.NextCursor) >= 16*1024 {
		t.Fatalf("large filter cursor: %#v %v", largePage, err)
	}
}
