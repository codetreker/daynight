package project

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/google/uuid"
)

func createDeletionFixture(t *testing.T) (*Projects, *postgres.Store, model.Principal, model.Project) {
	t.Helper()
	s, db, _, actor := projectService(t)
	project, err := s.Create(context.Background(), actor, coreproject.CreateProject{Name: "Deletion", RepoURL: "https://example.com/delete.git", ExpectedUserID: actor.UserID})
	if err != nil {
		t.Fatal(err)
	}
	return s, db, actor, project
}

func TestDeletionServicePreviewPermissionsAndClaims(t *testing.T) {
	s, db, actor, project := createDeletionFixture(t)
	ctx := context.Background()
	other := servicePrincipal(t, db)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'admin')`, project.ID, other.UserID)
	ids := []string{"00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004"}
	claim := model.WorkerClaim{ClaimID: uuid.NewString(), UserID: actor.UserID, WorkerID: uuid.NewString(), Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine"}, Platform: model.TaskPlatform("linux"), Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString(), Phase: model.WorkerWaiting, State: model.WorkerActive, ClaimedAt: time.Now().UTC()}
	for i, id := range ids {
		exec(`INSERT INTO tasks(id,project_id,title,status,deleted_at) VALUES($1,$2,$3,CASE WHEN $4=1 THEN 'done' ELSE 'todo' END,CASE WHEN $4=3 THEN now() END)`, id, project.ID, fmt.Sprintf("Task %d", i), i)
		claim.State = model.WorkerActive
		if i == 1 {
			claim.State = model.WorkerCompleted
		}
		raw, err := taskproperty.EncodeWorker(&claim)
		if err != nil {
			t.Fatal(err)
		}
		exec(`INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, id, string(raw))
	}
	exec(`INSERT INTO task_properties(task_id,name,value) VALUES($1,'paused','true')`, ids[0])
	exec(`INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'x','text/plain',1),($1,$3,'x','text/plain',1)`, project.ID, ids[0], ids[3])
	page := model.PageRequest{Limit: 1}
	_, err := s.DeletionPreview(ctx, model.Principal{}, project.ID, page)
	transferFault(t, err, "unauthenticated")
	_, err = s.DeletionPreview(ctx, actor, "bad", page)
	transferFault(t, err, "invalid_input")
	_, err = s.DeletionPreview(ctx, actor, project.ID, model.PageRequest{Limit: 0})
	transferFault(t, err, "invalid_input")
	_, err = s.DeletionPreview(ctx, other, project.ID, page)
	transferFault(t, err, "forbidden")
	_, err = s.Delete(ctx, other, project.ID)
	transferFault(t, err, "forbidden")
	outsider := servicePrincipal(t, db)
	_, err = s.DeletionPreview(ctx, outsider, project.ID, page)
	transferFault(t, err, "not_found")
	first, err := s.DeletionPreview(ctx, actor, project.ID, page)
	if err != nil {
		t.Fatal(err)
	}
	if first.Project.ID != project.ID || first.Summary.TaskCount != 3 || first.Summary.UnfinishedTaskCount != 2 || first.Summary.AttachmentCount != 1 || len(first.ActiveClaims) != 1 || first.ActiveClaims[0].TaskID != ids[0] || !first.ActiveClaims[0].Paused || first.ActiveClaims[0].Connectivity != "unknown" || first.NextCursor == nil {
		t.Fatalf("first page: %+v", first)
	}
	exec(`INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now(),now()-interval '10 minutes','{}','{}')`, actor.UserID, claim.WorkerID)
	page.Cursor = first.NextCursor
	second, err := s.DeletionPreview(ctx, actor, project.ID, page)
	if err != nil {
		t.Fatal(err)
	}
	if len(second.ActiveClaims) != 1 || second.ActiveClaims[0].TaskID != ids[2] || second.ActiveClaims[0].Connectivity != "offline" || second.NextCursor == nil {
		t.Fatalf("second page: %+v", second)
	}
	page.Cursor = second.NextCursor
	third, err := s.DeletionPreview(ctx, actor, project.ID, page)
	if err != nil {
		t.Fatal(err)
	}
	if len(third.ActiveClaims) != 1 || third.ActiveClaims[0].TaskID != ids[3] || third.NextCursor != nil {
		t.Fatalf("third page: %+v", third)
	}
	page.Cursor = first.NextCursor
	_, err = s.DeletionPreview(ctx, other, project.ID, page)
	transferFault(t, err, "invalid_input")
	exec(`UPDATE workers SET last_seen_at=now() WHERE user_id=$1 AND worker_id=$2`, actor.UserID, claim.WorkerID)
	fresh, err := s.DeletionPreview(ctx, actor, project.ID, model.PageRequest{Limit: 1})
	if err != nil || len(fresh.ActiveClaims) != 1 || fresh.ActiveClaims[0].Connectivity != "online" {
		t.Fatalf("fresh worker: %+v %v", fresh, err)
	}
	exec(`UPDATE workers SET last_seen_at=now()+interval '1 hour' WHERE user_id=$1 AND worker_id=$2`, actor.UserID, claim.WorkerID)
	future, err := s.DeletionPreview(ctx, actor, project.ID, model.PageRequest{Limit: 1})
	if err != nil || len(future.ActiveClaims) != 1 || future.ActiveClaims[0].Connectivity != "offline" {
		t.Fatalf("future worker: %+v %v", future, err)
	}
	_, err = s.Delete(ctx, actor, project.ID)
	transferFault(t, err, "active_worker_claims")
	exec(`DELETE FROM task_properties WHERE name='worker' AND task_id IN (SELECT id FROM tasks WHERE project_id=$1)`, project.ID)
	receipt, err := s.Delete(ctx, actor, project.ID)
	if err != nil || !receipt.Deleted || receipt.ProjectID != project.ID {
		t.Fatalf("receipt %+v %v", receipt, err)
	}
	_, err = s.Delete(ctx, actor, project.ID)
	transferFault(t, err, "not_found")
}

type deletionBeforeWrite struct {
	*postgres.Store
	before func(context.Context) error
}

func (d *deletionBeforeWrite) WriteProjectDeletion(ctx context.Context, id string, op func(store.ProjectDeletionScope) error) (store.Completion, error) {
	if err := d.before(ctx); err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return d.Store.WriteProjectDeletion(ctx, id, op)
}

func TestDeletionServiceRechecksAuthorization(t *testing.T) {
	_, db, actor, project := createDeletionFixture(t)
	ctx := context.Background()
	writer := &deletionBeforeWrite{Store: db, before: func(ctx context.Context) error {
		_, err := db.Pool.Exec(ctx, `UPDATE team_members SET role='member' WHERE team_id=$1 AND user_id=$2`, project.Ownership.TeamID, actor.UserID)
		return err
	}}
	_, err := NewProjects(writer).Delete(ctx, actor, project.ID)
	transferFault(t, err, "forbidden")
	var live bool
	if err = db.Pool.QueryRow(ctx, `SELECT deleted_at IS NULL FROM projects WHERE id=$1`, project.ID).Scan(&live); err != nil || !live {
		t.Fatalf("project changed: %t %v", live, err)
	}
}

type deletionFaultScope struct {
	store.ProjectDeletionScope
	mode  string
	cause error
}

func (s deletionFaultScope) ProjectDAO() store.ProjectDeletionDAO {
	return deletionFaultDAO{ProjectDeletionDAO: s.ProjectDeletionScope.ProjectDAO(), mode: s.mode, cause: s.cause}
}
func (s deletionFaultScope) SessionDAO() store.ProjectSessionRetirementDAO {
	if s.mode == "session" {
		return deletionFaultSession{cause: s.cause}
	}
	return s.ProjectDeletionScope.SessionDAO()
}

type deletionFaultDAO struct {
	store.ProjectDeletionDAO
	mode  string
	cause error
}

func (d deletionFaultDAO) Authorization(ctx context.Context, p model.Principal) (model.ProjectAccess, error) {
	if d.mode == "authorization" {
		return model.ProjectAccess{}, d.cause
	}
	return d.ProjectDeletionDAO.Authorization(ctx, p)
}
func (d deletionFaultDAO) VisitTaskWorkers(ctx context.Context, visit func(store.ProjectDeletionWorker) error) error {
	if d.mode == "worker" {
		return d.cause
	}
	return d.ProjectDeletionDAO.VisitTaskWorkers(ctx, visit)
}
func (d deletionFaultDAO) MarkDeleted(ctx context.Context) (bool, error) {
	switch d.mode {
	case "mark-error":
		return false, d.cause
	case "mark-missing":
		return false, nil
	}
	return d.ProjectDeletionDAO.MarkDeleted(ctx)
}

type deletionFaultSession struct{ cause error }

func (d deletionFaultSession) LockProjectSessions(context.Context, string, string, int) ([]store.ProjectSessionRetirementFact, error) {
	return nil, d.cause
}
func (d deletionFaultSession) ApplyProjectSessionRetirement(context.Context, []store.ProjectSessionRetirementPlan) error {
	return d.cause
}

type deletionScopedFailureStore struct {
	*postgres.Store
	mode  string
	cause error
}

func (d *deletionScopedFailureStore) WriteProjectDeletion(ctx context.Context, id string, op func(store.ProjectDeletionScope) error) (store.Completion, error) {
	return d.Store.WriteProjectDeletion(ctx, id, func(scope store.ProjectDeletionScope) error {
		return op(deletionFaultScope{ProjectDeletionScope: scope, mode: d.mode, cause: d.cause})
	})
}

func TestDeletionServiceRollsBackScopedFailures(t *testing.T) {
	_, db, actor, project := createDeletionFixture(t)
	ctx := context.Background()
	sentinel := errors.New("injected transaction failure")
	for _, mode := range []string{"authorization", "worker", "mark-error", "mark-missing", "session"} {
		t.Run(mode, func(t *testing.T) {
			_, err := NewProjects(&deletionScopedFailureStore{Store: db, mode: mode, cause: sentinel}).Delete(ctx, actor, project.ID)
			var failure *DeletionFailure
			if !errors.As(err, &failure) || failure.Outcome != store.TransactionNotCommitted || (mode != "mark-missing" && !errors.Is(err, sentinel)) || failure.Error() == "" {
				t.Fatalf("failure: %#v %v", failure, err)
			}
			var live bool
			if err = db.Pool.QueryRow(ctx, `SELECT deleted_at IS NULL FROM projects WHERE id=$1`, project.ID).Scan(&live); err != nil || !live {
				t.Fatalf("rollback: %t %v", live, err)
			}
		})
	}
}

type deletionResultStore struct {
	*postgres.Store
	completion store.Completion
	cause      error
}

func (d *deletionResultStore) WriteProjectDeletion(context.Context, string, func(store.ProjectDeletionScope) error) (store.Completion, error) {
	return d.completion, d.cause
}

type noDeletionStore struct {
	store.SnapshotReader
	store.ProjectWriter
	store.ProjectCreationWriter
}

type deletionSnapshotFailureStore struct {
	*postgres.Store
	mode  string
	cause error
}

func (d *deletionSnapshotFailureStore) ReadProjectDeletion(ctx context.Context, id string, op func(store.ProjectDeletionSnapshot) error) error {
	if d.mode == "read" {
		return d.cause
	}
	return d.Store.ReadProjectDeletion(ctx, id, func(snapshot store.ProjectDeletionSnapshot) error {
		return op(deletionSnapshotFailure{ProjectDeletionSnapshot: snapshot, mode: d.mode, cause: d.cause})
	})
}

type deletionSnapshotFailure struct {
	store.ProjectDeletionSnapshot
	mode  string
	cause error
}

func (d deletionSnapshotFailure) ObservedAt(ctx context.Context) (time.Time, error) {
	if d.mode == "time" {
		return time.Time{}, d.cause
	}
	return d.ProjectDeletionSnapshot.ObservedAt(ctx)
}
func (d deletionSnapshotFailure) Summary(ctx context.Context) (store.ProjectDeletionSummary, error) {
	if d.mode == "summary" {
		return store.ProjectDeletionSummary{}, d.cause
	}
	return d.ProjectDeletionSnapshot.Summary(ctx)
}
func (d deletionSnapshotFailure) VisitTaskWorkers(ctx context.Context, visit func(store.ProjectDeletionWorker) error) error {
	if d.mode == "workers" {
		return d.cause
	}
	return d.ProjectDeletionSnapshot.VisitTaskWorkers(ctx, visit)
}

type deletionPreflightFailureStore struct {
	*postgres.Store
	cause error
}

func (d *deletionPreflightFailureStore) ReadSnapshot(context.Context, func(store.SnapshotScope) error) error {
	return d.cause
}

func TestDeletionServiceCompletionAndReadFailures(t *testing.T) {
	_, db, actor, project := createDeletionFixture(t)
	ctx := context.Background()
	sentinel := errors.New("injected failure")
	for _, mode := range []string{"read", "time", "summary", "workers"} {
		t.Run(mode, func(t *testing.T) {
			_, err := NewProjects(&deletionSnapshotFailureStore{Store: db, mode: mode, cause: sentinel}).DeletionPreview(ctx, actor, project.ID, model.PageRequest{Limit: 1})
			if !errors.Is(err, sentinel) {
				t.Fatalf("lost cause: %v", err)
			}
		})
	}
	basic := noDeletionStore{SnapshotReader: db, ProjectWriter: db, ProjectCreationWriter: db}
	if _, err := NewProjects(basic).DeletionPreview(ctx, actor, project.ID, model.PageRequest{Limit: 1}); err == nil {
		t.Fatal("missing reader accepted")
	}
	for _, s := range []*Projects{NewProjects(basic), NewProjects(db, nil), NewProjects(&deletionPreflightFailureStore{Store: db, cause: sentinel})} {
		_, err := s.Delete(ctx, actor, project.ID)
		var failure *DeletionFailure
		if !errors.As(err, &failure) || failure.Outcome != store.TransactionNotCommitted {
			t.Fatalf("preflight outcome: %v", err)
		}
	}
	tests := []struct {
		name       string
		completion store.Completion
		cause      error
		want       store.TransactionOutcome
	}{
		{"operation", store.Completion{Outcome: store.TransactionNotCommitted}, sentinel, store.TransactionNotCommitted},
		{"commit unknown", store.Completion{Outcome: store.TransactionUnknown}, &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: sentinel}, store.TransactionUnknown},
		{"cleanup failure", store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: sentinel}, store.TransactionUnknown},
		{"empty committed", store.Completion{Outcome: store.TransactionCommitted}, nil, store.TransactionUnknown},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := NewProjects(&deletionResultStore{Store: db, completion: test.completion, cause: test.cause}).Delete(ctx, actor, project.ID)
			var failure *DeletionFailure
			if !errors.As(err, &failure) || failure.Outcome != test.want || (test.cause != nil && !errors.Is(err, sentinel)) {
				t.Fatalf("outcome: %+v %v", failure, err)
			}
		})
	}
	_, err := NewProjects(db).Delete(ctx, model.Principal{}, project.ID)
	transferFault(t, err, "unauthenticated")
	_, err = NewProjects(db).Delete(ctx, actor, "bad")
	transferFault(t, err, "invalid_input")
}
