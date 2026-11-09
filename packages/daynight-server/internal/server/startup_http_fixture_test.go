package server

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

func startupTaskModel(value api.Task) model.Task {
	var platform *model.TaskPlatform
	if value.RequiredPlatform != nil {
		v := model.TaskPlatform(*value.RequiredPlatform)
		platform = &v
	}
	return model.Task{ID: value.ID, ProjectID: value.ProjectID, Title: value.Title, Description: value.Description,
		Properties: taskproperty.Clone(value.Properties), Status: model.TaskStatus(value.Status), Version: value.Version,
		CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt, StartedAt: value.StartedAt, CompletedAt: value.CompletedAt,
		CancelledAt: value.CancelledAt, DependsOn: value.DependsOn, ExternalDependsOn: value.ExternalDependsOn,
		BlockedBy: value.BlockedBy, RequiredPlatform: platform, AssignedTo: value.AssignedTo, AllowAgents: value.AllowAgents, Ready: value.Ready}
}

func startupReportValue(t *testing.T, body map[string]any) sp.StartupReport {
	t.Helper()
	value, err := sp.DecodeStartupReport([]byte(jsonBody(t, body)))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func startupReportedTask(t *testing.T, current model.Task, report sp.StartupReport) model.Task {
	t.Helper()
	result := current
	result.Properties = taskproperty.Clone(current.Properties)
	result.Properties["sessionStartup"] = rawProperty(t, report)
	result.Version, result.UpdatedAt = current.Version+1, current.UpdatedAt.Add(time.Second)
	return result
}

func startupReplaceWorker(t *testing.T, current model.Task, change func(*api.WorkerClaim)) model.Task {
	t.Helper()
	result := current
	result.Properties = taskproperty.Clone(current.Properties)
	worker := apiWorker(t, result.Properties)
	change(worker)
	result.Properties["worker"] = rawProperty(t, worker)
	return result
}

// Each request installs a complete plan. A captured write cannot populate the
// facts supplied to a later Task or Session read.
func startupExpectWrite(t *testing.T, f *sessionHTTPFixture, current model.Task, report *sp.StartupReport, matched bool, returned *model.Task, observed *time.Time, principal model.Principal, beforeMatch func()) {
	t.Helper()
	base := newTaskHTTPMockBase(t, "startup")
	project := &taskHTTPProjectWriterMock{taskHTTPMockBase: base.withLabel("project")}
	tasks := &taskHTTPWriterMock{taskHTTPMockBase: base.withLabel("task")}
	sessions := &taskHTTPProjectSessionMock{taskHTTPMockBase: base.withLabel("session")}
	scope := &taskHTTPProjectScopeMock{taskHTTPMockBase: base.withLabel("scope"),
		ProjectDAOFn: func() store.ProjectWriteDAO { return project }, TaskDAOFn: func() store.TaskWriteDAO { return tasks },
		SessionDAOFn: func() store.ProjectSessionDAO { return sessions }}
	counts := map[string]int{}
	var requestContext context.Context
	check := func(ctx context.Context, name string, valid bool) {
		counts[name]++
		if ctx != requestContext || counts[name] != 1 || !valid {
			t.Errorf("startup %s changed context, arguments or count", name)
			panic("invalid startup DAO call")
		}
	}
	project.ProjectAccessFn = func(ctx context.Context, actual model.Principal) (model.ProjectAccess, error) {
		check(ctx, "access", reflect.DeepEqual(actual, principal))
		return model.ProjectAccess{ProjectID: current.ProjectID, UserID: principal.UserID, Role: model.ProjectMemberRole}, nil
	}
	tasks.TaskFn = func(ctx context.Context, id string) (model.Task, error) {
		check(ctx, "task", id == current.ID && counts["access"] == 1)
		return current, nil
	}
	if report != nil {
		sessions.MatchSessionStartupFn = func(ctx context.Context, id string, worker *model.WorkerClaim, actual sp.StartupReport) (bool, error) {
			expectedWorker, err := taskproperty.Worker(current.Properties)
			check(ctx, "match", err == nil && id == current.ID && reflect.DeepEqual(worker, expectedWorker) && reflect.DeepEqual(actual, *report) && counts["task"] == 1)
			if beforeMatch != nil {
				beforeMatch()
			}
			return matched, nil
		}
	}
	if observed != nil {
		tasks.ObservedAtFn = func(ctx context.Context) (time.Time, error) {
			check(ctx, "observed", counts["task"] == 1)
			return *observed, nil
		}
	}
	if returned != nil {
		wanted := taskcore.CurrentWrite(*returned)
		tasks.UpdateTaskFn = func(ctx context.Context, id string, values store.TaskWrite) (model.Task, error) {
			check(ctx, "update", id == current.ID && reflect.DeepEqual(values, wanted) && counts["task"] == 1)
			return *returned, nil
		}
		var active *string
		worker, err := taskproperty.Worker(returned.Properties)
		if err != nil {
			t.Fatal(err)
		}
		if returned.Status == model.TaskInProgress && worker != nil && worker.State == model.WorkerActive && worker.AgentControlMode == model.AgentControlModeWeb {
			active = &worker.ClaimID
		}
		wantDrain := store.TaskSessionDrain{ActiveClaim: active, SourceLifecycle: "active", GraceSeconds: 60,
			TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle", RemoveFields: []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"},
			SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"}}
		sessions.DrainTaskSessionsFn = func(ctx context.Context, id string, value store.TaskSessionDrain) error {
			check(ctx, "drain", id == current.ID && counts["update"] == 1 && reflect.DeepEqual(value, wantDrain))
			return nil
		}
		wantTransition := store.TaskSessionReceiptTransition{LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"}}
		sessions.TransitionTaskSessionReceiptsFn = func(ctx context.Context, id string, value store.TaskSessionReceiptTransition) error {
			check(ctx, "receipts", id == current.ID && counts["drain"] == 1 && reflect.DeepEqual(value, wantTransition))
			return nil
		}
		if returned.Status != current.Status {
			capture := &taskHTTPCaptureDAOMock{taskHTTPMockBase: base.withLabel("capture")}
			capture.FreezeAudienceFn = func(ctx context.Context, project string, kinds []string) ([]store.WebhookAudience, error) {
				check(ctx, "capture", project == current.ProjectID && counts["receipts"] == 1 && reflect.DeepEqual(kinds, []string{protocol.StatusChanged}))
				return []store.WebhookAudience{}, nil
			}
			scope.CaptureDAOFn = func() store.WebhookCaptureDAO { return capture }
		}
	}
	calls := 0
	f.store.WriteProjectCall = func(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		calls++
		if calls != 1 || id != current.ProjectID || work == nil {
			unexpectedHTTPCall(t, "startup WriteProject")
		}
		requestContext = ctx
		err := work(scope)
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	t.Cleanup(func() {
		if calls != 1 || counts["access"] != 1 || counts["task"] != 1 {
			t.Errorf("startup scope not consumed: calls=%d counts=%v", calls, counts)
		}
		if report != nil && counts["match"] != 1 {
			t.Errorf("startup matcher calls=%d, want1", counts["match"])
		}
		if returned != nil && (counts["update"] != 1 || counts["drain"] != 1 || counts["receipts"] != 1) {
			t.Errorf("startup write incomplete: %v", counts)
		}
		if observed != nil && counts["observed"] != 1 {
			t.Errorf("startup claim time calls=%d, want1", counts["observed"])
		}
		if returned != nil && returned.Status != current.Status && counts["capture"] != 1 {
			t.Errorf("startup status capture calls=%d, want1", counts["capture"])
		}
	})
}

func startupExpectTaskRead(t *testing.T, f *sessionHTTPFixture, value model.Task) {
	t.Helper()
	base := newTaskHTTPMockBase(t, "startup read")
	project := &taskHTTPProjectReaderMock{taskHTTPMockBase: base.withLabel("project")}
	task := &taskHTTPReaderMock{taskHTTPMockBase: base.withLabel("task")}
	access, reads, epochs, snapshots := 0, 0, 0, 0
	var requestContext context.Context
	project.ProjectAccessFn = func(ctx context.Context, principal model.Principal, id string) (model.ProjectAccess, error) {
		access++
		if ctx != requestContext || access != 1 || principal != f.handler.principal || id != value.ProjectID {
			unexpectedHTTPCall(t, "startup read access")
		}
		return model.ProjectAccess{ProjectID: id, UserID: principal.UserID, Role: model.ProjectMemberRole}, nil
	}
	task.TaskFn = func(ctx context.Context, project, id string) (model.Task, error) {
		reads++
		if ctx != requestContext || access != 1 || reads != 1 || project != value.ProjectID || id != value.ID {
			unexpectedHTTPCall(t, "startup Task read")
		}
		return value, nil
	}
	task.TaskCacheEpochFn = func(ctx context.Context, project string) (string, error) {
		epochs++
		if ctx != requestContext || reads != 1 || epochs != 1 || project != value.ProjectID {
			unexpectedHTTPCall(t, "startup Task epoch")
		}
		return "startup-epoch", nil
	}
	scope := &taskHTTPSnapshotScopeMock{taskHTTPMockBase: base.withLabel("scope"), ProjectDAOFn: func() store.ProjectReader { return project }, TaskDAOFn: func() store.TaskReader { return task }}
	f.store.ReadSnapshotCall = func(ctx context.Context, work func(store.SnapshotScope) error) error {
		snapshots++
		if snapshots != 1 || work == nil {
			unexpectedHTTPCall(t, "startup snapshot")
		}
		requestContext = ctx
		return work(scope)
	}
	t.Cleanup(func() {
		if snapshots != 1 || access != 1 || reads != 1 || epochs != 1 {
			t.Errorf("startup Task read counts=%d/%d/%d/%d", snapshots, access, reads, epochs)
		}
	})
}

func startupExpectCurrent(t *testing.T, f *sessionHTTPFixture, task store.SessionTask, record store.SessionRecord) {
	t.Helper()
	calls := map[string]int{}
	var requestContext context.Context
	dao := &startupCurrentDAO{sessionHTTPRejectedDAO: sessionHTTPRejectedDAO{t: t}, t: t, f: f, task: task, record: record, calls: calls, context: &requestContext}
	snapshots := 0
	f.store.WriteSessionCall = func(ctx context.Context, work func(store.SessionScope) error) (store.Completion, error) {
		snapshots++
		if snapshots != 1 || work == nil {
			unexpectedHTTPCall(t, "startup current scope")
		}
		requestContext = ctx
		err := work(startupCurrentScope{dao})
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, err
		}
		return store.Completion{Outcome: store.TransactionCommitted}, nil
	}
	t.Cleanup(func() {
		for _, name := range []string{"task", "credential", "access", "current", "bot", "session"} {
			if calls[name] != 1 {
				t.Errorf("startup current %s calls=%d, want1", name, calls[name])
			}
		}
		if snapshots != 1 {
			t.Errorf("startup current scope calls=%d, want1", snapshots)
		}
	})
}

type startupCurrentScope struct{ dao *startupCurrentDAO }

func (s startupCurrentScope) SessionDAO() store.SessionDAO { return s.dao }
func (s startupCurrentScope) BotDAO() store.BotWriteDAO {
	return sessionHTTPRejectedBotDAO{t: s.dao.t}
}

type startupCurrentDAO struct {
	sessionHTTPRejectedDAO
	t       *testing.T
	f       *sessionHTTPFixture
	task    store.SessionTask
	record  store.SessionRecord
	calls   map[string]int
	context *context.Context
}

func (d *startupCurrentDAO) check(ctx context.Context, name string, valid bool) {
	d.calls[name]++
	if ctx != *d.context || d.calls[name] != 1 || !valid {
		unexpectedHTTPCall(d.t, "startup current "+name)
	}
}
func (d *startupCurrentDAO) LockTask(ctx context.Context, project, task string) (store.SessionTask, error) {
	d.check(ctx, "task", project == d.f.task.ProjectID && task == d.f.task.ID)
	return d.task, nil
}
func (d *startupCurrentDAO) LockCredential(ctx context.Context, principal model.Principal, now time.Time) error {
	d.check(ctx, "credential", principal == d.f.handler.principal && !now.IsZero() && d.calls["task"] == 1)
	return nil
}
func (d *startupCurrentDAO) ProjectAccess(ctx context.Context, owner, project string) (model.ProjectAccess, error) {
	d.check(ctx, "access", project == d.f.task.ProjectID && owner == d.f.handler.principal.UserID && d.calls["credential"] == 1)
	return model.ProjectAccess{ProjectID: project, UserID: owner, Role: model.ProjectMemberRole}, nil
}
func (d *startupCurrentDAO) CurrentTaskSession(ctx context.Context, project, task, claim string) (string, error) {
	d.check(ctx, "current", project == d.f.task.ProjectID && task == d.f.task.ID && claim == d.record.Snapshot.ClaimID && d.calls["access"] == 1)
	return d.record.Snapshot.SessionID, nil
}
func (d *startupCurrentDAO) SessionBotID(ctx context.Context, id string) (*string, error) {
	d.check(ctx, "bot", id == d.record.Snapshot.SessionID && d.calls["current"] == 1)
	return nil, nil
}
func (d *startupCurrentDAO) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	d.check(ctx, "session", id == d.record.Snapshot.SessionID && d.calls["bot"] == 1)
	return d.record, nil
}

func startupSessionTask(t *testing.T, current model.Task, report *sp.StartupReport) store.SessionTask {
	t.Helper()
	worker, err := taskproperty.Worker(current.Properties)
	if err != nil {
		t.Fatal(err)
	}
	return store.SessionTask{Worker: worker, Status: string(current.Status), StartupReport: report}
}

func startupTaskDocument(t *testing.T, value model.Task) api.Task {
	t.Helper()
	var platform *string
	if value.RequiredPlatform != nil {
		v := string(*value.RequiredPlatform)
		platform = &v
	}
	return api.Task{ID: value.ID, ProjectID: value.ProjectID, Title: value.Title, Description: value.Description, Properties: taskproperty.Clone(value.Properties), Status: string(value.Status), Version: value.Version,
		CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt, StartedAt: value.StartedAt, CompletedAt: value.CompletedAt, CancelledAt: value.CancelledAt, DependsOn: value.DependsOn, ExternalDependsOn: value.ExternalDependsOn, BlockedBy: value.BlockedBy, AssignedTo: value.AssignedTo, RequiredPlatform: platform, AllowAgents: value.AllowAgents, Ready: value.Ready}
}

type startupRevokedCredential struct{ httpAuthenticationDAO }

func (d *startupRevokedCredential) Authenticate(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
	if _, err := d.httpAuthenticationDAO.Authenticate(ctx, kind, hash, now); err != nil {
		return model.Principal{}, err
	}
	return model.Principal{}, &model.Fault{Code: "unauthenticated", Message: "Credential has been revoked."}
}
