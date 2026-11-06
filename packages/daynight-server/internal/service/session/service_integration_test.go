package session

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	taskprops "github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/google/uuid"
)

type serviceFixture struct {
	db            *postgres.Store
	service       *Service
	owner         model.Principal
	project, task string
	registration  sp.Registration
}

func newServiceFixture(t *testing.T) serviceFixture {
	t.Helper()
	ctx := context.Background()
	db, err := postgres.Open(ctx, testsupport.ServiceDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	user := testsupport.ServicePrincipal(t, db)
	pat := uuid.NewString()
	hash := sha256.Sum256([]byte(pat))
	if _, err = db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'session test',now(),now()+interval '1 day')`, pat, user.UserID, hash[:]); err != nil {
		t.Fatal(err)
	}
	owner := model.Principal{Kind: model.PATCredential, UserID: user.UserID, CredentialID: pat}
	project, task := uuid.NewString(), uuid.NewString()
	registration := sp.Registration{Protocol: sp.Protocol, RegistrationID: uuid.NewString(), ClaimID: uuid.NewString(), WorkerID: uuid.NewString(), WorktreeID: uuid.NewString(), Provider: "codex", ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString()}
	properties, err := taskprops.WithWorker(model.TaskProperties{}, &model.WorkerClaim{ClaimID: registration.ClaimID, UserID: owner.UserID, WorkerID: registration.WorkerID, WorktreeID: registration.WorktreeID, State: model.WorkerActive, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "test"}, Platform: model.PlatformLinux, Phase: model.WorkerExecuting, ClaimedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'Session test','https://github.com/example/session.git')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id,version,updated_at) SELECT $1,id,1,now() FROM teams WHERE personal_user_id=$2`, []any{project, owner.UserID}},
		{`INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'Session test','in_progress')`, []any{task, project}},
		{`INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, []any{task, string(properties["worker"])}},
	} {
		if _, err = db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	engine := sessioncore.NewEngine(nil)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := engine.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	return serviceFixture{db: db, service: New(db, engine), owner: owner, project: project, task: task, registration: registration}
}

func requireServiceError(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("expected %s, got %v", code, err)
	}
}

func (f serviceFixture) registerWeb(t *testing.T) sp.Snapshot {
	t.Helper()
	v, err := f.service.Register(context.Background(), f.owner, f.project, f.task, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func (f serviceFixture) connectWeb(t *testing.T, v sp.Snapshot) sp.Snapshot {
	t.Helper()
	ctx := context.Background()
	grant, err := f.service.Grant(ctx, f.owner, f.project, f.task, v.SessionID, sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
	if err != nil {
		t.Fatal(err)
	}
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.registration.ControllerID, ControllerInstanceID: f.registration.ControllerInstanceID, Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
	v, err = f.service.Connect(ctx, grant.Token, hello, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestServiceTaskSessionAndAdmission(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	s := f.service
	current, err := s.Current(ctx, f.owner, f.project, f.task)
	if err != nil || current["status"] != "not_registered" {
		t.Fatalf("current: %v %v", current, err)
	}
	v := f.registerWeb(t)
	replay, err := s.Register(ctx, f.owner, f.project, f.task, f.registration)
	if err != nil || replay.SessionID != v.SessionID {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	changed := f.registration
	changed.ControllerID = uuid.NewString()
	_, err = s.Register(ctx, f.owner, f.project, f.task, changed)
	requireServiceError(t, err, "session_conflict")
	current, err = s.Current(ctx, f.owner, f.project, f.task)
	if err != nil || current["status"] != "registered" {
		t.Fatalf("current: %v %v", current, err)
	}
	v = f.connectWeb(t, v)
	if _, err = s.Handle(ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: v.ControllerFence}); err != nil {
		t.Fatal(err)
	}
	bad := v.ControllerFence
	bad.ConnectionEpoch = "42"
	if _, err = s.Handle(ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: bad}); err == nil {
		t.Fatal("stale controller accepted")
	}
	if _, _, _, err = s.BrowserPoll(ctx, f.owner, f.project, f.task, v.SessionID, ""); err != nil {
		t.Fatal(err)
	}
	archive, err := s.ArchiveStatus(ctx, f.owner, f.project, f.task, v.SessionID)
	if err != nil || archive.State != "unavailable" {
		t.Fatalf("archive: %+v %v", archive, err)
	}
	if err = s.Disconnect(ctx, v.ControllerFence); err != nil {
		t.Fatal(err)
	}
	_, err = s.TestSnapshot(ctx, f.owner, v.SessionID)
	requireServiceError(t, err, "session_conflict")
	outsider := testsupport.ServicePrincipal(t, f.db)
	_, err = s.Current(ctx, outsider, f.project, f.task)
	requireServiceError(t, err, "forbidden")
	_, err = s.Current(ctx, f.owner, f.project, uuid.NewString())
	requireServiceError(t, err, "not_found")
	if _, err = f.db.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.owner.CredentialID); err != nil {
		t.Fatal(err)
	}
	_, err = s.Current(ctx, f.owner, f.project, f.task)
	requireServiceError(t, err, "unauthenticated")
}

func TestServiceTestSessionRegistrationAndRevocation(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	s := f.service
	input := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	v, err := s.RegisterTest(ctx, f.owner, input)
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.RegisterTest(ctx, f.owner, input)
	if err != nil || again.SessionID != v.SessionID {
		t.Fatalf("retry: %+v %v", again, err)
	}
	changed := input
	changed.ControllerID = uuid.NewString()
	_, err = s.RegisterTest(ctx, f.owner, changed)
	requireServiceError(t, err, "session_conflict")
	page, err := s.ListTest(ctx, f.owner, "", 10, false)
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("list: %+v %v", page, err)
	}
	if _, err = s.ArchiveStatus(ctx, f.owner, "", "", v.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.TestSnapshot(ctx, f.owner, v.SessionID); err != nil {
		t.Fatal(err)
	}
	other := testsupport.ServicePrincipal(t, f.db)
	_, err = s.TestSnapshot(ctx, other, v.SessionID)
	requireServiceError(t, err, "forbidden")
	_, err = s.TestSnapshot(ctx, f.owner, uuid.NewString())
	requireServiceError(t, err, "not_found")
	grant, err := s.Grant(ctx, f.owner, "", "", v.SessionID, sp.Grant{Protocol: sp.Protocol, TestExecutionID: v.TestExecutionID, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
	if err != nil {
		t.Fatal(err)
	}
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
	v, err = s.Connect(ctx, grant.Token, hello, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Handle(ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: v.ControllerFence}); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, f.owner.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.TestSnapshot(ctx, f.owner, v.SessionID); err == nil {
		t.Fatal("revoked parent retained access")
	}
	if _, err = s.Handle(ctx, sp.ControllerMessage{Type: "heartbeat", ControllerFence: v.ControllerFence}); err == nil {
		t.Fatal("revoked controller remained active")
	}
}

func TestServiceTerminalAndArchiveAdmission(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	s := f.service
	s.SetOrigin("https://daynight.example")
	if _, err := f.db.Pool.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{agentControlMode}','"herdr"')::text WHERE task_id=$1 AND name='worker'`, f.task); err != nil {
		t.Fatal(err)
	}
	pane := "pane"
	m := v2.Message{Envelope: v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, Type: "registration", SessionID: uuid.NewString(), ClaimID: f.registration.ClaimID, ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}, Payload: v2.Registration{RegistrationID: uuid.NewString(), Mode: "register", Owner: v2.Owner{ProjectID: f.project, TaskID: f.task, WorkerID: f.registration.WorkerID, WorktreeID: f.registration.WorktreeID, OwnerUserID: f.owner.UserID, ServerOrigin: "https://daynight.example", Provider: "codex"}, Binding: v2.Binding{InstanceID: "instance", SessionID: "herdr", WorkspaceID: "workspace", PaneID: v2.NativePaneID{Text: &pane}, TerminalID: "term_one"}, Capabilities: v2.Capabilities{Observe: true, Control: true, Archive: true}}}
	if _, err := s.RegisterTerminal(ctx, f.owner, f.project, f.task, m); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RegisterTerminal(ctx, f.owner, f.project, f.task, m); err != nil {
		t.Fatal(err)
	}
	current, err := s.CurrentTerminal(ctx, f.owner, f.project, f.task)
	if err != nil || current["status"] != "registered" {
		t.Fatalf("current: %v %v", current, err)
	}
	if _, err = s.TerminalHistory(ctx, f.owner, f.project, f.task, "", 10); err != nil {
		t.Fatal(err)
	}
	if _, err = s.TerminalState(ctx, f.owner, f.project, f.task, m.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err = s.TerminalArchiveStatus(ctx, f.owner, f.project, f.task, m.SessionID); err != nil {
		t.Fatal(err)
	}
	_, err = s.TerminalState(ctx, f.owner, f.project, f.task, uuid.NewString())
	requireServiceError(t, err, "not_found")
	if _, err = f.db.Pool.Exec(ctx, `UPDATE tasks SET deleted_at=now() WHERE id=$1`, f.task); err != nil {
		t.Fatal(err)
	}
	if _, err = s.TerminalArchiveState(ctx, f.owner, f.project, f.task, m.SessionID); err != nil {
		t.Fatal(err)
	}
	other := testsupport.ServicePrincipal(t, f.db)
	if _, err = s.TerminalArchiveState(ctx, other, f.project, f.task, m.SessionID); err == nil {
		t.Fatal("foreign finalizer accepted")
	}
}
