package sessionrelay

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
)

func TestDiscardBotSessionDropsOnlyItsLiveContentAndPendingReads(t *testing.T) {
	s := New(nil)
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
	s.discardBotSession(id)
	s.discardBotSession(id)
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

func TestOtherServiceDeletionRevokesExistingLiveCacheAndPendingContent(t *testing.T) {
	f, out, _, _ := connectBot(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	v := out.Session
	state := sp.State{InitialInputState: "not_required", Synchronized: true, Activity: "idle", Capabilities: sp.Capabilities{Send: true}}
	if _, err := f.s.Handle(ctx, sp.ControllerMessage{Type: "sync_state", ControllerFence: v.ControllerFence, State: &state, PendingInteractions: []sp.TimelineEntry{}}); err != nil {
		t.Fatal(err)
	}
	botFixture := f
	botFixture.project, botFixture.task = "", ""
	read := readPage(ctx, botFixture, v, "tail", "", 2)
	request := nextContent(t, botFixture, v)
	f.s.liveMutex.Lock()
	cached := f.s.live[v.SessionID] != nil
	f.s.liveMutex.Unlock()
	if !cached {
		t.Fatal("test did not retain the old service's live cache")
	}
	other := New(f.s.DB)
	deleted, err := other.DeleteBot(ctx, f.p, out.Bot.ID, service.DeleteBot{Version: out.Bot.Version, DeletionID: uuid.NewString()})
	if err != nil || deleted.Deletion == nil {
		t.Fatalf("other service deletion failed: %+v %v", deleted, err)
	}
	_, err = f.s.Handle(ctx, sp.ControllerMessage{Type: "content_response", ControllerFence: v.ControllerFence, RequestID: request["requestId"].(string), SourceThrough: "0", ContentResult: pageResult(v.HistoryEpoch, localEntry(t, "1"))})
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
		"snapshot":        func() error { _, err := f.s.TestSnapshot(ctx, f.p, v.SessionID); return err },
		"browser poll":    func() error { _, _, _, err := f.s.BrowserPoll(ctx, f.p, "", "", v.SessionID, ""); return err },
		"controller poll": func() error { _, err := f.s.Poll(ctx, v.ControllerFence); return err },
		"operation":       func() error { _, err := f.s.Operation(ctx, f.p, "", "", v.SessionID, uuid.NewString()); return err },
		"resource":        func() error { _, _, err := f.s.Resource(ctx, f.p, "", "", v.SessionID, uuid.NewString()); return err },
	} {
		t.Run(name, func(t *testing.T) { botFault(t, check(), "resource_conflict") })
	}
}

func TestMissingDurableSessionCannotRetainOldLiveCache(t *testing.T) {
	f, out, _, _ := connectBot(t)
	ctx := context.Background()
	id := out.Session.SessionID
	// Simulate completed SQL cleanup in a different Service, after its deletion
	// barrier has already made the original independent Session unreachable.
	markBotDeleted(t, f, out.Bot)
	if _, err := f.s.DB.Pool.Exec(ctx, `DELETE FROM task_sessions WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	_, err := f.s.TestSnapshot(ctx, f.p, id)
	botFault(t, err, "not_found")
	f.s.liveMutex.Lock()
	defer f.s.liveMutex.Unlock()
	if f.s.live[id] != nil {
		t.Fatal("missing durable Session retained its old live cache")
	}
}

func TestBotDeletionCompletedElsewhereInvalidatesControllerOnlyCache(t *testing.T) {
	for _, entry := range []string{"poll", "disconnect"} {
		t.Run(entry, func(t *testing.T) {
			f, out, _, _ := connectBot(t)
			ctx := context.Background()
			id := out.Session.SessionID
			pending := &pendingContent{fence: out.Session.ControllerFence, request: map[string]any{}, reply: make(chan contentReply, 1)}
			if _, err := f.s.content.add(pending); err != nil {
				t.Fatal(err)
			}
			files, err := local.New(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = files.Close() })
			other := New(f.s.DB)
			other.files = files
			request := service.DeleteBot{Version: out.Bot.Version, DeletionID: uuid.NewString()}
			if _, err = other.DeleteBot(ctx, f.p, out.Bot.ID, request); err != nil {
				t.Fatal(err)
			}
			receipt := botCleanupReceipt(out, request.DeletionID)
			receipt.Stop.StopProof.Kind = ""
			done, err := other.CompleteBotDeletion(ctx, f.p, out.Bot.WorkerID, out.Bot.ID, receipt)
			if err != nil || done.Deletion.ServerCleanup.State != "completed" {
				t.Fatalf("other instance cleanup: %+v %v", done, err)
			}
			f.s.liveMutex.Lock()
			cached := f.s.live[id] != nil && len(f.s.live[id].value.Events) > 0
			f.s.liveMutex.Unlock()
			if !cached {
				t.Fatal("fixture did not retain the old instance's conversation")
			}
			if entry == "poll" {
				_, err = f.s.Poll(ctx, out.Session.ControllerFence)
			} else {
				err = f.s.Disconnect(ctx, out.Session.ControllerFence)
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
