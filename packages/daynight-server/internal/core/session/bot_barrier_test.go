package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestDiscardBotSessionDropsOnlyItsLiveContentAndPendingReads(t *testing.T) {
	s := NewEngine(nil)
	id, other := uuid.NewString(), uuid.NewString()
	s.live[id] = &liveCell{value: newLive(sp.Snapshot{})}
	s.live[other] = &liveCell{value: newLive(sp.Snapshot{})}
	pending := &pendingContent{fence: sp.ControllerFence{Fence: sp.Fence{SessionID: id}}, request: map[string]any{}, reply: make(chan contentReply, 1)}
	otherPending := &pendingContent{fence: sp.ControllerFence{Fence: sp.Fence{SessionID: other}}, request: map[string]any{}, reply: make(chan contentReply, 1)}
	if _, err := s.content.add(pending); err != nil {
		t.Fatal(err)
	}
	if _, err := s.content.add(otherPending); err != nil {
		t.Fatal(err)
	}
	s.DiscardBotSession(id)
	s.DiscardBotSession(id)
	if s.live[id] != nil || s.live[other] == nil || len(s.content.pending) != 1 {
		t.Fatal("discard did not preserve the unrelated session")
	}
	select {
	case reply := <-pending.reply:
		botFault(t, reply.err, "resource_conflict")
		if reply.result != nil {
			t.Fatal("deleted session returned content")
		}
	default:
		t.Fatal("deleted session left its reader waiting")
	}
	select {
	case <-otherPending.reply:
		t.Fatal("discard interrupted an unrelated reader")
	default:
	}
}

func TestObservedBotDeletionRevokesExistingLiveCacheAndPendingContent(t *testing.T) {
	f, out, _, _ := connectedBotFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	v := out.Session
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	if _, err := f.s.Handle(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 2, "UnreconciledSessionOperationCount": 1, "TouchSession": 1, "SaveSession": 1, "Bot": 1}), sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	f.SelectSessionWrite(t)
	botFixture := f
	botFixture.project, botFixture.task = "", ""
	read := readPage(botPhase(t, f, ctx, map[string]int{"SessionBotID": 2, "LockSession": 1, "LockCredential": 2, "Bot": 2}), botFixture, v, "tail", "", 2)
	request := nextContent(t, botFixture, v)
	f.s.liveMutex.Lock()
	cached := f.s.live[v.SessionID] != nil
	f.s.liveMutex.Unlock()
	if !cached {
		t.Fatal("test did not retain the old service's live cache")
	}
	markBotDeleted(t, f, out.Bot)
	var err error
	_, err = f.s.Handle(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "Bot": 1}), sp.ControllerMessage{Type: "content_response", ControllerFence: v.ControllerFence, RequestID: request["requestId"].(string), SourceThrough: "0", ContentResult: pageResult(v.HistoryEpoch, localEntry(t, "1"))})
	botFault(t, err, "resource_conflict")
	got := <-read
	botFault(t, got.err, "resource_conflict")
	if got.page != nil {
		t.Fatal("deleted bot exposed a late page")
	}
	f.s.liveMutex.Lock()
	cached = f.s.live[v.SessionID] != nil
	f.s.liveMutex.Unlock()
	if cached {
		t.Fatal("observing deletion retained the old live cache")
	}
	for name, check := range map[string]func() error{
		"snapshot": func() error {
			_, err := f.s.TestSnapshot(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, v.SessionID)
			return err
		},
		"browser poll": func() error {
			_, _, _, err := f.s.BrowserPoll(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, "", "", v.SessionID, "")
			return err
		},
		"controller poll": func() error {
			_, err := f.s.Poll(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "Bot": 1}), v.ControllerFence)
			return err
		},
		"operation": func() error {
			_, err := f.s.Operation(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, "", "", v.SessionID, uuid.NewString())
			return err
		},
		"resource": func() error {
			_, _, err := f.s.Resource(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1, "Bot": 1}), f.p, "", "", v.SessionID, uuid.NewString())
			return err
		},
	} {
		t.Run(name, func(t *testing.T) { botFault(t, check(), "resource_conflict") })
	}
}

func TestMissingDurableSessionCannotRetainOldLiveCache(t *testing.T) {
	f, out, _, _ := connectedBotFixture(t)
	ctx := context.Background()
	id := out.Session.SessionID
	markBotDeleted(t, f, out.Bot)
	missingBotSession(t, f, id)
	_, err := f.s.TestSnapshot(botPhase(t, f, ctx, map[string]int{"SessionBotID": 1}), f.p, id)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing Session lost its DAO cause: %v", err)
	}
	f.s.liveMutex.Lock()
	defer f.s.liveMutex.Unlock()
	if f.s.live[id] != nil {
		t.Fatal("missing durable Session retained its old live cache")
	}
}

func TestBotDeletionCompletedElsewhereInvalidatesControllerOnlyCache(t *testing.T) {
	for _, entry := range []string{"poll", "disconnect"} {
		t.Run(entry, func(t *testing.T) {
			f, out, _, _ := connectedBotFixture(t)
			ctx := context.Background()
			id := out.Session.SessionID
			state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle"}
			if _, err := f.s.Handle(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1, "SessionBotID": 1, "LockSession": 1, "LockCredential": 2, "UnreconciledSessionOperationCount": 1, "TouchSession": 1, "SaveSession": 1, "Bot": 1}), sp.ControllerMessage{Type: "sync_state", ControllerFence: out.Session.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
				t.Fatal(err)
			}
			f.SelectSessionWrite(t)
			pending := &pendingContent{fence: out.Session.ControllerFence, request: map[string]any{}, reply: make(chan contentReply, 1)}
			if _, err := f.s.content.add(pending); err != nil {
				t.Fatal(err)
			}
			markBotDeleted(t, f, out.Bot)
			missingBotSession(t, f, id)
			var err error
			f.s.liveMutex.Lock()
			cached := f.s.live[id] != nil && len(f.s.live[id].value.Events) > 0
			f.s.liveMutex.Unlock()
			if !cached {
				t.Fatal("fixture did not retain the old instance's conversation")
			}
			if entry == "poll" {
				_, err = f.s.Poll(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1}), out.Session.ControllerFence)
			} else {
				err = f.s.Disconnect(botPhase(t, f, ctx, map[string]int{"SessionLocation": 1}), out.Session.ControllerFence)
			}
			if err == nil {
				t.Fatal("removed Session accepted a Controller request")
			}
			f.s.liveMutex.Lock()
			cached = f.s.live[id] != nil
			f.s.liveMutex.Unlock()
			if cached {
				t.Fatal("Controller-only observation retained deleted conversation content")
			}
			select {
			case reply := <-pending.reply:
				botFault(t, reply.err, "resource_conflict")
				if reply.result != nil {
					t.Fatal("deleted Session returned pending content")
				}
			default:
				t.Fatal("Controller-only observation retained pending content")
			}
		})
	}
}
