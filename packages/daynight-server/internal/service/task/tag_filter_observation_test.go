package task

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	projectcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

type filterObservationSnapshot struct {
	store.SnapshotScope
	tags store.TagReader
}

func (s filterObservationSnapshot) CredentialDAO() store.CredentialReader { return nil }
func (s filterObservationSnapshot) ProjectDAO() store.ProjectReader       { return nil }
func (s filterObservationSnapshot) TaskDAO() store.TaskReader             { return nil }
func (s filterObservationSnapshot) TagDAO() store.TagReader               { return s.tags }

type filterObservationCatalog struct {
	store.TagReader
	resolve func(context.Context, string, []string) ([]model.Tag, error)
}

func (c filterObservationCatalog) ResolveTags(ctx context.Context, p string, ids []string) ([]model.Tag, error) {
	return c.resolve(ctx, p, ids)
}

type filterObservationStore struct {
	run func(context.Context, func(store.SnapshotScope) error) error
}

func (s filterObservationStore) ReadSnapshot(ctx context.Context, run func(store.SnapshotScope) error) error {
	return s.run(ctx, run)
}

func TestObservedTagFiltersQualifyBeforeSelection(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	project, tagID := "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"
	for _, priority := range []bool{false, true} {
		for _, missing := range []bool{false, true} {
			ctx := t.Context()
			active, authorized, qualified, selected := false, false, false, false
			sentinel := errors.New("selected query failed")
			catalog := filterObservationCatalog{resolve: func(actual context.Context, p string, ids []string) ([]model.Tag, error) {
				if !active || !authorized || actual != ctx || p != project || len(ids) != 1 || ids[0] != tagID {
					t.Fatal("qualification outside authorized snapshot")
				}
				qualified = true
				if missing {
					return nil, nil
				}
				return []model.Tag{{ID: tagID, ProjectID: project}}, nil
			}}
			db := filterObservationStore{run: func(actual context.Context, run func(store.SnapshotScope) error) error {
				if actual != ctx {
					t.Fatal("context changed")
				}
				active = true
				defer func() { active = false }()
				return run(filterObservationSnapshot{tags: catalog})
			}}
			s := NewObservations(db, nil)
			s.operations.credential = func(context.Context, store.CredentialReader, model.Principal) error { return nil }
			s.operations.access = func(context.Context, projectcore.ProjectAccessReader, model.Principal, string) (model.ProjectAccess, error) {
				authorized = true
				return model.ProjectAccess{}, nil
			}
			assert := func() {
				if !active || !qualified || missing {
					t.Fatal("selection before tag qualification")
				}
				selected = true
			}
			s.operations.list = func(context.Context, taskcore.ReadDAO, string, taskcore.ListSelection) (store.TaskPage, *model.Fault, error) {
				assert()
				return store.TaskPage{}, nil, sentinel
			}
			s.operations.mcpList = func(context.Context, taskcore.MCPListReader, string, taskcore.MCPListSelection) (taskcore.MCPListPage, error) {
				assert()
				return taskcore.MCPListPage{}, sentinel
			}
			filter := store.TagFilter{TagIDs: []string{tagID}}
			var err error
			if priority {
				_, err = s.ObservedMCPList(ctx, principal, project, taskcore.MCPListRequest{TagFilter: filter, Limit: 1})
			} else {
				_, err = s.ObserveList(ctx, principal, project, TaskListRequest{TagFilter: filter, PageRequest: model.PageRequest{Limit: 1}})
			}
			if !qualified || selected == missing {
				t.Fatalf("observed qualifier priority=%v missing=%v selected=%v", priority, missing, selected)
			}
			if missing {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "invalid_tag_filter" {
					t.Fatal(err)
				}
			} else if !errors.Is(err, sentinel) {
				t.Fatal(err)
			}
		}
	}
}
