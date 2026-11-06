package task

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type graphProjectReader struct {
	store.ProjectReader
	accessErr  error
	projectErr error
}

func (r graphProjectReader) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	return model.ProjectAccess{}, r.accessErr
}
func (r graphProjectReader) Project(context.Context, string) (model.Project, error) {
	return model.Project{}, r.projectErr
}

type graphSnapshot struct {
	store.SnapshotScope
	project graphProjectReader
}

func (s graphSnapshot) ProjectDAO() store.ProjectReader { return s.project }

type graphStore struct {
	store.ProjectWriter
	snapshot      graphSnapshot
	completionErr error
}

func (s graphStore) ReadSnapshot(_ context.Context, callback func(store.SnapshotScope) error) error {
	err := callback(s.snapshot)
	if s.completionErr != nil {
		return s.completionErr
	}
	return err
}

func TestGraphReadFailureAndCompletionPrecedence(t *testing.T) {
	principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	projectID, taskID := "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"
	storage := errors.New("database failure")
	cleanup := errors.New("snapshot cleanup failed")
	for _, test := range []struct {
		name       string
		project    graphProjectReader
		completion error
		want       error
		code       string
	}{
		{name: "access operation", project: graphProjectReader{accessErr: storage}, want: storage},
		{name: "missing project", project: graphProjectReader{projectErr: model.ErrNotFound}, code: "not_found"},
		{name: "project operation", project: graphProjectReader{projectErr: storage}, want: storage},
		{name: "completion overrides refusal", project: graphProjectReader{accessErr: model.ErrNotFound}, completion: cleanup, want: cleanup},
	} {
		t.Run(test.name, func(t *testing.T) {
			tasks := NewTasks(graphStore{snapshot: graphSnapshot{project: test.project}, completionErr: test.completion})
			_, err := tasks.Graph(context.Background(), principal, projectID, taskID)
			if test.want != nil && !errors.Is(err, test.want) {
				t.Fatalf("cause lost: %v", err)
			}
			if test.code != "" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != test.code {
					t.Fatalf("fault: %v", err)
				}
			}
			if test.completion != nil {
				var fault *model.Fault
				if errors.As(err, &fault) {
					t.Fatalf("refusal hid completion failure: %v", err)
				}
			}
		})
	}
}
