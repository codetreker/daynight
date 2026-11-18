package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"reflect"
	"testing"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
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

func TestServiceTerminalStorageFailures(t *testing.T) {
	actor := model.Principal{Kind: model.PATCredential, UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "20000000-0000-4000-8000-000000000001"}
	const project = "30000000-0000-4000-8000-000000000001"
	const task = "40000000-0000-4000-8000-000000000001"
	const sessionID = "50000000-0000-4000-8000-000000000001"
	for _, test := range []struct {
		point   string
		failure string
		calls   []string
	}{
		{"archive_task", "task", []string{"task"}},
		{"credential", "credential", []string{"task", "credential"}},
		{"project", "project", []string{"task", "credential", "project"}},
		{"terminal", "load", []string{"task", "credential", "project", "load"}},
	} {
		t.Run("archive/"+test.point, func(t *testing.T) {
			ctx := t.Context()
			dao := &terminalAccessDAO{
				t: t, ctx: ctx, actor: actor, project: project, task: task, session: sessionID,
				failure: test.failure, cause: errSessionDAO,
			}
			writes := 0
			writer := archiveCompletionOrderWriter(func(actual context.Context, run func(store.SessionScope) error) (store.Completion, error) {
				writes++
				if actual != ctx || writes != 1 {
					t.Fatalf("unexpected terminal archive transaction: same context=%v writes=%d", actual == ctx, writes)
				}
				err := run(terminalAccessScope{dao: dao})
				if !errors.Is(err, errSessionDAO) {
					t.Fatalf("terminal archive callback lost its storage failure: %v", err)
				}
				outcome := store.TransactionNotCommitted
				return store.Completion{Outcome: outcome}, &store.TransactionError{Phase: "operation", Outcome: outcome, Cause: err}
			})
			engine := core.NewEngine(nil)
			t.Cleanup(func() { stopHistoryEngine(t, engine) })
			result, err := New(writer, engine).TerminalArchiveStatus(ctx, actor, project, task, sessionID)
			if !errors.Is(err, errSessionDAO) || !reflect.DeepEqual(result, v2.Message{}) {
				t.Fatalf("terminal archive returned data or lost its failure: %#v, %v", result, err)
			}
			if writes != 1 || !reflect.DeepEqual(dao.calls, test.calls) {
				t.Fatalf("terminal archive writes=%d calls=%v, want 1 write and %v", writes, dao.calls, test.calls)
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
