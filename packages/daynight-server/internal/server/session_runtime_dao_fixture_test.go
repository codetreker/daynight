package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type sessionRuntimeHTTPStore struct {
	*httpTestStore
	fixture *sessionRuntimeHTTPFixture
}

type sessionRuntimeHTTPScope struct {
	t   *testing.T
	dao store.SessionDAO
}

func (s sessionRuntimeHTTPScope) SessionDAO() store.SessionDAO { return s.dao }
func (s sessionRuntimeHTTPScope) BotDAO() store.BotWriteDAO    { return sessionHTTPRejectedBotDAO{t: s.t} }

type sessionRuntimeHTTPWrites struct {
	session          *store.SessionRecord
	grant            *store.SessionGrant
	instance         string
	seen             *time.Time
	connectionExpiry *time.Time
	disconnected     int
	operations       []store.SessionOperation
	receipts         []sp.Operation
	epochs           []struct {
		id    string
		epoch int64
	}
}

type sessionRuntimeHTTPDAO struct {
	ctx context.Context
	sessionHTTPRejectedDAO
	t             *testing.T
	f             *sessionRuntimeHTTPFixture
	record        store.SessionRecord
	task          store.SessionTask
	operations    []store.SessionOperation
	intentIDs     []string
	queryRevision int64
	calls         map[string]int
	first         string
}

func sessionRuntimeHTTPCopy[T any](v T) T {
	raw, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var copy T
	if err := json.Unmarshal(raw, &copy); err != nil {
		panic(err)
	}
	return copy
}

func (s *sessionRuntimeHTTPStore) run(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	f := s.fixture
	f.mu.Lock()
	d := &sessionRuntimeHTTPDAO{sessionHTTPRejectedDAO: sessionHTTPRejectedDAO{t: s.t}, t: s.t, ctx: ctx, f: f, record: sessionRuntimeHTTPCopy(f.record), task: sessionRuntimeHTTPCopy(f.sessionTask), operations: sessionRuntimeHTTPCopy(f.operations), intentIDs: append([]string(nil), f.intentIDs...), queryRevision: f.queryRevision, calls: map[string]int{}}
	f.mu.Unlock()
	err := fn(sessionRuntimeHTTPScope{t: s.t, dao: d})
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	d.verify()
	if d.calls["ConnectSession"] == 1 {
		f.mu.Lock()
		commit := f.connectionCommit
		f.mu.Unlock()
		if commit == nil {
			d.fail("connection commit has no test barrier")
		}
		select {
		case <-commit:
		case <-ctx.Done():
			return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
		}
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

func (d *sessionRuntimeHTTPDAO) called(ctx context.Context, name string) {
	if ctx != d.ctx {
		d.fail("Session DAO %s escaped transaction context", name)
	}
	if d.first == "" {
		d.first = name
	}
	d.calls[name]++
	d.f.mu.Lock()
	d.f.calls[name]++
	d.f.mu.Unlock()
}
func (d *sessionRuntimeHTTPDAO) fail(format string, args ...any) {
	d.t.Helper()
	d.t.Errorf(format, args...)
	panic(fmt.Sprintf(format, args...))
}
func (d *sessionRuntimeHTTPDAO) id(id string) {
	if id != d.record.Snapshot.SessionID {
		d.fail("Session DAO id=%q, want %q", id, d.record.Snapshot.SessionID)
	}
}
func (d *sessionRuntimeHTTPDAO) verify() {
	required := map[string]int{}
	switch d.first {
	case "ListSessionMediaLeases":
		if len(d.calls) != 1 || d.calls["ListSessionMediaLeases"] != 1 {
			d.fail("media recovery listing retained or reused its database scope")
		}
		return
	case "LockTaskRegistration":
		required = map[string]int{"LockTaskRegistration": 1, "LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTaskRegistration": 1}
	case "SessionLocation":
		required = map[string]int{"SessionLocation": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1}
	case "SessionLocationByGrant":
		required = map[string]int{"SessionLocationByGrant": 1, "LockTask": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 1, "ProjectAccess": 1}
	case "LockTask", "LockArchiveTask":
		required = map[string]int{d.first: 1, "LockCredential": 1, "ProjectAccess": 1}
	default:
		d.fail("unconfigured Session transaction begins with %q", d.first)
	}
	// Each offered operation rechecks its submitting authority within its callback.
	if d.first == "SessionLocation" && d.calls["SessionOperation"] != 0 {
		required["LockCredential"] += d.calls["SessionOperation"]
		required["ProjectAccess"] += d.calls["SessionOperation"]
	}
	for name, n := range required {
		if d.calls[name] != n {
			d.fail("Session callback %s=%d, want %d (first=%s)", name, d.calls[name], n, d.first)
		}
	}
	if d.calls["SessionBotID"] != d.calls["LockSession"] {
		d.fail("Session lookup and lock count differ")
	}
	for _, name := range []string{"SaveSession", "TouchSession", "DisconnectSession", "ConnectSession", "SetSessionGrant", "SetSessionGenerationStop", "InsertSessionOperation", "AcceptedSessionOperations", "CurrentTaskSession", "PendingSessionOperationCount", "UnreconciledSessionOperationCount"} {
		if d.calls[name] > 1 {
			d.fail("extra Session callback %s", name)
		}
	}
	if d.calls["TouchSession"] != 0 || d.calls["ConnectSession"] != 0 || d.calls["DisconnectSession"] != 0 || d.calls["SetSessionGrant"] != 0 || d.calls["InsertSessionOperation"] != 0 || d.calls["SetSessionOperationReceipt"] != 0 {
		if d.calls["SaveSession"] != 1 {
			d.fail("Session callback omitted exact SaveSession")
		}
	}
	if d.calls["PendingSessionOperationCount"] != 0 && d.calls["InsertSessionOperation"] != 1 {
		d.fail("accepted command did not insert exact operation")
	}
	for _, name := range []string{"SetSessionOperationReceipt", "SetSessionOperationEpoch"} {
		if d.calls[name] > d.calls["SessionOperation"] {
			d.fail("extra %s compared with selected operation reads", name)
		}
	}

}
func (d *sessionRuntimeHTTPDAO) LockCredential(ctx context.Context, p model.Principal, now time.Time) error {
	d.called(ctx, "LockCredential")
	if now.IsZero() || p != d.f.handler.principal {
		d.fail("Session credential changed principal or time: %+v", p)
	}
	d.f.mu.Lock()
	revoked := d.f.credentialRevoked
	d.f.mu.Unlock()
	if revoked {
		return model.ErrNotFound
	}
	return ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) ProjectAccess(ctx context.Context, user, project string) (model.ProjectAccess, error) {
	d.called(ctx, "ProjectAccess")
	if user != d.f.handler.principal.UserID || project != d.f.task.ProjectID {
		d.fail("Session project access args %q/%q", user, project)
	}
	return model.ProjectAccess{UserID: user, ProjectID: project, Role: model.ProjectAdmin}, ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) LockTask(ctx context.Context, project, id string) (store.SessionTask, error) {
	d.called(ctx, "LockTask")
	if project != d.f.task.ProjectID || id != d.f.task.ID {
		d.fail("Session Task lock changed address %q/%q", project, id)
	}
	return d.task, ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) LockArchiveTask(ctx context.Context, project, id string) (store.SessionTask, bool, error) {
	d.called(ctx, "LockArchiveTask")
	if project != d.f.task.ProjectID || id != d.f.task.ID {
		d.fail("Session archive Task lock changed address")
	}
	return d.task, false, ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) LockTaskRegistration(ctx context.Context, project, id string) error {
	d.called(ctx, "LockTaskRegistration")
	if project != d.f.task.ProjectID || id != d.f.task.ID {
		d.fail("registration lock changed address")
	}
	return ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) FindTaskRegistration(ctx context.Context, project, registration, task, claim string) (string, error) {
	d.called(ctx, "FindTaskRegistration")
	if project != d.f.task.ProjectID || task != d.f.task.ID || registration != d.f.registration.RegistrationID || claim != d.f.registration.ClaimID {
		d.fail("registration lookup changed identity")
	}
	return d.record.Snapshot.SessionID, ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) SessionBotID(ctx context.Context, id string) (*string, error) {
	d.called(ctx, "SessionBotID")
	d.id(id)
	return nil, ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	d.called(ctx, "LockSession")
	d.id(id)
	return d.record, ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) SessionLocation(ctx context.Context, id string) (store.SessionLocation, error) {
	d.called(ctx, "SessionLocation")
	d.id(id)
	return store.SessionLocation{ProjectID: d.f.task.ProjectID, TaskID: d.f.task.ID, SessionID: id}, ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) SessionLocationByGrant(ctx context.Context, hash []byte) (store.SessionLocation, error) {
	d.called(ctx, "SessionLocationByGrant")
	if !bytes.Equal(hash, d.record.GrantHash) {
		return store.SessionLocation{}, model.ErrNotFound
	}
	return store.SessionLocation{ProjectID: d.f.task.ProjectID, TaskID: d.f.task.ID, SessionID: d.record.Snapshot.SessionID}, ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) CurrentTaskSession(ctx context.Context, project, task, claim string) (string, error) {
	d.called(ctx, "CurrentTaskSession")
	if project != d.f.task.ProjectID || task != d.f.task.ID || claim != d.record.Snapshot.ClaimID {
		d.fail("current Session lookup changed identity")
	}
	return d.record.Snapshot.SessionID, ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) SaveSession(ctx context.Context, in store.SessionRecord) error {
	d.called(ctx, "SaveSession")
	d.id(in.Snapshot.SessionID)
	if in.Snapshot.ClaimID != d.record.Snapshot.ClaimID || in.Snapshot.Identity.ProjectID != d.f.task.ProjectID || in.Snapshot.Identity.TaskID != d.f.task.ID {
		d.fail("saved Session changed owner binding")
	}
	d.f.mu.Lock()
	d.f.writes.session = new(sessionRuntimeHTTPCopy(in))
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) SetSessionGrant(ctx context.Context, in store.SessionGrant) error {
	d.called(ctx, "SetSessionGrant")
	d.id(in.SessionID)
	if in.ParentCredentialID != d.f.handler.principal.CredentialID || len(in.Hash) != 32 || in.ExpiresAt.IsZero() {
		d.fail("grant changed parent or token hash")
	}
	d.f.mu.Lock()
	d.f.writes.grant = new(sessionRuntimeHTTPCopy(in))
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) ConnectSession(ctx context.Context, id, instance string, seen time.Time, expiry *time.Time) error {
	d.called(ctx, "ConnectSession")
	d.id(id)
	if instance == "" || seen.IsZero() || expiry == nil || !expiry.Equal(*d.record.GrantExpiry) {
		d.fail("connection changed instance/time/grant expiry")
	}
	d.f.mu.Lock()
	d.f.writes.instance = instance
	d.f.writes.seen = &seen
	d.f.writes.connectionExpiry = expiry
	captured := d.f.connectionCaptured
	d.f.mu.Unlock()
	if captured == nil {
		d.fail("connection capture has no test barrier")
	}
	close(captured)
	return ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) TouchSession(ctx context.Context, id string, now time.Time) error {
	d.called(ctx, "TouchSession")
	d.id(id)
	if now.IsZero() {
		d.fail("heartbeat time is zero")
	}
	return ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) DisconnectSession(ctx context.Context, id string) error {
	d.called(ctx, "DisconnectSession")
	d.id(id)
	if op, err := d.f.application.engine.BeginOperation(); err != nil {
		d.fail("engine stopped before controller disconnect: %v", err)
	} else {
		op.Close()
	}
	d.f.mu.Lock()
	d.f.writes.disconnected++
	d.f.mu.Unlock()
	return ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) AcceptedSessionOperations(ctx context.Context, id string) ([]string, error) {
	d.called(ctx, "AcceptedSessionOperations")
	d.id(id)
	d.f.mu.Lock()
	defer d.f.mu.Unlock()
	ids := []string{}
	if len(d.f.acceptedPlans) > 0 && d.queryRevision == d.f.queryRevision {
		ids = append(ids, d.f.acceptedPlans[0]...)
		d.f.acceptedPlans = d.f.acceptedPlans[1:]
	}
	return ids, ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) UnreconciledSessionOperations(ctx context.Context, id string, epoch int64) ([]string, error) {
	d.called(ctx, "UnreconciledSessionOperations")
	d.id(id)
	return []string{}, ctx.Err()
}
func (d *sessionRuntimeHTTPDAO) UnreconciledSessionOperationCount(ctx context.Context, id string, epoch int64) (int, error) {
	d.called(ctx, "UnreconciledSessionOperationCount")
	d.id(id)
	return 0, ctx.Err()
}

var _ store.SessionDAO = (*sessionRuntimeHTTPDAO)(nil)
