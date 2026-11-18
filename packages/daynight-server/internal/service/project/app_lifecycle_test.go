package project

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type appLifecycleTestStore struct {
	database
	f *appLifecycleTest
}
type appLifecycleTest struct {
	t                     *testing.T
	principal             model.Principal
	project               model.Project
	access                model.ProjectAccess
	mode                  string
	cause                 error
	completion            store.Completion
	readCalls, writeCalls int
	retirementCalls       []string
}

func (f *appLifecycleTest) fail(mode string) error {
	if f.mode == mode {
		return f.cause
	}
	return nil
}
func (d appLifecycleTestStore) ReadSnapshot(ctx context.Context, op func(store.SnapshotScope) error) error {
	d.f.readCalls++
	if err := d.f.fail("read"); err != nil {
		return err
	}
	return op(resourceProjectSnapshot{dao: appLifecycleReader{f: d.f}})
}
func (d appLifecycleTestStore) WriteGitHubProjectTransfer(ctx context.Context, id string, op func(store.GitHubProjectTransferScope) error) (store.Completion, error) {
	d.f.writeCalls++
	if id != d.f.project.ID {
		d.f.t.Errorf("wrong Project %q", id)
	}
	if d.f.mode == "no callback" {
		return d.f.completion, d.f.cause
	}
	if err := op(appLifecycleScope{f: d.f}); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return d.f.completion, nil
}
func (d appLifecycleTestStore) WriteGitHubProjectDeletion(ctx context.Context, id string, op func(store.GitHubProjectDeletionScope) error) (store.Completion, error) {
	d.f.writeCalls++
	if id != d.f.project.ID {
		d.f.t.Errorf("wrong Project %q", id)
	}
	if d.f.mode == "no callback" {
		return d.f.completion, d.f.cause
	}
	if err := op(appLifecycleDeletionScope{appLifecycleScope{f: d.f}}); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return d.f.completion, nil
}

type appLifecycleReader struct {
	store.ProjectReader
	f *appLifecycleTest
}

func (d appLifecycleReader) ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error) {
	return d.f.access, d.f.fail("preflight")
}

type appLifecycleScope struct{ f *appLifecycleTest }

func (s appLifecycleScope) ProjectDAO() store.ProjectWriteDAO { return appLifecycleTransferDAO{f: s.f} }
func (s appLifecycleScope) GitHubDAO() store.GitHubProjectRetirementDAO {
	return appLifecycleRetirement{f: s.f}
}
func (s appLifecycleScope) EligibilityDAO() store.WebhookEligibilityDAO {
	return appLifecycleEligibility{f: s.f}
}

type appLifecycleDeletionScope struct{ appLifecycleScope }

func (s appLifecycleDeletionScope) ProjectDAO() store.ProjectDeletionDAO {
	return appLifecycleDeletionDAO{f: s.f}
}
func (s appLifecycleDeletionScope) SessionDAO() store.ProjectSessionRetirementDAO {
	return appLifecycleSession{f: s.f}
}

type appLifecycleTransferDAO struct {
	store.ProjectWriteDAO
	f *appLifecycleTest
}

func (d appLifecycleTransferDAO) LockTransferOwnership(context.Context) (model.ProjectOwnership, error) {
	return d.f.project.Ownership, d.f.fail("transfer")
}
func (d appLifecycleTransferDAO) LockTransferTeams(context.Context, string, string) (store.TransferTeam, store.TransferTeam, error) {
	return store.TransferTeam{Ref: d.f.access.OwnerTeam, Version: 1}, store.TransferTeam{Ref: model.TeamRef{ID: "ef000000-0000-4000-8000-000000000002"}, Version: 1}, nil
}
func (d appLifecycleTransferDAO) ProjectAccess(context.Context, model.Principal) (model.ProjectAccess, error) {
	return d.f.access, nil
}
func (d appLifecycleTransferDAO) MoveOwnership(context.Context, string) (model.ProjectOwnership, error) {
	return model.ProjectOwnership{TeamID: "ef000000-0000-4000-8000-000000000002", Version: 2}, nil
}

type appLifecycleDeletionDAO struct{ f *appLifecycleTest }

func (d appLifecycleDeletionDAO) Authorization(context.Context, model.Principal) (model.ProjectAccess, error) {
	return d.f.access, d.f.fail("authorization")
}
func (d appLifecycleDeletionDAO) VisitTaskWorkers(ctx context.Context, visit func(store.ProjectDeletionWorker) error) error {
	if err := d.f.fail("workers"); err != nil {
		return err
	}
	if d.f.mode == "active claim" {
		return visit(store.ProjectDeletionWorker{Worker: &model.WorkerClaim{State: model.WorkerActive}})
	}
	return nil
}
func (d appLifecycleDeletionDAO) MarkDeleted(context.Context) (bool, error) {
	return d.f.mode != "missing marker", d.f.fail("mark")
}

type appLifecycleRetirement struct{ f *appLifecycleTest }

func (d appLifecycleRetirement) LockBinding(context.Context) (*string, error) {
	d.f.retirementCalls = append(d.f.retirementCalls, "lock")
	return nil, d.f.fail("lock")
}
func (d appLifecycleRetirement) Stop(context.Context, store.GitHubStopDecision) error {
	d.f.retirementCalls = append(d.f.retirementCalls, "stop")
	return d.f.fail("stop")
}
func (d appLifecycleRetirement) AdvanceImpact(context.Context) error {
	d.f.retirementCalls = append(d.f.retirementCalls, "impact")
	return d.f.fail("impact")
}

type appLifecycleEligibility struct {
	store.WebhookEligibilityDAO
	f *appLifecycleTest
}

func (d appLifecycleEligibility) LockAffected(context.Context, store.WebhookEligibilityFilter) ([]store.WebhookAuthorization, error) {
	return nil, d.f.fail("eligibility")
}

type appLifecycleSession struct {
	store.ProjectSessionRetirementDAO
	f *appLifecycleTest
}

func (d appLifecycleSession) LockProjectSessions(context.Context, string, string, int) ([]store.ProjectSessionRetirementFact, error) {
	return nil, d.f.fail("sessions")
}

func newAppLifecycleTest(t *testing.T, mode string) (*AppProjects, *appLifecycleTest) {
	t.Helper()
	_, p, project, access := resourceProjectFacts(t)
	f := &appLifecycleTest{t: t, principal: p, project: project, access: access, mode: mode, cause: errors.New("controlled lifecycle failure"), completion: store.Completion{Outcome: store.TransactionCommitted}}
	return NewAppProjects(appLifecycleTestStore{f: f}), f
}
func TestAppProjectCoordinatorsPropagateRetirementFailures(t *testing.T) {
	for _, operation := range []string{"transfer", "delete"} {
		modes := []string{"lock", "stop", "impact", "eligibility"}
		if operation == "transfer" {
			modes = append(modes, "transfer")
		} else {
			modes = append(modes, "read", "preflight", "authorization", "workers", "mark", "sessions")
		}
		for _, mode := range modes {
			t.Run(operation+"/"+mode, func(t *testing.T) {
				s, f := newAppLifecycleTest(t, mode)
				var err error
				if operation == "delete" {
					_, err = s.Delete(t.Context(), f.principal, f.project.ID)
				} else {
					_, err = s.Transfer(t.Context(), f.principal, f.project.ID, core.TransferInput{Ownership: f.project.Ownership, TargetTeam: core.TeamVersion{ID: "ef000000-0000-4000-8000-000000000002", Version: 1}, ExpectedUserID: f.principal.UserID})
				}
				if !errors.Is(err, f.cause) {
					t.Fatalf("lost cause %v", err)
				}
				if mode == "read" || mode == "preflight" {
					if f.writeCalls != 0 {
						t.Fatal("preflight failure entered write")
					}
				}
			})
		}
	}
}
func TestAppProjectDeletionRefusalsAndCompletion(t *testing.T) {
	for _, mode := range []string{"invalid", "forbidden", "active claim", "missing marker", "committed", "unknown", "no callback"} {
		t.Run(mode, func(t *testing.T) {
			s, f := newAppLifecycleTest(t, mode)
			id := f.project.ID
			if mode == "invalid" {
				id = "bad"
			}
			if mode == "forbidden" {
				f.access.TeamRole = nil
			}
			if mode == "unknown" {
				f.completion.Outcome = store.TransactionUnknown
			}
			r, err := s.Delete(t.Context(), f.principal, id)
			if mode == "committed" {
				if err != nil || !r.Deleted {
					t.Fatalf("receipt %+v %v", r, err)
				}
				return
			}
			if err == nil || r.Deleted {
				t.Fatalf("unconfirmed deletion %+v %v", r, err)
			}
			if mode == "unknown" {
				var failure *DeletionFailure
				if !errors.As(err, &failure) || failure.Outcome != store.TransactionUnknown {
					t.Fatalf("unknown lost: %v", err)
				}
			}
			if mode == "invalid" || mode == "forbidden" {
				if f.writeCalls != 0 {
					t.Fatal("refusal entered write")
				}
			}
		})
	}
}

func (d appLifecycleTransferDAO) RepositoryIdentity(context.Context) (*string, error) {
	identity := "scp://host:repo"
	return &identity, nil
}
func (d appLifecycleTransferDAO) RepositoryOccupied(context.Context, string, string) (bool, error) {
	return d.f.mode == "repository conflict", nil
}

func TestAppProjectRepositoryConflictPrecedesIntegrationEffects(t *testing.T) {
	s, f := newAppLifecycleTest(t, "repository conflict")
	_, err := s.Transfer(t.Context(), f.principal, f.project.ID, core.TransferInput{Ownership: f.project.Ownership, TargetTeam: core.TeamVersion{ID: "ef000000-0000-4000-8000-000000000002", Version: 1}, ExpectedUserID: f.principal.UserID})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "project_repository_conflict" || len(f.retirementCalls) != 0 {
		t.Fatalf("conflict performed integration effects: %v %v", err, f.retirementCalls)
	}
}
