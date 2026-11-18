package session

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type sessionScopeFailureCall struct {
	name   string
	args   []any
	result any
	err    error
}

type sessionScopeFailureDAO struct {
	store.SessionDAO
	t       *testing.T
	ctx     context.Context
	pending []sessionScopeFailureCall
}

func (d *sessionScopeFailureDAO) take(ctx context.Context, name string, args ...any) sessionScopeFailureCall {
	d.t.Helper()
	if ctx != d.ctx || len(d.pending) == 0 {
		d.t.Fatalf("unexpected Session call %s(%#v): same context=%v pending=%#v", name, args, ctx == d.ctx, d.pending)
	}
	call := d.pending[0]
	d.pending = d.pending[1:]
	if call.name != name || !reflect.DeepEqual(call.args, args) {
		d.t.Fatalf("Session call %s(%#v), want %s(%#v)", name, args, call.name, call.args)
	}
	return call
}

func sessionScopeFailureResult[T any](call sessionScopeFailureCall) (T, error) {
	if call.err != nil {
		var zero T
		return zero, call.err
	}
	return call.result.(T), nil
}

func (d *sessionScopeFailureDAO) LockTask(ctx context.Context, project, task string) (store.SessionTask, error) {
	return sessionScopeFailureResult[store.SessionTask](d.take(ctx, "task", project, task))
}

func (d *sessionScopeFailureDAO) LockTaskRegistration(ctx context.Context, project, task string) (store.SessionTask, error) {
	return sessionScopeFailureResult[store.SessionTask](d.take(ctx, "registration_lock", project, task))
}

func (d *sessionScopeFailureDAO) LockArchiveTask(ctx context.Context, project, task string) (store.SessionTask, bool, error) {
	result, err := sessionScopeFailureResult[store.SessionTask](d.take(ctx, "archive_task", project, task))
	return result, false, err
}

func (d *sessionScopeFailureDAO) LockCredential(ctx context.Context, actor model.Principal, now time.Time) error {
	if now.IsZero() {
		d.t.Fatal("Session credential check used a zero time")
	}
	return d.take(ctx, "credential", actor).err
}

func (d *sessionScopeFailureDAO) ProjectAccess(ctx context.Context, user, project string) (model.ProjectAccess, error) {
	return sessionScopeFailureResult[model.ProjectAccess](d.take(ctx, "project", user, project))
}

func (d *sessionScopeFailureDAO) FindTaskRegistration(ctx context.Context, project, registration, task, claim string) (string, error) {
	return sessionScopeFailureResult[string](d.take(ctx, "find_task", project, registration, task, claim))
}

func (d *sessionScopeFailureDAO) LockTestOwner(ctx context.Context, user string) error {
	return d.take(ctx, "owner", user).err
}

func (d *sessionScopeFailureDAO) FindTestRegistration(ctx context.Context, user, registration, execution string) (string, *string, error) {
	id, err := sessionScopeFailureResult[string](d.take(ctx, "find_test", user, registration, execution))
	return id, nil, err
}

func (d *sessionScopeFailureDAO) SessionLocationByGrant(ctx context.Context, hash []byte) (store.SessionLocation, error) {
	return sessionScopeFailureResult[store.SessionLocation](d.take(ctx, "grant", hash))
}

func (d *sessionScopeFailureDAO) SessionLocation(ctx context.Context, id string) (store.SessionLocation, error) {
	return sessionScopeFailureResult[store.SessionLocation](d.take(ctx, "location", id))
}

func (d *sessionScopeFailureDAO) SessionBotID(ctx context.Context, id string) (*string, error) {
	return nil, d.take(ctx, "association", id).err
}

func (d *sessionScopeFailureDAO) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	return sessionScopeFailureResult[store.SessionRecord](d.take(ctx, "session", id))
}

type sessionScopeFailureScope struct {
	dao *sessionScopeFailureDAO
}

func (s sessionScopeFailureScope) SessionDAO() store.SessionDAO { return s.dao }

func (s sessionScopeFailureScope) BotDAO() store.BotWriteDAO { return nil }

func sessionScopeFailureService(t *testing.T, ctx context.Context, pending []sessionScopeFailureCall, outcome store.TransactionOutcome, checkCallback func(error)) *Service {
	t.Helper()
	dao := &sessionScopeFailureDAO{t: t, ctx: ctx, pending: pending}
	writes := 0
	t.Cleanup(func() {
		if writes != 1 || len(dao.pending) != 0 {
			t.Errorf("Session scope writes=%d, want 1; pending calls=%#v", writes, dao.pending)
		}
	})
	writer := archiveCompletionOrderWriter(func(actual context.Context, run func(store.SessionScope) error) (store.Completion, error) {
		writes++
		if actual != ctx || writes != 1 {
			t.Fatalf("unexpected Session transaction: same context=%v writes=%d", actual == ctx, writes)
		}
		err := run(sessionScopeFailureScope{dao: dao})
		checkCallback(err)
		completion := store.Completion{Outcome: outcome}
		if err != nil {
			return completion, &store.TransactionError{Phase: "operation", Outcome: outcome, Cause: err}
		}
		return completion, nil
	})
	engine := core.NewEngine(nil)
	t.Cleanup(func() { stopHistoryEngine(t, engine) })
	return New(writer, engine)
}

func rejectPublishedSessionResult[T any](t *testing.T, result T, err error) error {
	t.Helper()
	var zero T
	if !reflect.DeepEqual(result, zero) {
		t.Errorf("failed Session operation published a result: %#v", result)
	}
	return err
}

func sessionScopeRegistrationJSON(t *testing.T, registration any) []byte {
	t.Helper()
	data, err := json.Marshal(registration)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestServiceStorageFailuresAreReturnedWithoutPublishingWork(t *testing.T) {
	owner := model.Principal{Kind: model.PATCredential, UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "20000000-0000-4000-8000-000000000001"}
	const project = "30000000-0000-4000-8000-000000000001"
	const task = "40000000-0000-4000-8000-000000000001"
	const webSession = "50000000-0000-4000-8000-000000000001"
	const testSession = "50000000-0000-4000-8000-000000000002"
	const grantToken = "dncontroller_ABCD2345EFGH2345JKLM2345NP"
	hash := sha256.Sum256([]byte(grantToken))
	registration := sp.Registration{
		Protocol: sp.Protocol, RegistrationID: "60000000-0000-4000-8000-000000000001",
		ClaimID: "70000000-0000-4000-8000-000000000001", WorkerID: "80000000-0000-4000-8000-000000000001",
		WorktreeID: "90000000-0000-4000-8000-000000000001", Provider: "codex",
		ControllerID: "a0000000-0000-4000-8000-000000000001", ControllerInstanceID: "b0000000-0000-4000-8000-000000000001",
	}
	testRegistration := sp.TestRegistration{
		Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Provider: "codex", InitialInput: "none",
		RegistrationID: "60000000-0000-4000-8000-000000000002", TestExecutionID: "70000000-0000-4000-8000-000000000002",
		ControllerID: "a0000000-0000-4000-8000-000000000002", ControllerInstanceID: "b0000000-0000-4000-8000-000000000002",
	}
	claimedAt := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	taskFacts := store.SessionTask{
		Type: model.TaskTypeTask, Status: string(model.TaskInProgress),
		Worker: &model.WorkerClaim{
			ClaimID: registration.ClaimID, UserID: owner.UserID, WorkerID: registration.WorkerID, WorktreeID: registration.WorktreeID,
			State: model.WorkerActive, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb,
			Machine:  model.WorkerMachine{ID: "c0000000-0000-4000-8000-000000000001", Name: "worker"},
			Platform: model.PlatformLinux, Phase: model.WorkerExecuting, ClaimedAt: claimedAt,
		},
	}
	fence := sp.ControllerFence{Fence: sp.Fence{SessionID: webSession, ClaimID: registration.ClaimID, ExecutionGeneration: "1"}, ConnectionEpoch: "1"}
	connectedWith := owner
	connectedWith.CredentialID = "20000000-0000-4000-8000-000000000002"
	registeredWith := owner
	registeredWith.CredentialID = "20000000-0000-4000-8000-000000000003"
	expires := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	webRecord := store.SessionRecord{
		Owner: owner.UserID, ConnectionParent: connectedWith.CredentialID, Registration: sessionScopeRegistrationJSON(t, registration),
		Snapshot: sp.Snapshot{
			ControllerFence: fence, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1,
			Identity: sp.Identity{
				ProjectID: project, TaskID: task, WorkerID: registration.WorkerID, WorktreeID: registration.WorktreeID,
				ControllerID: registration.ControllerID, ControllerInstanceID: registration.ControllerInstanceID, Provider: registration.Provider, AgentControlMode: "web",
			},
			SessionRevision: "1", HistoryEpoch: "d0000000-0000-4000-8000-000000000001",
			LastEventSeq: "0", LastTimelineSeq: "0", Lifecycle: "active", InitialInputState: "not_submitted",
		},
		ConnectionExpiry: &expires,
	}
	testRecord := store.SessionRecord{
		Owner: owner.UserID, Parent: registeredWith.CredentialID, Registration: sessionScopeRegistrationJSON(t, testRegistration),
		GrantHash: hash[:], GrantExpiry: &expires, GrantKind: "bootstrap",
		Snapshot: sp.Snapshot{
			ControllerFence: sp.ControllerFence{
				Fence:           sp.Fence{SessionID: testSession, TestExecutionID: testRegistration.TestExecutionID, ExecutionGeneration: "1"},
				ConnectionEpoch: "0",
			},
			Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1,
			Identity: sp.Identity{
				OwnerUserID: owner.UserID, ControllerID: testRegistration.ControllerID, ControllerInstanceID: testRegistration.ControllerInstanceID,
				Provider: testRegistration.Provider, AgentControlMode: "web",
			},
			SessionRevision: "1", HistoryEpoch: "d0000000-0000-4000-8000-000000000002",
			LastEventSeq: "0", LastTimelineSeq: "0", Lifecycle: "active", InitialInputState: "not_submitted",
		},
	}

	lockTask := sessionScopeFailureCall{name: "task", args: []any{project, task}, result: taskFacts}
	credential := sessionScopeFailureCall{name: "credential", args: []any{owner}}
	projectAccess := sessionScopeFailureCall{
		name: "project", args: []any{owner.UserID, project},
		result: model.ProjectAccess{ProjectID: project, UserID: owner.UserID, Role: model.ProjectAdmin},
	}
	webAssociation := sessionScopeFailureCall{name: "association", args: []any{webSession}}
	testAssociation := sessionScopeFailureCall{name: "association", args: []any{testSession}}
	lockWeb := sessionScopeFailureCall{name: "session", args: []any{webSession}, result: webRecord}
	lockTest := sessionScopeFailureCall{name: "session", args: []any{testSession}, result: testRecord}
	cases := []struct {
		name  string
		calls []sessionScopeFailureCall
		run   func(*testing.T, context.Context, *Service) error
	}{
		{
			name: "task registration",
			calls: []sessionScopeFailureCall{
				{name: "registration_lock", args: []any{project, task}, result: taskFacts},
				credential,
				projectAccess,
				{name: "find_task", args: []any{project, registration.RegistrationID, task, registration.ClaimID}, result: webSession},
				webAssociation,
				lockWeb,
			},
			run: func(t *testing.T, ctx context.Context, s *Service) error {
				result, err := s.Register(ctx, owner, project, task, registration)
				return rejectPublishedSessionResult(t, result, err)
			},
		},
		{
			name: "test registration",
			calls: []sessionScopeFailureCall{
				credential,
				{name: "owner", args: []any{owner.UserID}},
				{name: "find_test", args: []any{owner.UserID, testRegistration.RegistrationID, testRegistration.TestExecutionID}, result: testSession},
				testAssociation,
				lockTest,
			},
			run: func(t *testing.T, ctx context.Context, s *Service) error {
				result, err := s.RegisterTest(ctx, owner, testRegistration)
				return rejectPublishedSessionResult(t, result, err)
			},
		},
		{
			name: "grant",
			calls: []sessionScopeFailureCall{
				{name: "grant", args: []any{hash[:]}, result: store.SessionLocation{SessionID: testSession}},
				testAssociation,
				lockTest,
				{name: "credential", args: []any{registeredWith}},
			},
			run: func(_ *testing.T, ctx context.Context, s *Service) error {
				return s.AuthenticateController(ctx, grantToken)
			},
		},
		{
			name: "browser", calls: []sessionScopeFailureCall{lockTask, credential, projectAccess, webAssociation, lockWeb},
			run: func(t *testing.T, ctx context.Context, s *Service) error {
				result, events, cursor, err := s.BrowserPoll(ctx, owner, project, task, webSession, "")
				if len(events) != 0 || cursor != "" {
					t.Errorf("failed BrowserPoll published %d events or cursor %q", len(events), cursor)
				}
				return rejectPublishedSessionResult(t, result, err)
			},
		},
		{
			name: "controller",
			calls: []sessionScopeFailureCall{
				{name: "location", args: []any{webSession}, result: store.SessionLocation{ProjectID: project, TaskID: task, SessionID: webSession}},
				lockTask,
				webAssociation,
				lockWeb,
				{name: "credential", args: []any{connectedWith}},
				projectAccess,
			},
			run: func(t *testing.T, ctx context.Context, s *Service) error {
				result, err := s.SourceSeq(ctx, fence)
				return rejectPublishedSessionResult(t, result, err)
			},
		},
		{
			name: "archive",
			calls: []sessionScopeFailureCall{
				{name: "archive_task", args: []any{project, task}, result: taskFacts},
				credential, projectAccess, webAssociation, lockWeb,
			},
			run: func(t *testing.T, ctx context.Context, s *Service) error {
				result, err := s.ArchiveStatus(ctx, owner, project, task, webSession)
				return rejectPublishedSessionResult(t, result, err)
			},
		},
		{
			name: "task query", calls: []sessionScopeFailureCall{lockTask, credential, projectAccess},
			run: func(t *testing.T, ctx context.Context, s *Service) error {
				result, err := s.Current(ctx, owner, project, task)
				return rejectPublishedSessionResult(t, result, err)
			},
		},
		{
			name: "credential query", calls: []sessionScopeFailureCall{credential},
			run: func(t *testing.T, ctx context.Context, s *Service) error {
				result, err := s.ListTest(ctx, owner, "", 10, false)
				return rejectPublishedSessionResult(t, result, err)
			},
		},
	}
	for _, test := range cases {
		for i, call := range test.calls {
			points := []string{call.name}
			if call.name == "registration_lock" {
				points = append(points, "task")
			}
			for _, point := range points {
				t.Run(test.name+"/"+point, func(t *testing.T) {
					ctx := t.Context()
					pending := append([]sessionScopeFailureCall(nil), test.calls[:i+1]...)
					pending[i].err = errSessionDAO
					s := sessionScopeFailureService(t, ctx, pending, store.TransactionNotCommitted, func(err error) {
						if !errors.Is(err, errSessionDAO) {
							t.Fatalf("Session callback did not retain the failure from %s: %v", call.name, err)
						}
					})
					if err := test.run(t, ctx, s); !errors.Is(err, errSessionDAO) {
						t.Fatalf("Session result did not retain the failure from %s: %v", call.name, err)
					}
				})
			}
		}
	}
}

func TestServiceDispatchAuthorizationUsesCurrentCredentials(t *testing.T) {
	owner := model.Principal{Kind: model.PATCredential, UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "20000000-0000-4000-8000-000000000001"}
	parent := owner
	parent.CredentialID = "20000000-0000-4000-8000-000000000002"
	revoked := model.Principal{Kind: model.PATCredential, UserID: "10000000-0000-4000-8000-000000000002", CredentialID: "20000000-0000-4000-8000-000000000003"}
	const project = "30000000-0000-4000-8000-000000000001"
	const missingProject = "30000000-0000-4000-8000-000000000099"
	credential := sessionScopeFailureCall{name: "credential", args: []any{owner}}
	projectAuthority := core.Authority{ProjectID: project}
	testAuthority := core.Authority{Test: true, OwnerID: owner.UserID, ParentCredentialID: parent.CredentialID}
	for _, test := range []struct {
		name      string
		actor     model.Principal
		authority core.Authority
		calls     []sessionScopeFailureCall
		code      string
	}{
		{
			name: "task member", actor: owner, authority: projectAuthority,
			calls: []sessionScopeFailureCall{
				credential,
				{name: "project", args: []any{owner.UserID, project}, result: model.ProjectAccess{ProjectID: project, UserID: owner.UserID, Role: model.ProjectMemberRole}},
			},
		},
		{
			name: "test owner", actor: owner, authority: testAuthority,
			calls: []sessionScopeFailureCall{credential, {name: "credential", args: []any{parent}}},
		},
		{
			name: "test different owner", actor: owner, code: "forbidden",
			authority: core.Authority{Test: true, OwnerID: revoked.UserID, ParentCredentialID: parent.CredentialID},
			calls:     []sessionScopeFailureCall{credential},
		},
		{
			name: "revoked credential", actor: revoked, authority: projectAuthority, code: "unauthenticated",
			calls: []sessionScopeFailureCall{{name: "credential", args: []any{revoked}, err: model.ErrNotFound}},
		},
		{
			name: "missing project", actor: owner, authority: core.Authority{ProjectID: missingProject}, code: "forbidden",
			calls: []sessionScopeFailureCall{credential, {name: "project", args: []any{owner.UserID, missingProject}, err: model.ErrNotFound}},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			check := func(err error) {
				t.Helper()
				if test.code != "" {
					requireServiceError(t, err, test.code)
				} else if err != nil {
					t.Fatalf("dispatch authorization: %v", err)
				}
			}
			outcome := store.TransactionCommitted
			if test.code != "" {
				outcome = store.TransactionNotCommitted
			}
			s := sessionScopeFailureService(t, ctx, test.calls, outcome, check)
			op, err := s.engine.BeginOperation()
			if err != nil {
				t.Fatal(err)
			}
			defer op.Close()
			err = s.write(ctx, op.Finish, func(scope store.SessionScope) error {
				return s.authorize(ctx, op, scope, test.actor, test.authority)
			})
			check(err)
		})
	}
}
