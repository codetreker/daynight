package project

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgconn"
)

const projectReadErrorID = "cd000000-0000-4000-8000-000000000001"

func projectReadErrorPrincipal() model.Principal {
	return model.Principal{
		Kind:         model.SessionCredential,
		UserID:       "ab000000-0000-4000-8000-000000000001",
		CredentialID: "ab000000-0000-4000-8000-000000000002",
	}
}

type projectCreationBeginFailure struct {
	projectValidationStore
	begin func(context.Context, string) (store.Completion, error)
}

func (s projectCreationBeginFailure) WriteProjectCreation(ctx context.Context, ownerID string, _ func(store.ProjectCreationDAO) error) (store.Completion, error) {
	return s.begin(ctx, ownerID)
}

func TestProjectStoreFailuresRemainOperational(t *testing.T) {
	principal := projectReadErrorPrincipal()
	closed := errors.New("closed pool")
	t.Run("create", func(t *testing.T) {
		ctx := t.Context()
		begin := &store.Error{Phase: "begin project creation", Cause: closed, DatabaseFailure: true}
		calls := 0
		db := projectCreationBeginFailure{begin: func(actual context.Context, ownerID string) (store.Completion, error) {
			calls++
			if calls != 1 || actual != ctx || ownerID != principal.UserID {
				t.Fatalf("project creation begin: calls=%d same context=%t owner=%q, want %q", calls, actual == ctx, ownerID, principal.UserID)
			}
			return store.Completion{Outcome: store.TransactionNotCommitted}, begin
		}}
		result, err := NewProjects(db).Create(ctx, principal, coreproject.CreateProject{
			ExpectedUserID: principal.UserID,
			Name:           "Project",
			RepoURL:        "https://example.com/repo",
		})
		assertProjectStoreFailure(t, result, err, begin)
		if calls != 1 {
			t.Fatalf("project creation begin calls=%d, want 1", calls)
		}
	})
	t.Run("get", func(t *testing.T) {
		begin := &store.Error{Phase: "begin snapshot", Cause: closed, DatabaseFailure: true}
		db := newCompletionProjectReadPlan(t, t.Context(), nil)
		db.begin = begin
		result, err := NewProjects(db).Get(t.Context(), principal, projectReadErrorID)
		assertProjectStoreFailure(t, result, err, begin)
	})
	t.Run("list", func(t *testing.T) {
		begin := &store.Error{Phase: "begin snapshot", Cause: closed, DatabaseFailure: true}
		db := newCompletionProjectReadPlan(t, t.Context(), nil)
		db.begin = begin
		result, err := NewProjects(db).List(t.Context(), principal, model.PageRequest{Limit: 50})
		assertProjectStoreFailure(t, result, err, begin)
	})
}

func assertProjectStoreFailure[T any](t *testing.T, got T, err error, failure *store.Error) {
	t.Helper()
	assertOperational(t, err)
	var zero T
	isDatabase, state := store.DatabaseErrorFacts(err)
	if !errors.Is(err, failure) || !errors.Is(err, failure.Cause) ||
		!isDatabase || state != failure.SQLState || !reflect.DeepEqual(got, zero) {
		t.Fatalf("project store failure: result=%#v error=%#v, want zero result and chain to %#v", got, err, failure)
	}
}

func TestProjectSnapshotQueryFailuresRemainOperational(t *testing.T) {
	principal := projectReadErrorPrincipal()
	missingRelation := &pgconn.PgError{Code: "42P01", Message: "project relation missing"}
	t.Run("get", func(t *testing.T) {
		failure := &store.Error{Phase: "read project access", Cause: missingRelation, SQLState: missingRelation.Code, DatabaseFailure: true}
		db := newCompletionProjectReadPlan(t, t.Context(), []completionProjectReadCall{
			{name: "access", args: []any{principal, projectReadErrorID}, err: failure},
		})
		db.callbackErr = failure
		result, err := NewProjects(db).Get(t.Context(), principal, strings.ToUpper(projectReadErrorID))
		assertProjectStoreFailure(t, result, err, failure)
	})
	t.Run("list", func(t *testing.T) {
		failure := &store.Error{Phase: "list accessible projects", Cause: missingRelation, SQLState: missingRelation.Code, DatabaseFailure: true}
		db := newCompletionProjectReadPlan(t, t.Context(), []completionProjectReadCall{
			{name: "scoped", args: []any{principal, store.ProjectScope{Kind: store.ProjectScopeAll}, store.Page{Limit: 50}}, err: failure},
		})
		db.callbackErr = failure
		result, err := NewProjects(db).List(t.Context(), principal, model.PageRequest{Limit: 50})
		assertProjectStoreFailure(t, result, err, failure)
	})
}

func TestProjectCursorEncodingFailureIsOperational(t *testing.T) {
	principal := projectReadErrorPrincipal()
	db := newCompletionProjectReadPlan(t, t.Context(), []completionProjectReadCall{
		{
			name: "scoped",
			args: []any{principal, store.ProjectScope{Kind: store.ProjectScopeAll}, store.Page{Limit: 1}},
			result: store.ProjectPage{
				Items:   []model.Project{{ID: projectReadErrorID, Name: "Future", CreatedAt: time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)}},
				HasMore: true,
			},
		},
	})
	page, err := NewProjects(db).List(t.Context(), principal, model.PageRequest{Limit: 1})
	assertOperational(t, err)
	var encodingError *json.MarshalerError
	if !strings.Contains(err.Error(), "encode project cursor") || !errors.As(err, &encodingError) ||
		encodingError.Unwrap() == nil || !reflect.DeepEqual(page, coreproject.ProjectPage{}) {
		t.Fatalf("unrepresentable cursor must fail without a partial page: %#v, %#v", page, err)
	}
}
