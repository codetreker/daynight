package project

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type mcpProjectReadCompletion struct {
	store.ProjectWriter
	store.ProjectCreationWriter
	store.SnapshotScope
	store.ProjectReader
	t         *testing.T
	ctx       context.Context
	principal model.Principal
	failure   error
	snapshots int
	queries   int
}

func (s *mcpProjectReadCompletion) ReadSnapshot(ctx context.Context, operation func(store.SnapshotScope) error) error {
	s.snapshots++
	if ctx != s.ctx || s.snapshots != 1 {
		s.t.Fatal("unexpected Project snapshot")
	}
	if err := operation(s); err != nil {
		s.t.Fatalf("unexpected Project callback error: %v", err)
	}
	return s.failure
}
func (s *mcpProjectReadCompletion) ProjectDAO() store.ProjectReader { return s }
func (s *mcpProjectReadCompletion) ScopedProjects(ctx context.Context, p model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
	s.queries++
	if ctx != s.ctx || !reflect.DeepEqual(p, s.principal) || !reflect.DeepEqual(scope, store.ProjectScope{Kind: store.ProjectScopeTeam, TeamID: "22222222-2222-4222-8222-222222222222"}) || !reflect.DeepEqual(page, store.Page{Limit: 50}) || s.queries != 1 {
		s.t.Errorf("Project query principal/scope/page: %+v %+v %+v", p, scope, page)
	}
	return store.ProjectPage{Items: []model.Project{}}, nil
}
func TestMCPProjectReadDiscardsResultsAfterSnapshotCompletionFailure(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionUnknown, store.TransactionNotCommitted, store.TransactionCommitted} {
		t.Run(string(outcome), func(t *testing.T) {
			principal := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "44444444-4444-4444-8444-444444444444"}
			failure := &store.TransactionError{Phase: "commit", Outcome: outcome, CommitAttempted: true, Cause: errors.New("snapshot completion failure")}
			store := &mcpProjectReadCompletion{t: t, ctx: t.Context(), principal: principal, failure: failure}
			team := "22222222-2222-4222-8222-222222222222"
			result, err := NewProjects(store).ListScoped(t.Context(), principal, coreproject.ProjectListRequest{TeamID: &team, Page: model.PageRequest{Limit: 50}})
			if !errors.Is(err, failure) || result.Items != nil || result.NextCursor != nil || store.snapshots != 1 || store.queries != 1 {
				t.Fatalf("Project completion = %+v / %v; snapshots=%d queries=%d", result, err, store.snapshots, store.queries)
			}
		})
	}
}
