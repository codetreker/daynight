package session

import (
	"context"
	"errors"
	"testing"

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

func TestOperationLoadDiscardsMissingSessionAndRejectsMismatchedBot(t *testing.T) {
	f, out, _, _ := connectBot(t)
	ctx := context.Background()
	id := out.Session.SessionID
	op, err := f.s.Engine.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.db.WriteSession(ctx, func(scope store.SessionScope) error { _, err := op.Load(ctx, scope, id, nil); return err })
	op.Close()
	botFault(t, err, "session_conflict")
	f.s.liveMutex.Lock()
	cached := f.s.live[id] != nil
	f.s.liveMutex.Unlock()
	if !cached {
		t.Fatal("binding mismatch discarded a valid live Session")
	}
	pending := &pendingContent{fence: sp.ControllerFence{Fence: sp.Fence{SessionID: id}}, request: map[string]any{}, reply: make(chan contentReply, 1)}
	if _, err = f.s.content.add(pending); err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Pool.Exec(ctx, `DELETE FROM task_sessions WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	op, err = f.s.Engine.BeginOperation()
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.db.WriteSession(ctx, func(scope store.SessionScope) error { _, err := op.Load(ctx, scope, id, &out.Bot); return err })
	op.Close()
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing Session: %v", err)
	}
	f.s.liveMutex.Lock()
	cached = f.s.live[id] != nil
	f.s.liveMutex.Unlock()
	if cached {
		t.Fatal("missing Session retained its live cell")
	}
	select {
	case reply := <-pending.reply:
		botFault(t, reply.err, "resource_conflict")
		if reply.result != nil {
			t.Fatal("missing Session exposed content")
		}
	default:
		t.Fatal("missing Session did not cancel pending content")
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
