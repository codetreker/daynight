package task_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type tagFilterSnapshot struct {
	store.SnapshotScope
	catalog store.TagReader
}

func (s tagFilterSnapshot) TagDAO() store.TagReader { return s.catalog }

type filterCatalog struct {
	store.TagReader
	resolve func(context.Context, string, []string) ([]model.Tag, error)
}

func (c filterCatalog) ResolveTags(ctx context.Context, project string, ids []string) ([]model.Tag, error) {
	return c.resolve(ctx, project, ids)
}

func TestTaskTagFilterQualificationUsesSelectionSnapshot(t *testing.T) {
	for _, kind := range []string{"list", "priority", "ready"} {
		for _, missing := range []bool{false, true} {
			t.Run(kind+map[bool]string{false: " valid", true: " missing"}[missing], func(t *testing.T) {
				f := newTaskRuleFixture(t)
				ctx := t.Context()
				tagID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
				filter := store.TagFilter{TagIDs: []string{tagID}, TagMatch: "all"}
				active, qualified, selected := false, false, false
				catalog := filterCatalog{resolve: func(actual context.Context, project string, ids []string) ([]model.Tag, error) {
					if !active || actual != ctx || project != f.project.ID || !reflect.DeepEqual(ids, filter.TagIDs) {
						t.Fatal("qualification escaped selection snapshot")
					}
					qualified = true
					if missing {
						return []model.Tag{}, nil
					}
					return []model.Tag{{ID: tagID, ProjectID: project}}, nil
				}}
				f.database.ReadSnapshotFn = func(actual context.Context, run func(store.SnapshotScope) error) error {
					if actual != ctx {
						t.Fatal("context changed")
					}
					active = true
					defer func() { active = false }()
					return run(tagFilterSnapshot{SnapshotScope: f.snapshot, catalog: catalog})
				}
				assert := func(actual context.Context, project string, got store.TagFilter) {
					if !active || !qualified || missing || actual != ctx || project != f.project.ID || !reflect.DeepEqual(got, filter) {
						t.Fatal("selection occurred before successful qualification")
					}
					selected = true
				}
				f.reader.TasksFn = func(actual context.Context, project string, q store.TaskQuery) (store.TaskPage, error) {
					assert(actual, project, q.TagFilter)
					return store.TaskPage{Items: []model.Task{}}, nil
				}
				f.reader.TaskPriorityListFn = func(actual context.Context, project string, q store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
					assert(actual, project, q.TagFilter)
					return store.TaskPriorityPage{Items: []store.TaskPriorityItem{}}, nil
				}
				f.reader.TaskListFenceFn = func(context.Context, string) (store.TaskListFence, error) {
					return store.TaskListFence{Count: "0", VersionSum: "0"}, nil
				}
				var err error
				switch kind {
				case "list":
					_, err = f.tasks.List(ctx, f.principal, f.project.ID, taskservice.TaskListRequest{TagFilter: filter, PageRequest: model.PageRequest{Limit: 1}})
				case "priority":
					err = f.tasks.MCPList(ctx, f.principal, f.project.ID, taskcore.MCPListRequest{TagFilter: filter, Limit: 1}, func(store.TaskPriorityItem, string, bool) bool { return true })
				case "ready":
					_, err = f.tasks.MCPReady(ctx, f.principal, f.project.ID, taskcore.MCPReadyRequest{TagFilter: filter, Limit: 1})
				}
				if !qualified || selected == missing {
					t.Fatalf("qualified=%v selected=%v missing=%v", qualified, selected, missing)
				}
				if missing {
					var fault *model.Fault
					if !errors.As(err, &fault) || fault.Code != "invalid_tag_filter" {
						t.Fatal(err)
					}
				} else if err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}
