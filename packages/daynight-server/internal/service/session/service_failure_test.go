package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/google/uuid"
)

var errSessionDAO = errors.New("injected Session storage failure")

type failureWriter struct {
	store.SessionWriter
	point string
}

func (w failureWriter) WriteSession(ctx context.Context, run func(store.SessionScope) error) (store.Completion, error) {
	return w.SessionWriter.WriteSession(ctx, func(scope store.SessionScope) error { return run(failureScope{SessionScope: scope, point: w.point}) })
}

type failureScope struct {
	store.SessionScope
	point string
}

func (s failureScope) SessionDAO() store.SessionDAO {
	return failureDAO{SessionDAO: s.SessionScope.SessionDAO(), point: s.point}
}
func (s failureScope) BotDAO() store.BotWriteDAO {
	return failureBot{BotWriteDAO: s.SessionScope.BotDAO(), point: s.point}
}

type failureBot struct {
	store.BotWriteDAO
	point string
}

func (d failureBot) Bot(ctx context.Context, id string) (model.Bot, error) {
	if d.point == "bot" {
		return model.Bot{}, errSessionDAO
	}
	if d.point == "bot_missing" {
		return model.Bot{}, model.ErrNotFound
	}
	return d.BotWriteDAO.Bot(ctx, id)
}

type failureDAO struct {
	store.SessionDAO
	point string
}

func (d failureDAO) LockTask(ctx context.Context, p, id string) (store.SessionTask, error) {
	if d.point == "task" {
		return store.SessionTask{}, errSessionDAO
	}
	return d.SessionDAO.LockTask(ctx, p, id)
}
func (d failureDAO) LockCredential(ctx context.Context, p model.Principal, now time.Time) error {
	if d.point == "credential" {
		return errSessionDAO
	}
	return d.SessionDAO.LockCredential(ctx, p, now)
}
func (d failureDAO) ProjectAccess(ctx context.Context, u, p string) (model.ProjectAccess, error) {
	if d.point == "project" {
		return model.ProjectAccess{}, errSessionDAO
	}
	return d.SessionDAO.ProjectAccess(ctx, u, p)
}
func (d failureDAO) LockTaskRegistration(ctx context.Context, p, id string) error {
	if d.point == "registration_lock" {
		return errSessionDAO
	}
	return d.SessionDAO.LockTaskRegistration(ctx, p, id)
}
func (d failureDAO) FindTaskRegistration(ctx context.Context, p, r, t, c string) (string, error) {
	if d.point == "find_task" {
		return "", errSessionDAO
	}
	return d.SessionDAO.FindTaskRegistration(ctx, p, r, t, c)
}
func (d failureDAO) LockTestOwner(ctx context.Context, id string) error {
	if d.point == "owner" {
		return errSessionDAO
	}
	return d.SessionDAO.LockTestOwner(ctx, id)
}
func (d failureDAO) FindTestRegistration(ctx context.Context, u, r, e string) (string, *string, error) {
	if d.point == "find_test" {
		return "", nil, errSessionDAO
	}
	return d.SessionDAO.FindTestRegistration(ctx, u, r, e)
}
func (d failureDAO) SessionBotID(ctx context.Context, id string) (*string, error) {
	if d.point == "association" {
		return nil, errSessionDAO
	}
	return d.SessionDAO.SessionBotID(ctx, id)
}
func (d failureDAO) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	if d.point == "session" {
		return store.SessionRecord{}, errSessionDAO
	}
	return d.SessionDAO.LockSession(ctx, id)
}
func (d failureDAO) SessionLocation(ctx context.Context, id string) (store.SessionLocation, error) {
	if d.point == "location" {
		return store.SessionLocation{}, errSessionDAO
	}
	return d.SessionDAO.SessionLocation(ctx, id)
}
func (d failureDAO) SessionLocationByGrant(ctx context.Context, h []byte) (store.SessionLocation, error) {
	if d.point == "grant" {
		return store.SessionLocation{}, errSessionDAO
	}
	return d.SessionDAO.SessionLocationByGrant(ctx, h)
}
func (d failureDAO) LockArchiveTask(ctx context.Context, p, id string) (store.SessionTask, bool, error) {
	if d.point == "archive_task" {
		return store.SessionTask{}, false, errSessionDAO
	}
	return d.SessionDAO.LockArchiveTask(ctx, p, id)
}
func (d failureDAO) LockTerminal(ctx context.Context, id string) ([]byte, error) {
	if d.point == "terminal" {
		return nil, errSessionDAO
	}
	return d.SessionDAO.LockTerminal(ctx, id)
}

func TestServiceStorageFailuresAreReturnedWithoutPublishingWork(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	v := f.registerWeb(t)
	v = f.connectWeb(t, v)
	test := sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}
	tv, err := f.service.RegisterTest(ctx, f.owner, test)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := f.service.Grant(ctx, f.owner, "", "", tv.SessionID, sp.Grant{Protocol: sp.Protocol, TestExecutionID: tv.TestExecutionID, ControllerID: test.ControllerID, ControllerInstanceID: test.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		points []string
		run    func(*Service) error
	}{
		{"task registration", []string{"registration_lock", "task", "credential", "project", "find_task", "association", "session"}, func(s *Service) error {
			_, err := s.Register(ctx, f.owner, f.project, f.task, f.registration)
			return err
		}},
		{"test registration", []string{"credential", "owner", "find_test", "association", "session"}, func(s *Service) error { _, err := s.RegisterTest(ctx, f.owner, test); return err }},
		{"grant", []string{"grant", "association", "session", "credential"}, func(s *Service) error { return s.AuthenticateController(ctx, grant.Token) }},
		{"browser", []string{"task", "credential", "project", "association", "session"}, func(s *Service) error {
			_, _, _, err := s.BrowserPoll(ctx, f.owner, f.project, f.task, v.SessionID, "")
			return err
		}},
		{"controller", []string{"location", "task", "association", "session", "credential", "project"}, func(s *Service) error { _, err := s.SourceSeq(ctx, v.ControllerFence); return err }},
		{"archive", []string{"archive_task", "credential", "project", "association", "session"}, func(s *Service) error {
			_, err := s.ArchiveStatus(ctx, f.owner, f.project, f.task, v.SessionID)
			return err
		}},
		{"task query", []string{"task", "credential", "project"}, func(s *Service) error { _, err := s.Current(ctx, f.owner, f.project, f.task); return err }},
		{"credential query", []string{"credential"}, func(s *Service) error { _, err := s.ListTest(ctx, f.owner, "", 10, false); return err }},
	}
	for _, tc := range cases {
		for _, point := range tc.points {
			t.Run(tc.name+"/"+point, func(t *testing.T) {
				s := New(failureWriter{SessionWriter: f.db, point: point}, f.service.engine)
				err := tc.run(s)
				if !errors.Is(err, errSessionDAO) {
					t.Fatalf("failure not returned: %v", err)
				}
			})
		}
	}
}

func TestServiceDispatchAuthorizationUsesCurrentCredentials(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	outsider := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	for _, tc := range []struct {
		name      string
		principal model.Principal
		authority core.Authority
		fail      bool
	}{
		{"task member", f.owner, core.Authority{ProjectID: f.project}, false},
		{"test owner", f.owner, core.Authority{Test: true, OwnerID: f.owner.UserID, ParentCredentialID: f.owner.CredentialID}, false},
		{"test different owner", f.owner, core.Authority{Test: true, OwnerID: uuid.NewString()}, true},
		{"revoked credential", outsider, core.Authority{ProjectID: f.project}, true},
		{"missing project", f.owner, core.Authority{ProjectID: uuid.NewString()}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			op, err := f.service.engine.BeginOperation()
			if err != nil {
				t.Fatal(err)
			}
			defer op.Close()
			err = f.service.write(ctx, op, func(scope store.SessionScope) error {
				return f.service.authorize(ctx, op, scope, tc.principal, tc.authority)
			})
			if (err != nil) != tc.fail {
				t.Fatalf("authorization: %v", err)
			}
		})
	}
}

func TestServiceTerminalStorageFailures(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	f.service.SetOrigin("https://daynight.example")
	if _, err := f.db.Pool.Exec(ctx, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{agentControlMode}','"herdr"')::text WHERE task_id=$1 AND name='worker'`, f.task); err != nil {
		t.Fatal(err)
	}
	pane := "pane"
	m := v2.Message{Envelope: v2.Envelope{Protocol: v2.Protocol, SchemaVersion: 2, ProjectionVersion: 1, Type: "registration", SessionID: uuid.NewString(), ClaimID: f.registration.ClaimID, ExecutionGeneration: "1", AgentControlMode: "herdr", ContentKind: "terminal_recording"}, Payload: v2.Registration{RegistrationID: uuid.NewString(), Mode: "register", Owner: v2.Owner{ProjectID: f.project, TaskID: f.task, WorkerID: f.registration.WorkerID, WorktreeID: f.registration.WorktreeID, OwnerUserID: f.owner.UserID, ServerOrigin: "https://daynight.example", Provider: "codex"}, Binding: v2.Binding{InstanceID: "instance", SessionID: "herdr", WorkspaceID: "workspace", PaneID: v2.NativePaneID{Text: &pane}, TerminalID: "term_one"}, Capabilities: v2.Capabilities{Observe: true, Control: true, Archive: true}}}
	if _, err := f.service.RegisterTerminal(ctx, f.owner, f.project, f.task, m); err != nil {
		t.Fatal(err)
	}
	for _, point := range []string{"registration_lock", "task", "credential", "project"} {
		t.Run("registration/"+point, func(t *testing.T) {
			s := New(failureWriter{SessionWriter: f.db, point: point}, f.service.engine)
			_, err := s.RegisterTerminal(ctx, f.owner, f.project, f.task, m)
			if !errors.Is(err, errSessionDAO) {
				t.Fatalf("failure not returned: %v", err)
			}
		})
	}
	for _, point := range []string{"archive_task", "credential", "project", "terminal"} {
		t.Run("archive/"+point, func(t *testing.T) {
			s := New(failureWriter{SessionWriter: f.db, point: point}, f.service.engine)
			_, err := s.TerminalArchiveStatus(ctx, f.owner, f.project, f.task, m.SessionID)
			if !errors.Is(err, errSessionDAO) {
				t.Fatalf("failure not returned: %v", err)
			}
		})
	}
}

func TestServiceBoundBotLoadEnforcesDeletionAndStorageFailures(t *testing.T) {
	f := newServiceFixture(t)
	ctx := context.Background()
	worker := f.registration.WorkerID
	if _, err := f.db.Pool.Exec(ctx, `INSERT INTO workers(user_id,worker_id,created_at,last_seen_at,telemetry,task_snapshot) VALUES($1,$2,now(),now(),'{}','{}')`, f.owner.UserID, worker); err != nil {
		t.Fatal(err)
	}
	config := model.BotConfiguration{WorkerID: worker, Cwd: "/ordinary/directory", Provider: "codex", Args: []string{}}
	bot, err := botservice.New(f.db).Create(ctx, f.owner, botcore.CreateBot{ID: uuid.NewString(), Name: "Assistant", Overrides: model.BotOverrides{WorkerID: &worker}, ResolvedConfiguration: config})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("Use Daynight CLI."))
	input := core.BotRegistration{BotVersion: bot.Version, Configuration: config, RoleConfiguration: model.BotRoleConfiguration{Instructions: "Use Daynight CLI.", Revision: "1", Digest: hex.EncodeToString(digest[:])}, Registration: sp.TestRegistration{Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, RegistrationID: uuid.NewString(), TestExecutionID: uuid.NewString(), ControllerID: uuid.NewString(), ControllerInstanceID: uuid.NewString(), Provider: "codex", InitialInput: "none"}}
	bound, err := f.service.RegisterBot(ctx, f.owner, worker, bot.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	for _, point := range []string{"bot", "bot_missing"} {
		t.Run(point, func(t *testing.T) {
			s := New(failureWriter{SessionWriter: f.db, point: point}, f.service.engine)
			_, err := s.TestSnapshot(ctx, f.owner, bound.Session.SessionID)
			if point == "bot" {
				if !errors.Is(err, errSessionDAO) {
					t.Fatalf("failure not returned: %v", err)
				}
			} else {
				requireServiceError(t, err, "not_found")
			}
		})
	}
	deletion := botservice.NewDeletions(f.db, nil, f.service.engine)
	if _, err = deletion.DeleteBot(ctx, f.owner, bot.ID, store.DeleteBot{Version: bound.Bot.Version, DeletionID: uuid.NewString()}); err != nil {
		t.Fatal(err)
	}
	_, err = f.service.TestSnapshot(ctx, f.owner, bound.Session.SessionID)
	requireServiceError(t, err, "resource_conflict")
}
