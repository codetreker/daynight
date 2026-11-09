package session

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestCheckBotRequiresMatchingBindingAndDiscardsDeletedState(t *testing.T) {
	engine := NewEngine(nil)
	id, other := uuid.NewString(), uuid.NewString()
	engine.live[id] = &liveCell{value: newLive(sp.Snapshot{})}
	pending := &pendingContent{fence: sp.ControllerFence{Fence: sp.Fence{SessionID: id}}, request: map[string]any{}, reply: make(chan contentReply, 1)}
	if _, err := engine.content.add(pending); err != nil {
		t.Fatal(err)
	}
	op, err := engine.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	defer op.Close()
	if err = op.CheckBot(id, nil); err != nil {
		t.Fatal(err)
	}
	for _, bot := range []model.Bot{{}, {SessionID: &other}} {
		if err = op.CheckBot(id, &bot); err == nil {
			t.Fatal("mismatched Bot binding accepted")
		}
	}
	bot := model.Bot{SessionID: &id}
	if err = op.CheckBot(id, &bot); err != nil {
		t.Fatal(err)
	}
	bot.Deletion = &model.BotDeletion{}
	err = op.CheckBot(id, &bot)
	botFault(t, err, "resource_conflict")
	if engine.live[id] != nil {
		t.Fatal("deleted Bot retained live cell")
	}
	select {
	case reply := <-pending.reply:
		botFault(t, reply.err, "resource_conflict")
		if reply.result != nil {
			t.Fatal("deleted Bot exposed pending content")
		}
	default:
		t.Fatal("deleted Bot did not cancel pending content")
	}
}

type operationLoadDAO struct {
	store.SessionDAO
	lockSession func(context.Context, string) (store.SessionRecord, error)
}

func (dao operationLoadDAO) LockSession(ctx context.Context, id string) (store.SessionRecord, error) {
	if dao.lockSession == nil {
		panic("unexpected LockSession call")
	}
	return dao.lockSession(ctx, id)
}

type operationLoadScope struct{ dao store.SessionDAO }

func (scope operationLoadScope) SessionDAO() store.SessionDAO { return scope.dao }
func (operationLoadScope) BotDAO() store.BotWriteDAO {
	return struct{ store.BotWriteDAO }{}
}

type operationLoadFixture struct {
	engine    *Engine
	stored    store.SessionRecord
	bot       model.Bot
	pending   *pendingContent
	requestID string
}

func newOperationLoadFixture(t *testing.T) operationLoadFixture {
	t.Helper()
	const id = "00000000-0000-4000-8000-000000000001"
	const botID = "00000000-0000-4000-8000-000000000002"
	const owner = "00000000-0000-4000-8000-000000000003"
	execution := "00000000-0000-4000-8000-000000000004"
	const worker = "00000000-0000-4000-8000-000000000005"
	native := "native"
	now := time.Date(2026, time.November, 6, 0, 0, 0, 0, time.UTC)
	expiry := now.Add(time.Minute)
	engine := NewEngine(nil)
	engine.now = func() time.Time { return now }
	snapshot := sp.Snapshot{
		ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, TestExecutionID: execution, ExecutionGeneration: "1"}, ConnectionEpoch: "1"},
		Protocol:        sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1,
		Identity:        sp.Identity{OwnerUserID: owner, ControllerID: "00000000-0000-4000-8000-000000000008", ControllerInstanceID: "00000000-0000-4000-8000-000000000009", AgentControlMode: "web", Provider: "codex", NativeSessionID: &native},
		SessionRevision: "1", HistoryEpoch: "00000000-0000-4000-8000-000000000006", LastEventSeq: "0", LastTimelineSeq: "0",
		InitialInputState: "not_required", Lifecycle: "active", ConnectionState: "connected", Synchronized: true, Activity: "idle",
	}
	bot := model.Bot{ID: botID, OwnerUserID: owner, WorkerID: worker, Name: "Assistant", Version: 2, CreationOrder: 1,
		ResolvedConfiguration: model.BotConfiguration{WorkerID: worker, Cwd: "/workspace", Provider: "codex", Args: []string{}}, SessionID: &snapshot.SessionID, TestExecutionID: &execution}
	stored := store.SessionRecord{BotID: &bot.ID, Snapshot: durableSnapshot(snapshot), Owner: owner,
		Parent: "00000000-0000-4000-8000-000000000007", ConnectionParent: "00000000-0000-4000-8000-000000000007", ServerInstance: &engine.instance,
		LastSeen: &now, ConnectionExpiry: &expiry, Consumed: true}
	live := newLive(snapshot)
	live.LastSeen, live.Synced = &now, true
	engine.live[id] = &liveCell{value: live}
	pending := &pendingContent{fence: snapshot.ControllerFence, request: map[string]any{}, reply: make(chan contentReply, 1)}
	requestID, err := engine.content.add(pending)
	if err != nil {
		t.Fatal(err)
	}
	return operationLoadFixture{engine: engine, stored: stored, bot: bot, pending: pending, requestID: requestID}
}

func TestOperationLoadDiscardsMissingSessionAndRejectsMismatchedBot(t *testing.T) {
	lookupFailure := errors.New("session lookup unavailable")
	for _, test := range []struct {
		name      string
		boundBot  bool
		lookupErr error
		cause     error
		code      string
		missing   bool
	}{
		{name: "matching binding", boundBot: true},
		{name: "binding mismatch", code: "session_conflict"},
		{name: "missing session", boundBot: true, lookupErr: model.ErrNotFound, cause: model.ErrNotFound, missing: true},
		{name: "wrapped missing session", boundBot: true, lookupErr: fmt.Errorf("load Session: %w", model.ErrNotFound), cause: model.ErrNotFound, missing: true},
		{name: "operational failure", boundBot: true, lookupErr: fmt.Errorf("load Session: %w", lookupFailure), cause: lookupFailure},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newOperationLoadFixture(t)
			ctx := t.Context()
			id := fixture.stored.Snapshot.SessionID
			calls := 0
			dao := operationLoadDAO{lockSession: func(actual context.Context, actualID string) (store.SessionRecord, error) {
				calls++
				if actual != ctx || actualID != id {
					t.Fatalf("Session lookup changed context or identity: %q", actualID)
				}
				if test.lookupErr != nil {
					return store.SessionRecord{}, test.lookupErr
				}
				return fixture.stored, nil
			}}
			op, err := fixture.engine.BeginOperation()
			if err != nil {
				t.Fatal(err)
			}
			defer op.Close()
			var bot *model.Bot
			if test.boundBot {
				bot = &fixture.bot
			}
			access, err := op.Load(ctx, operationLoadScope{dao: dao}, id, bot)
			if calls != 1 {
				t.Fatalf("Session lookup calls=%d, expected 1", calls)
			}
			if test.lookupErr != nil {
				var refusal *model.Fault
				if access != nil || !errors.Is(err, test.lookupErr) || !errors.Is(err, test.cause) || errors.As(err, &refusal) || errors.Is(err, model.ErrNotFound) != test.missing {
					t.Fatalf("Session lookup lost its original operational cause: %v", err)
				}
			} else if test.code != "" {
				botFault(t, err, test.code)
				if access != nil {
					t.Fatal("mismatched Bot received Session access")
				}
			} else if err != nil || access == nil || access.record.Live == nil || access.record.BotID == nil || *access.record.BotID != fixture.bot.ID || access.Authority().OwnerID != fixture.bot.OwnerUserID || access.record.Snapshot.ControllerFence != fixture.stored.Snapshot.ControllerFence || access.record.Snapshot.Activity != "idle" {
				t.Fatalf("matching Bot did not load its stored and live Session: %+v %v", access, err)
			}
			op.Close()
			fixture.engine.liveMutex.Lock()
			cached := fixture.engine.live[id]
			fixture.engine.liveMutex.Unlock()
			if test.missing {
				if cached != nil {
					t.Fatal("missing Session retained its live cell")
				}
				select {
				case reply := <-fixture.pending.reply:
					botFault(t, reply.err, "resource_conflict")
					if reply.result != nil {
						t.Fatal("missing Session exposed content")
					}
				default:
					t.Fatal("missing Session did not cancel pending content")
				}
			} else {
				if cached == nil || cached.value.Snapshot.Activity != "idle" {
					t.Fatal("valid live Session was discarded or changed")
				}
				select {
				case <-fixture.pending.reply:
					t.Fatal("valid live Session canceled pending content")
				default:
				}
			}
			fixture.engine.content.mu.Lock()
			registered := fixture.engine.content.pending[fixture.requestID] == fixture.pending
			fixture.engine.content.mu.Unlock()
			if registered == test.missing {
				t.Fatalf("pending content registration=%t after missing=%t", registered, test.missing)
			}
		})
	}
}

func TestStopBeforeFirstOperationIsIdempotent(t *testing.T) {
	engine := NewEngine(nil)
	if err := engine.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := engine.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.BeginOperation(); err == nil {
		t.Fatal("stopped engine accepted new work")
	}
}
