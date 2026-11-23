package project

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type settingsWriteStore struct {
	projectValidationStore
	write func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error)
}

func (s settingsWriteStore) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	return s.write(ctx, id, work)
}

type settingsWriteScope struct {
	store.ProjectWriteScope
	project func() store.ProjectWriteDAO
}

func (s settingsWriteScope) ProjectDAO() store.ProjectWriteDAO {
	return s.project()
}

type settingsWriteDAO struct {
	store.ProjectWriteDAO
	access func(context.Context, model.Principal) (model.ProjectAccess, error)
	read   func(context.Context) (model.Project, error)
	update func(context.Context, int32) (model.Project, error)
}

func (d settingsWriteDAO) ProjectAccess(ctx context.Context, principal model.Principal) (model.ProjectAccess, error) {
	return d.access(ctx, principal)
}

func (d settingsWriteDAO) Project(ctx context.Context) (model.Project, error) {
	return d.read(ctx)
}

func (d settingsWriteDAO) UpdateProjectSettings(ctx context.Context, minutes int32) (model.Project, error) {
	return d.update(ctx, minutes)
}

func TestProjectSettingsCanceledWriteSuppressesResult(t *testing.T) {
	const projectID = "f47ac10b-58cc-41cf-a447-001122334455"
	principal := model.Principal{
		Kind:         model.SessionCredential,
		UserID:       "00000000-0000-4000-8000-000000000001",
		CredentialID: "00000000-0000-4000-8000-000000000002",
	}
	saved := model.Project{
		ID:       projectID,
		Name:     "Saved project",
		Settings: model.ProjectSettings{Version: 1, ExecutionWarningMinutes: 60},
	}
	for _, test := range []struct {
		name     string
		role     model.ProjectRole
		minutes  int32
		cancelAt string
		daoCalls []string
	}{
		{"member refusal completion", model.ProjectMemberRole, 90, "completion", []string{"access"}},
		{"project query", model.ProjectAdmin, 90, "read", []string{"access", "read"}},
		{"noop completion", model.ProjectAdmin, 60, "completion", []string{"access", "read"}},
		{"update query", model.ProjectAdmin, 90, "update", []string{"access", "read", "update"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			want := append([]string{"write transaction", "scoped Project DAO"}, test.daoCalls...)
			expect := func(actual context.Context, call string) {
				t.Helper()
				if actual != ctx || len(want) == 0 || want[0] != call {
					t.Fatalf("unexpected %q call (same context: %t), remaining calls: %v", call, actual == ctx, want)
				}
				want = want[1:]
			}
			dao := settingsWriteDAO{
				access: func(actual context.Context, p model.Principal) (model.ProjectAccess, error) {
					expect(actual, "access")
					if p != principal {
						t.Fatalf("access principal = %#v, want %#v", p, principal)
					}
					return model.ProjectAccess{Role: test.role}, nil
				},
				read: func(actual context.Context) (model.Project, error) {
					expect(actual, "read")
					if test.cancelAt == "read" {
						cancel()
						return model.Project{}, actual.Err()
					}
					return saved, nil
				},
				update: func(actual context.Context, minutes int32) (model.Project, error) {
					expect(actual, "update")
					if minutes != test.minutes {
						t.Fatalf("update minutes = %d, want %d", minutes, test.minutes)
					}
					cancel()
					return model.Project{}, actual.Err()
				},
			}
			outcome := store.Completion{Outcome: store.TransactionNotCommitted}
			failure := &store.TransactionError{Phase: "operation", Cause: context.Canceled, Outcome: outcome.Outcome}
			db := settingsWriteStore{write: func(actual context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
				expect(actual, "write transaction")
				if id != projectID {
					t.Fatalf("transaction project ID = %q, want %q", id, projectID)
				}
				callbackErr := work(settingsWriteScope{project: func() store.ProjectWriteDAO {
					expect(actual, "scoped Project DAO")
					return dao
				}})
				if test.cancelAt == "completion" {
					if callbackErr != nil {
						t.Fatalf("callback rejected completion: %v", callbackErr)
					}
					cancel()
				} else if !errors.Is(callbackErr, context.Canceled) {
					t.Fatalf("callback did not propagate cancellation: %v", callbackErr)
				}
				if !errors.Is(actual.Err(), context.Canceled) {
					t.Fatalf("transaction context did not observe cancellation: %v", actual.Err())
				}
				return outcome, failure
			}}
			got, err := NewProjects(db).UpdateSettings(ctx, principal, strings.ToUpper(projectID), coreproject.UpdateProjectSettings{Version: saved.Settings.Version, ExecutionWarningMinutes: test.minutes})
			assertOperational(t, err)
			if !errors.Is(err, failure) || !errors.Is(err, context.Canceled) || !reflect.DeepEqual(got, model.Project{}) {
				t.Fatalf("canceled settings update returned a project or lost its failure: %#v, %v", got, err)
			}
			if len(want) != 0 {
				t.Fatalf("missing calls: %v", want)
			}
		})
	}
}
