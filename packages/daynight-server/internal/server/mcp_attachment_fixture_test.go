package server

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func mcpAttachmentCheck(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Errorf("MCP attachment DAO arguments: got %#v, want %#v", got, want)
		panic("MCP attachment DAO contract violated")
	}
}

type mcpAttachmentDAO struct {
	t               *testing.T
	AttachmentCall  func(context.Context, string, string, string) (model.Attachment, error)
	AttachmentsCall func(context.Context, string, string, store.AttachmentQuery) (store.AttachmentPage, error)
	ConflictCall    func(context.Context, string, string, store.AttachmentConflictQuery) (bool, error)
	PutCall         func(context.Context, model.Attachment) (model.Attachment, bool, error)
	DeleteCall      func(context.Context, string, string, string) error
}

func (d *mcpAttachmentDAO) Attachment(ctx context.Context, project, task, path string) (model.Attachment, error) {
	if d.AttachmentCall == nil {
		unexpectedHTTPCall(d.t, "AttachmentDAO.Attachment")
	}
	return d.AttachmentCall(ctx, project, task, path)
}
func (d *mcpAttachmentDAO) Attachments(ctx context.Context, project, task string, q store.AttachmentQuery) (store.AttachmentPage, error) {
	if d.AttachmentsCall == nil {
		unexpectedHTTPCall(d.t, "AttachmentDAO.Attachments")
	}
	value, err := d.AttachmentsCall(ctx, project, task, q)
	return mcpCloneFixture(value), err
}
func (d *mcpAttachmentDAO) AttachmentPathConflict(ctx context.Context, project, task string, q store.AttachmentConflictQuery) (bool, error) {
	if d.ConflictCall == nil {
		unexpectedHTTPCall(d.t, "AttachmentDAO.AttachmentPathConflict")
	}
	return d.ConflictCall(ctx, project, task, q)
}
func (d *mcpAttachmentDAO) PutAttachment(ctx context.Context, item model.Attachment) (model.Attachment, bool, error) {
	if d.PutCall == nil {
		unexpectedHTTPCall(d.t, "AttachmentDAO.PutAttachment")
	}
	return d.PutCall(ctx, item)
}
func (d *mcpAttachmentDAO) DeleteAttachment(ctx context.Context, project, task, path string) error {
	if d.DeleteCall == nil {
		unexpectedHTTPCall(d.t, "AttachmentDAO.DeleteAttachment")
	}
	return d.DeleteCall(ctx, project, task, path)
}

type mcpAttachmentScope struct {
	t                 *testing.T
	DAO               store.AttachmentMutationDAO
	PresenceCall      func(context.Context, string, string) (store.TaskPresence, error)
	AuthorizationCall func(context.Context, model.Principal, string) (model.ProjectAccess, error)
	LiveCall          func(context.Context, string) error
	ChunkCall         func(context.Context, string, int64) (model.UploadChunk, error)
}

func (s *mcpAttachmentScope) LockTaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	if s.PresenceCall == nil {
		unexpectedHTTPCall(s.t, "AttachmentScope.LockTaskPresence")
	}
	return s.PresenceCall(ctx, project, task)
}
func (s *mcpAttachmentScope) ProjectAuthorization(ctx context.Context, p model.Principal, project string) (model.ProjectAccess, error) {
	if s.AuthorizationCall == nil {
		unexpectedHTTPCall(s.t, "AttachmentScope.ProjectAuthorization")
	}
	return s.AuthorizationCall(ctx, p, project)
}
func (s *mcpAttachmentScope) ProjectLive(ctx context.Context, project string) error {
	if s.LiveCall == nil {
		unexpectedHTTPCall(s.t, "AttachmentScope.ProjectLive")
	}
	return s.LiveCall(ctx, project)
}
func (s *mcpAttachmentScope) UploadChunkAt(ctx context.Context, id string, offset int64) (model.UploadChunk, error) {
	if s.ChunkCall == nil {
		unexpectedHTTPCall(s.t, "AttachmentScope.UploadChunkAt")
	}
	return s.ChunkCall(ctx, id, offset)
}
func (s *mcpAttachmentScope) AttachmentDAO() store.AttachmentMutationDAO {
	if s.DAO == nil {
		unexpectedHTTPCall(s.t, "AttachmentScope.AttachmentDAO")
	}
	return s.DAO
}

func mcpAttachmentRead(t *testing.T, tx *httpTestStore, p model.Principal, project, task string, reader store.AttachmentReader) {
	t.Helper()
	counts := newHTTPCallPlan(t, map[string]int{"snapshot": 1, "access": 1, "presence": 1})
	snapshot := newHTTPTestSnapshot(t)
	snapshot.Projects = projectHTTPReader{ProjectAccessCall: func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		counts.Called("access")
		mcpAttachmentCheck(t, actor, p)
		mcpAttachmentCheck(t, id, project)
		return model.ProjectAccess{ProjectID: project, UserID: p.UserID, Role: model.ProjectAdmin}, nil
	}}
	snapshot.Tasks = &mcpAttachmentTaskReader{t: t, PresenceCall: func(ctx context.Context, pid, tid string) (store.TaskPresence, error) {
		counts.Called("presence")
		mcpAttachmentCheck(t, []string{pid, tid}, []string{project, task})
		return store.TaskPresence{Found: true}, nil
	}}
	snapshot.Attachments = reader
	tx.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		counts.Called("snapshot")
		return op(snapshot)
	}
}

type mcpAttachmentTaskReader struct {
	t            *testing.T
	PresenceCall func(context.Context, string, string) (store.TaskPresence, error)
}

func (d *mcpAttachmentTaskReader) TaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	if d.PresenceCall == nil {
		unexpectedHTTPCall(d.t, "TaskReader.TaskPresence")
	}
	return d.PresenceCall(ctx, project, task)
}

func mcpAttachmentMutation(t *testing.T, tx *httpTestStore, p model.Principal, project, task string, dao store.AttachmentMutationDAO, authorize bool) *mcpAttachmentScope {
	t.Helper()
	want := map[string]int{"mutation": 1, "presence": 1}
	if authorize {
		want["authorization"] = 1
	} else {
		want["live"] = 1
	}
	counts := newHTTPCallPlan(t, want)
	scope := &mcpAttachmentScope{t: t, DAO: dao, PresenceCall: func(ctx context.Context, pid, tid string) (store.TaskPresence, error) {
		counts.Called("presence")
		mcpAttachmentCheck(t, []string{pid, tid}, []string{project, task})
		return store.TaskPresence{Found: true}, nil
	}}
	if authorize {
		scope.AuthorizationCall = func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
			counts.Called("authorization")
			mcpAttachmentCheck(t, actor, p)
			mcpAttachmentCheck(t, id, project)
			return model.ProjectAccess{ProjectID: project, UserID: p.UserID, Role: model.ProjectAdmin}, nil
		}
	} else {
		scope.LiveCall = func(ctx context.Context, id string) error {
			counts.Called("live")
			mcpAttachmentCheck(t, id, project)
			return nil
		}
	}
	tx.WriteAttachmentMutationCall = func(ctx context.Context, op func(store.AttachmentMutationScope) error) (store.Completion, error) {
		counts.Called("mutation")
		err := op(scope)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	return scope
}

type mcpTransferDAO struct {
	t                        *testing.T
	StatsCall                func(ctx context.Context) (store.PrivateTransferStats, error)
	AuthorizeCall            func(ctx context.Context, p model.Principal, kind, id, project, task string) error
	LockProjectLifecycleCall func(ctx context.Context, project, task string) error
	GetCall                  func(ctx context.Context, id string) (model.PrivateTransfer, error)
	InsertCall               func(ctx context.Context, row model.PrivateTransfer) (model.PrivateTransfer, bool, error)
	CountActiveCall          func(ctx context.Context, user string) (int, error)
	LockLedgerCall           func(ctx context.Context) error
	ReservedTotalCall        func(ctx context.Context) (int64, error)
	OutstandingTotalCall     func(ctx context.Context) (int64, error)
	AddReservationCall       func(ctx context.Context, id string, n int64) (model.PrivateTransfer, error)
	SubtractOutstandingCall  func(ctx context.Context, id string, n int64) (model.PrivateTransfer, error)
	PutCall                  func(ctx context.Context, row model.PrivateTransfer, version int64) (model.PrivateTransfer, error)
	ReleaseCall              func(ctx context.Context, row model.PrivateTransfer, version int64, until time.Time, state string) (model.PrivateTransfer, error)
	UploadChunkCall          func(ctx context.Context, id, chunk string) (model.UploadChunk, error)
	UploadChunkAtCall        func(ctx context.Context, id string, offset int64) (model.UploadChunk, error)
	InsertUploadChunkCall    func(ctx context.Context, chunk model.UploadChunk) error
	DueCall                  func(ctx context.Context, at time.Time, limit int) ([]model.PrivateTransfer, error)
	PruneCall                func(ctx context.Context, at time.Time, limit int) (int64, error)
}

func (d *mcpTransferDAO) Stats(ctx context.Context) (store.PrivateTransferStats, error) {
	if d.StatsCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.Stats")
	}
	return d.StatsCall(ctx)
}
func (d *mcpTransferDAO) Authorize(ctx context.Context, p model.Principal, kind, id, project, task string) error {
	if d.AuthorizeCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.Authorize")
	}
	return d.AuthorizeCall(ctx, p, kind, id, project, task)
}
func (d *mcpTransferDAO) LockProjectLifecycle(ctx context.Context, project, task string) error {
	if d.LockProjectLifecycleCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.LockProjectLifecycle")
	}
	return d.LockProjectLifecycleCall(ctx, project, task)
}
func (d *mcpTransferDAO) Get(ctx context.Context, id string) (model.PrivateTransfer, error) {
	if d.GetCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.Get")
	}
	value, err := d.GetCall(ctx, id)
	return mcpCloneFixture(value), err
}
func (d *mcpTransferDAO) Insert(ctx context.Context, row model.PrivateTransfer) (model.PrivateTransfer, bool, error) {
	if d.InsertCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.Insert")
	}
	value, created, err := d.InsertCall(ctx, row)
	return mcpCloneFixture(value), created, err
}
func (d *mcpTransferDAO) CountActive(ctx context.Context, user string) (int, error) {
	if d.CountActiveCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.CountActive")
	}
	return d.CountActiveCall(ctx, user)
}
func (d *mcpTransferDAO) LockLedger(ctx context.Context) error {
	if d.LockLedgerCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.LockLedger")
	}
	return d.LockLedgerCall(ctx)
}
func (d *mcpTransferDAO) ReservedTotal(ctx context.Context) (int64, error) {
	if d.ReservedTotalCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.ReservedTotal")
	}
	return d.ReservedTotalCall(ctx)
}
func (d *mcpTransferDAO) OutstandingTotal(ctx context.Context) (int64, error) {
	if d.OutstandingTotalCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.OutstandingTotal")
	}
	return d.OutstandingTotalCall(ctx)
}
func (d *mcpTransferDAO) AddReservation(ctx context.Context, id string, n int64) (model.PrivateTransfer, error) {
	if d.AddReservationCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.AddReservation")
	}
	value, err := d.AddReservationCall(ctx, id, n)
	return mcpCloneFixture(value), err
}
func (d *mcpTransferDAO) SubtractOutstanding(ctx context.Context, id string, n int64) (model.PrivateTransfer, error) {
	if d.SubtractOutstandingCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.SubtractOutstanding")
	}
	value, err := d.SubtractOutstandingCall(ctx, id, n)
	return mcpCloneFixture(value), err
}
func (d *mcpTransferDAO) Put(ctx context.Context, row model.PrivateTransfer, version int64) (model.PrivateTransfer, error) {
	if d.PutCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.Put")
	}
	value, err := d.PutCall(ctx, row, version)
	return mcpCloneFixture(value), err
}
func (d *mcpTransferDAO) Release(ctx context.Context, row model.PrivateTransfer, version int64, until time.Time, state string) (model.PrivateTransfer, error) {
	if d.ReleaseCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.Release")
	}
	value, err := d.ReleaseCall(ctx, row, version, until, state)
	return mcpCloneFixture(value), err
}
func (d *mcpTransferDAO) UploadChunk(ctx context.Context, id, chunk string) (model.UploadChunk, error) {
	if d.UploadChunkCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.UploadChunk")
	}
	return d.UploadChunkCall(ctx, id, chunk)
}
func (d *mcpTransferDAO) UploadChunkAt(ctx context.Context, id string, offset int64) (model.UploadChunk, error) {
	if d.UploadChunkAtCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.UploadChunkAt")
	}
	return d.UploadChunkAtCall(ctx, id, offset)
}
func (d *mcpTransferDAO) InsertUploadChunk(ctx context.Context, chunk model.UploadChunk) error {
	if d.InsertUploadChunkCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.InsertUploadChunk")
	}
	return d.InsertUploadChunkCall(ctx, chunk)
}
func (d *mcpTransferDAO) Due(ctx context.Context, at time.Time, limit int) ([]model.PrivateTransfer, error) {
	if d.DueCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.Due")
	}
	value, err := d.DueCall(ctx, at, limit)
	return mcpCloneFixture(value), err
}
func (d *mcpTransferDAO) Prune(ctx context.Context, at time.Time, limit int) (int64, error) {
	if d.PruneCall == nil {
		unexpectedHTTPCall(d.t, "PrivateTransferDAO.Prune")
	}
	return d.PruneCall(ctx, at, limit)
}

func mcpAttachmentPage(t *testing.T, tx *httpTestStore, p model.Principal, project, task, after string, limit int, result store.AttachmentPage) {
	t.Helper()
	calls := newHTTPCallPlan(t, map[string]int{"page": 1})
	mcpAttachmentRead(t, tx, p, project, task, &mcpAttachmentDAO{t: t, AttachmentsCall: func(ctx context.Context, pid, tid string, q store.AttachmentQuery) (store.AttachmentPage, error) {
		calls.Called("page")
		mcpAttachmentCheck(t, []string{pid, tid}, []string{project, task})
		want := store.AttachmentQuery{Limit: limit}
		if after != "" {
			want.After = &after
		}
		mcpAttachmentCheck(t, q, want)
		return mcpCloneFixture(result), nil
	}})
}
func mcpAttachmentDenyRead(t *testing.T, tx *httpTestStore, p model.Principal, project string) {
	t.Helper()
	calls := newHTTPCallPlan(t, map[string]int{"snapshot": 1, "access": 1})
	snapshot := newHTTPTestSnapshot(t)
	snapshot.Projects = projectHTTPReader{ProjectAccessCall: func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		calls.Called("access")
		mcpAttachmentCheck(t, actor, p)
		mcpAttachmentCheck(t, id, project)
		return model.ProjectAccess{}, model.ErrNotFound
	}}
	tx.ReadSnapshotCall = func(ctx context.Context, op func(store.SnapshotScope) error) error {
		calls.Called("snapshot")
		return op(snapshot)
	}
}
func mcpAttachmentDenyMutation(t *testing.T, tx *httpTestStore, p model.Principal, project, task string) {
	t.Helper()
	calls := newHTTPCallPlan(t, map[string]int{"mutation": 1, "presence": 1, "authorization": 1})
	scope := &mcpAttachmentScope{t: t, PresenceCall: func(ctx context.Context, pid, tid string) (store.TaskPresence, error) {
		calls.Called("presence")
		mcpAttachmentCheck(t, []string{pid, tid}, []string{project, task})
		return store.TaskPresence{Found: true}, nil
	}, AuthorizationCall: func(ctx context.Context, actor model.Principal, id string) (model.ProjectAccess, error) {
		calls.Called("authorization")
		mcpAttachmentCheck(t, actor, p)
		mcpAttachmentCheck(t, id, project)
		return model.ProjectAccess{}, model.ErrNotFound
	}}
	tx.WriteAttachmentMutationCall = func(ctx context.Context, op func(store.AttachmentMutationScope) error) (store.Completion, error) {
		calls.Called("mutation")
		return store.Completion{Outcome: store.TransactionNotCommitted}, op(scope)
	}
}

func mcpTransferPlan(t *testing.T, tx *httpTestStore, daos ...*mcpTransferDAO) {
	t.Helper()
	counts := newHTTPCallPlan(t, map[string]int{"transfer transaction": len(daos)})
	next := 0
	tx.WritePrivateTransferCall = func(ctx context.Context, op func(store.PrivateTransferDAO) error) (store.Completion, error) {
		counts.Called("transfer transaction")
		dao := daos[next]
		next++
		err := op(dao)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
}
func mcpTransferRow(row model.PrivateTransfer) func() model.PrivateTransfer {
	independent := mcpCloneFixture(row)
	return func() model.PrivateTransfer { return mcpCloneFixture(independent) }
}
func mcpTransferRead(t *testing.T, p model.Principal, auth, lifecycle int, rows ...func() model.PrivateTransfer) *mcpTransferDAO {
	t.Helper()
	want := map[string]int{"get": len(rows)}
	if auth > 0 {
		want["authorize"] = auth
	}
	if lifecycle > 0 {
		want["lifecycle"] = lifecycle
	}
	calls := newHTTPCallPlan(t, want)
	i := 0
	dao := &mcpTransferDAO{t: t, GetCall: func(ctx context.Context, id string) (model.PrivateTransfer, error) {
		calls.Called("get")
		row := rows[i]()
		i++
		mcpAttachmentCheck(t, id, row.ID)
		return mcpCloneFixture(row), nil
	}}
	if auth > 0 {
		dao.AuthorizeCall = func(ctx context.Context, actor model.Principal, kind, id, project, task string) error {
			calls.Called("authorize")
			row := rows[0]()
			mcpAttachmentCheck(t, actor, p)
			mcpAttachmentCheck(t, []string{kind, id, project, task}, []string{"pat", p.CredentialID, row.ProjectID, row.TaskID})
			return nil
		}
	}
	if lifecycle > 0 {
		dao.LockProjectLifecycleCall = func(ctx context.Context, project, task string) error {
			calls.Called("lifecycle")
			row := rows[0]()
			mcpAttachmentCheck(t, []string{project, task}, []string{row.ProjectID, row.TaskID})
			return nil
		}
	}
	return dao
}
func mcpTransferMissing(t *testing.T, id string) *mcpTransferDAO {
	t.Helper()
	calls := newHTTPCallPlan(t, map[string]int{"get": 1})
	return &mcpTransferDAO{t: t, GetCall: func(ctx context.Context, got string) (model.PrivateTransfer, error) {
		calls.Called("get")
		mcpAttachmentCheck(t, got, id)
		return model.PrivateTransfer{}, model.ErrNotFound
	}}
}

var _ store.AttachmentMutationDAO = (*mcpAttachmentDAO)(nil)
var _ store.PrivateTransferDAO = (*mcpTransferDAO)(nil)
var _ store.TaskReader = (*mcpAttachmentTaskReader)(nil)

func (d *mcpAttachmentTaskReader) Task(p0 context.Context, p1 string, p2 string) (model.Task, error) {
	unexpectedHTTPCall(d.t, "TaskReader.Task")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) Tasks(p0 context.Context, p1 string, p2 store.TaskQuery) (store.TaskPage, error) {
	unexpectedHTTPCall(d.t, "TaskReader.Tasks")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) TaskListFence(p0 context.Context, p1 string) (store.TaskListFence, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskListFence")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) TaskPriorityList(p0 context.Context, p1 string, p2 store.TaskPriorityQuery) (store.TaskPriorityPage, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskPriorityList")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) TaskHeader(p0 context.Context, p1 string, p2 string) (model.TaskHeader, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskHeader")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) TaskStep(p0 context.Context, p1 string, p2 string) (model.TaskStep, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskStep")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) TaskSteps(p0 context.Context, p1 string) ([]model.TaskStep, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskSteps")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) TaskStepPage(p0 context.Context, p1 string, p2 int64, p3 int, p4 bool) ([]store.TaskStepProjection, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskStepPage")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) TaskStepSummary(p0 context.Context, p1 string, p2 string) (store.TaskStepProjection, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskStepSummary")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) ThreadMessage(p0 context.Context, p1 string, p2 string) (model.ThreadMessage, error) {
	unexpectedHTTPCall(d.t, "TaskReader.ThreadMessage")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) ThreadCandidates(p0 context.Context, p1 string, p2 *model.ThreadPosition, p3 bool, p4 int) ([]model.ThreadMessage, error) {
	unexpectedHTTPCall(d.t, "TaskReader.ThreadCandidates")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) ThreadSides(p0 context.Context, p1 string, p2 model.ThreadPosition, p3 model.ThreadPosition) (bool, bool, error) {
	unexpectedHTTPCall(d.t, "TaskReader.ThreadSides")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) TaskAssignees(p0 context.Context, p1 string) ([]model.TaskAssigneeFact, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskAssignees")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) ResolveTaskAssignees(p0 context.Context, p1 string, p2 []string) ([]model.TaskAssigneeFact, error) {
	unexpectedHTTPCall(d.t, "TaskReader.ResolveTaskAssignees")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) TaskGraphTasks(p0 context.Context, p1 string, p2 string, p3 store.TaskGraphSelection, p4 int) ([]model.GraphTask, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskGraphTasks")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) TaskCacheEpoch(p0 context.Context, p1 string) (string, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskCacheEpoch")
	panic("unreachable")
}
func (d *mcpAttachmentTaskReader) TaskSyncTasks(p0 context.Context, p1 string, p2 *time.Time, p3 int) ([]model.TaskViewRecord, error) {
	unexpectedHTTPCall(d.t, "TaskReader.TaskSyncTasks")
	panic("unreachable")
}
