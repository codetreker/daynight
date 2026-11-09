package project

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	secretutil "github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type completionProjectReadCall struct {
	name   string
	args   []any
	result any
	err    error
}

type completionProjectReadPlan struct {
	store.ProjectReader
	store.ProjectWriter
	store.ProjectCreationWriter
	store.SnapshotScope
	t           *testing.T
	ctx         context.Context
	pending     []completionProjectReadCall
	completion  error
	begin       error
	callbackErr error
	cancel      context.CancelFunc
	snapshots   int
}

func (s *completionProjectReadPlan) take(ctx context.Context, name string, args ...any) completionProjectReadCall {
	s.t.Helper()
	if ctx != s.ctx || len(s.pending) == 0 {
		s.t.Fatalf("unexpected Project read %s(%#v), pending=%#v", name, args, s.pending)
	}
	call := s.pending[0]
	s.pending = s.pending[1:]
	if name != call.name || !reflect.DeepEqual(args, call.args) {
		s.t.Fatalf("Project read %s(%#v), want %s(%#v)", name, args, call.name, call.args)
	}
	return call
}

func (s *completionProjectReadPlan) ReadSnapshot(ctx context.Context, operation func(store.SnapshotScope) error) error {
	s.snapshots++
	if ctx != s.ctx || s.snapshots != 1 {
		s.t.Fatal("Project snapshot changed context or repeated")
	}
	if s.begin != nil {
		return s.begin
	}
	err := operation(s)
	if s.callbackErr != nil {
		if !errors.Is(err, s.callbackErr) {
			s.t.Fatalf("Project callback error = %v, want %v", err, s.callbackErr)
		}
		return err
	}
	if err != nil {
		s.t.Fatalf("Project callback did not stage its refusal: %v", err)
	}
	if s.cancel != nil {
		s.cancel()
	}
	return s.completion
}

func (s *completionProjectReadPlan) ProjectDAO() store.ProjectReader { return s }
func (s *completionProjectReadPlan) ProjectAccess(ctx context.Context, p model.Principal, id string) (model.ProjectAccess, error) {
	call := s.take(ctx, "access", p, id)
	if call.err != nil {
		return model.ProjectAccess{}, call.err
	}
	value, ok := call.result.(model.ProjectAccess)
	if !ok {
		s.t.Fatal("Project access requires explicit result facts")
	}
	return value, nil
}
func (s *completionProjectReadPlan) Project(ctx context.Context, id string) (model.Project, error) {
	call := s.take(ctx, "project", id)
	value, ok := call.result.(model.Project)
	if !ok && call.err == nil {
		s.t.Fatal("Project read requires explicit result facts")
	}
	return value, call.err
}
func (s *completionProjectReadPlan) ScopedProjects(ctx context.Context, p model.Principal, scope store.ProjectScope, page store.Page) (store.ProjectPage, error) {
	call := s.take(ctx, "scoped", p, scope, page)
	value, ok := call.result.(store.ProjectPage)
	if !ok && call.err == nil {
		s.t.Fatal("scoped Project read requires explicit result facts")
	}
	return value, call.err
}
func (s *completionProjectReadPlan) TransferTeam(ctx context.Context, id string) (store.TransferTeam, error) {
	call := s.take(ctx, "transfer", id)
	value, ok := call.result.(store.TransferTeam)
	if !ok && call.err == nil {
		s.t.Fatal("transfer Team read requires explicit result facts")
	}
	return value, call.err
}
func (s *completionProjectReadPlan) Invitation(ctx context.Context, hash []byte) (model.ProjectInvitation, error) {
	call := s.take(ctx, "invitation", hash)
	value, ok := call.result.(model.ProjectInvitation)
	if !ok && call.err == nil {
		s.t.Fatal("Project invitation read requires explicit result facts")
	}
	return value, call.err
}

func newCompletionProjectReadPlan(t *testing.T, ctx context.Context, pending []completionProjectReadCall) *completionProjectReadPlan {
	t.Helper()
	s := &completionProjectReadPlan{t: t, ctx: ctx, pending: append([]completionProjectReadCall(nil), pending...)}
	t.Cleanup(func() {
		if s.snapshots != 1 {
			t.Errorf("Project snapshots=%d, want 1", s.snapshots)
		}
		if len(s.pending) != 0 {
			t.Errorf("unconsumed Project read calls: %#v", s.pending)
		}
	})
	return s
}

func TestProjectReadCompletionDominatesStagedResults(t *testing.T) {
	p := model.Principal{Kind: model.SessionCredential, UserID: "ab000000-0000-4000-8000-000000000001", CredentialID: "ab000000-0000-4000-8000-000000000002"}
	project, missing := "cd000000-0000-4000-8000-000000000001", "cd000000-0000-4000-8000-000000000099"
	admin := model.ProjectAdmin
	access := model.ProjectAccess{ProjectID: project, UserID: p.UserID, Role: admin, TeamRole: &admin}
	invitation := secretutil.Random("dninvite_")
	for _, test := range []struct {
		name    string
		refusal bool
		plan    []completionProjectReadCall
		read    func(context.Context, *completionProjectReadPlan) (any, error)
	}{
		{"project missing", true, []completionProjectReadCall{{name: "access", args: []any{p, missing}, err: model.ErrNotFound}}, func(ctx context.Context, db *completionProjectReadPlan) (any, error) {
			return NewProjects(db).Get(ctx, p, missing)
		}},
		{"project access missing", true, []completionProjectReadCall{{name: "access", args: []any{p, missing}, err: model.ErrNotFound}}, func(ctx context.Context, db *completionProjectReadPlan) (any, error) {
			return NewProjects(db).Access(ctx, p, missing)
		}},
		{"scoped projects missing team", true, []completionProjectReadCall{{name: "scoped", args: []any{p, store.ProjectScope{Kind: store.ProjectScopeTeam, TeamID: missing}, store.Page{Limit: 10}}, err: model.ErrNotFound}}, func(ctx context.Context, db *completionProjectReadPlan) (any, error) {
			return NewProjects(db).ListScoped(ctx, p, core.ProjectListRequest{Page: model.PageRequest{Limit: 10}, TeamID: &missing})
		}},
		{"project transfer missing team", true, []completionProjectReadCall{{name: "access", args: []any{p, project}, result: access}, {name: "transfer", args: []any{missing}, err: model.ErrNotFound}}, func(ctx context.Context, db *completionProjectReadPlan) (any, error) {
			return NewProjects(db).TransferPreview(ctx, p, project, missing)
		}},
		{"membership missing", true, []completionProjectReadCall{{name: "access", args: []any{p, missing}, err: model.ErrNotFound}}, func(ctx context.Context, db *completionProjectReadPlan) (any, error) {
			return NewMemberships(db).List(ctx, p, missing)
		}},
		{"project invitation missing", true, []completionProjectReadCall{{name: "invitation", args: []any{secretutil.Hash(invitation)}, err: model.ErrNotFound}}, func(ctx context.Context, db *completionProjectReadPlan) (any, error) {
			return NewMemberships(db).InspectInvitation(ctx, p, invitation)
		}},
		{"project success", false, []completionProjectReadCall{{name: "access", args: []any{p, project}, result: access}, {name: "project", args: []any{project}, result: model.Project{ID: project, Name: "Snapshot completion"}}}, func(ctx context.Context, db *completionProjectReadPlan) (any, error) {
			return NewProjects(db).Get(ctx, p, project)
		}},
		{"project access success", false, []completionProjectReadCall{{name: "access", args: []any{p, project}, result: access}}, func(ctx context.Context, db *completionProjectReadPlan) (any, error) {
			return NewProjects(db).Access(ctx, p, project)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			baseline := newCompletionProjectReadPlan(t, t.Context(), test.plan)
			_, err := test.read(t.Context(), baseline)
			var fault *model.Fault
			if test.refusal && !errors.As(err, &fault) || !test.refusal && err != nil {
				t.Fatalf("baseline read did not reach its expected result: %v", err)
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			failure := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: context.Canceled}
			db := newCompletionProjectReadPlan(t, ctx, test.plan)
			db.completion, db.cancel = failure, cancel
			result, err := test.read(ctx, db)
			var completion *store.TransactionError
			if !errors.Is(err, failure) || !errors.Is(err, context.Canceled) || !errors.As(err, &completion) || !completion.CommitAttempted || completion.Outcome != store.TransactionUnknown || errors.As(err, &fault) || !reflect.DeepEqual(result, reflect.Zero(reflect.TypeOf(result)).Interface()) {
				t.Fatalf("completion returned a refusal or partial result: %#v, %v", result, err)
			}
		})
	}
}

func TestProjectAccessRetainsValidationAndOperationalFailures(t *testing.T) {
	p := model.Principal{Kind: model.SessionCredential, UserID: "ab000000-0000-4000-8000-000000000001", CredentialID: "ab000000-0000-4000-8000-000000000002"}
	project := "cd000000-0000-4000-8000-000000000001"
	for _, test := range []struct {
		principal model.Principal
		id, code  string
	}{{model.Principal{}, project, "unauthenticated"}, {p, "invalid", "invalid_input"}} {
		_, err := NewProjects(nil).Access(t.Context(), test.principal, test.id)
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != test.code {
			t.Fatalf("Access validation: %v", err)
		}
	}
	outsider := p
	outsider.UserID = "ab000000-0000-4000-8000-000000000099"
	outsider.CredentialID = "ab000000-0000-4000-8000-000000000098"
	for _, actor := range []model.Principal{p, outsider} {
		cause := &store.Error{Phase: "project access", Cause: context.Canceled}
		db := newCompletionProjectReadPlan(t, t.Context(), []completionProjectReadCall{{name: "access", args: []any{actor, project}, err: cause}})
		db.callbackErr = cause
		result, err := NewProjects(db).Access(t.Context(), actor, project)
		var fault *model.Fault
		if !errors.Is(err, context.Canceled) || errors.As(err, &fault) || !reflect.DeepEqual(result, model.ProjectAccess{}) {
			t.Fatalf("access query failure: %#v, %v", result, err)
		}
	}
	closed := errors.New("snapshot store closed")
	db := newCompletionProjectReadPlan(t, t.Context(), nil)
	db.begin = closed
	result, err := NewProjects(db).Access(t.Context(), p, project)
	var fault *model.Fault
	if !errors.Is(err, closed) || errors.As(err, &fault) || !reflect.DeepEqual(result, model.ProjectAccess{}) {
		t.Fatalf("closed snapshot store: %#v, %v", result, err)
	}
}
