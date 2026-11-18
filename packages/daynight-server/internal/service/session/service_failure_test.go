package session

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

var errSessionDAO = errors.New("injected Session storage failure")

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

type boundBotFailureDAO struct {
	store.SessionDAO
	store.BotWriteDAO
	t         *testing.T
	ctx       context.Context
	sessionID string
	bot       model.Bot
	cause     error
	pending   []string
}

func (s *boundBotFailureDAO) take(ctx context.Context, call string) {
	s.t.Helper()
	if ctx != s.ctx || len(s.pending) == 0 || s.pending[0] != call {
		s.t.Fatalf("unexpected bound Bot call %s: same context=%v pending=%v", call, ctx == s.ctx, s.pending)
	}
	s.pending = s.pending[1:]
}

type boundBotFailureScope struct{ dao *boundBotFailureDAO }

func (s boundBotFailureScope) SessionDAO() store.SessionDAO {
	s.dao.take(s.dao.ctx, "SessionDAO")
	return s.dao
}

func (s *boundBotFailureDAO) SessionBotID(ctx context.Context, id string) (*string, error) {
	s.take(ctx, "SessionBotID")
	if id != s.sessionID {
		s.t.Fatalf("Session binding ID=%q, want %q", id, s.sessionID)
	}
	botID := s.bot.ID
	return &botID, nil
}

func (s boundBotFailureScope) BotDAO() store.BotWriteDAO {
	s.dao.take(s.dao.ctx, "BotDAO")
	return s.dao
}

func (s *boundBotFailureDAO) Bot(ctx context.Context, id string) (model.Bot, error) {
	s.take(ctx, "Bot")
	if id != s.bot.ID {
		s.t.Fatalf("bound Bot ID=%q, want %q", id, s.bot.ID)
	}
	if s.cause != nil {
		return model.Bot{}, s.cause
	}
	return s.bot, nil
}

func (s *boundBotFailureDAO) LockSession(_ context.Context, id string) (store.SessionRecord, error) {
	s.t.Fatalf("failed bound Bot lookup reached Session lock: %q", id)
	return store.SessionRecord{}, nil
}

func TestServiceBoundBotLoadEnforcesDeletionAndStorageFailures(t *testing.T) {
	actor := model.Principal{Kind: model.PATCredential, UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "20000000-0000-4000-8000-000000000001"}
	sessionID := "50000000-0000-4000-8000-000000000001"
	executionID := "50000000-0000-4000-8000-000000000002"
	const workerID = "80000000-0000-4000-8000-000000000001"
	bot := model.Bot{
		ID: "60000000-0000-4000-8000-000000000001", OwnerUserID: actor.UserID, WorkerID: workerID,
		Name: "Assistant", Version: 3, SessionID: &sessionID, TestExecutionID: &executionID,
		ResolvedConfiguration: model.BotConfiguration{WorkerID: workerID, Cwd: "/ordinary/directory", Provider: "codex", Args: []string{}},
	}
	deleted := bot
	deleted.Version++
	deleted.Deletion = &model.BotDeletion{
		DeletionID: "70000000-0000-4000-8000-000000000001", RequestedVersion: bot.Version,
		WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"},
	}
	for _, test := range []struct {
		name  string
		bot   model.Bot
		cause error
		code  string
	}{
		{name: "bot", bot: bot, cause: errSessionDAO},
		{name: "bot_missing", bot: bot, cause: model.ErrNotFound, code: "not_found"},
		{name: "bot_deleted", bot: deleted, code: "resource_conflict"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := t.Context()
			dao := &boundBotFailureDAO{
				t: t, ctx: ctx, sessionID: sessionID, bot: test.bot, cause: test.cause,
				pending: []string{"SessionDAO", "SessionBotID", "BotDAO", "Bot"},
			}
			checkError := func(err error) {
				t.Helper()
				if test.code != "" {
					requireServiceError(t, err, test.code)
				} else if !errors.Is(err, errSessionDAO) {
					t.Fatalf("bound Bot storage failure lost its cause: %v", err)
				}
			}
			writes := 0
			writer := archiveCompletionOrderWriter(func(actual context.Context, run func(store.SessionScope) error) (store.Completion, error) {
				writes++
				if actual != ctx || writes != 1 {
					t.Fatalf("unexpected Bot Session transaction: same context=%v writes=%d", actual == ctx, writes)
				}
				err := run(boundBotFailureScope{dao: dao})
				checkError(err)
				outcome := store.TransactionNotCommitted
				return store.Completion{Outcome: outcome}, &store.TransactionError{Phase: "operation", Outcome: outcome, Cause: err}
			})
			engine := core.NewEngine(nil)
			t.Cleanup(func() { stopHistoryEngine(t, engine) })
			result, err := New(writer, engine).TestSnapshot(ctx, actor, sessionID)
			checkError(rejectPublishedSessionResult(t, result, err))
			if writes != 1 || len(dao.pending) != 0 {
				t.Fatalf("bound Bot read writes=%d, want 1; pending calls=%v", writes, dao.pending)
			}
		})
	}
}
