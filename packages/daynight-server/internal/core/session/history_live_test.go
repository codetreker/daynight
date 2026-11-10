package session

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func prepareHistoryReads(f fixture) {
	f.s.SetTaskReadRunners(f.s.browserRun, f.s.taskRun, f.s.archiveRun)
}
func TestLiveHistoryNegotiatesRequestsAndKeepsSourceBarrier(t *testing.T) {
	for _, version := range []int{0, 1} {
		t.Run(map[int]string{0: "legacy", 1: "version1"}[version], func(t *testing.T) {
			f, v := connectFixture(t)
			syncContent(t, f, v)
			prepareHistoryReads(f)
			f.s.live[v.SessionID].value.ContentReadVersion = version
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			phase := contentReadPhase(f, ctx, 2)
			type answer struct {
				page sp.MessagePage
				err  error
			}
			done := make(chan answer, 1)
			go func() {
				page, err := f.s.ReadLivePage(phase, f.p, f.project, f.task, v.SessionID, LiveHistoryRequest{Limit: 2, ContentReadVersion: version, ResponseOverhead: 1500})
				f.dao.FinishContext(phase)
				done <- answer{page, err}
			}()
			request := nextContent(t, f, v)
			entry := localEntry(t, "2")
			if version == 0 {
				if request["kind"] != "timeline" {
					t.Fatal(request)
				}
				replyContent(t, f, v, request, pageResult(v.HistoryEpoch, entry), nil)
			} else {
				if request["kind"] != "inspect_page" || request["historyEpoch"] != v.HistoryEpoch {
					t.Fatal(request)
				}
				page, err := BuildHistoryPage(v.SessionID, v.HistoryEpoch, "live", v.HistoryEpoch, []sp.TimelineEntry{entry}, nil, "", 2, false, 1500, time.Now())
				if err != nil {
					t.Fatal(err)
				}
				replyContent(t, f, v, request, &sp.ContentResult{Kind: "inspect_page", HistoryEpoch: v.HistoryEpoch, MessageItems: page.Items, BeforeCursor: page.BeforeCursor, HasMoreBefore: page.HasMoreBefore, Coverage: page.Coverage}, nil)
			}
			got := <-done
			if got.err != nil || len(got.page.Items) != 1 || got.page.Items[0].EntryID != entry.EntryID || got.page.Source != "live" {
				t.Fatalf("read %#v %v", got.page, got.err)
			}
		})
	}
}
func TestLiveHistoryNeverSendsNewKindsToUndeclaredConnection(t *testing.T) {
	f, v := connectFixture(t)
	syncContent(t, f, v)
	prepareHistoryReads(f)
	phase := contentReadPhase(f, t.Context(), 1)
	_, err := f.s.ReadLivePage(phase, f.p, f.project, f.task, v.SessionID, LiveHistoryRequest{Limit: 20, ContentReadVersion: 1})
	f.dao.FinishContext(phase)
	var value *model.Fault
	if !errors.As(err, &value) || value.Code != "upgrade_required" {
		t.Fatal(err)
	}
	if len(f.s.content.pending) != 0 {
		t.Fatal("new request queued for legacy connection")
	}
	f.s.live[v.SessionID].value.ContentReadVersion = 1
	next := reconnect(t, f, v)
	if next.ConnectionEpoch == v.ConnectionEpoch || f.s.live[v.SessionID].value.ContentReadVersion != 0 {
		t.Fatal("reconnect retained content capability")
	}
}
func TestLegacyHistoryRejectsDisplayPlaceholder(t *testing.T) {
	f, v := connectFixture(t)
	syncContent(t, f, v)
	prepareHistoryReads(f)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	phase := contentReadPhase(f, ctx, 2)
	done := make(chan error, 1)
	go func() {
		_, err := f.s.ReadLivePage(phase, f.p, f.project, f.task, v.SessionID, LiveHistoryRequest{Limit: 1})
		f.dao.FinishContext(phase)
		done <- err
	}()
	request := nextContent(t, f, v)
	entry := localEntry(t, "1")
	entry.Kind = "error"
	entry.Data = map[string]json.RawMessage{"code": json.RawMessage(`"display_budget_exceeded"`), "message": json.RawMessage(`"display only"`)}
	replyContent(t, f, v, request, pageResult(v.HistoryEpoch, entry), nil)
	var fault *model.Fault
	if err := <-done; !errors.As(err, &fault) || fault.Code != "upgrade_required" {
		t.Fatal(err)
	}
}

func TestLiveEntryChunkPreservesIdentityAndRejectsChangedContent(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(map[bool]string{false: "chunk", true: "revision_changed"}[changed], func(t *testing.T) {
			f, v := connectFixture(t)
			syncContent(t, f, v)
			prepareHistoryReads(f)
			f.s.live[v.SessionID].value.ContentReadVersion = 1
			entry := historyEntry(t, "1", "reasoning", strings.Repeat("汉🙂", 50000))
			page, err := BuildHistoryPage(v.SessionID, v.HistoryEpoch, "live", v.HistoryEpoch, []sp.TimelineEntry{entry}, nil, "", 1, false, 1024, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			token := page.Items[0].ContentRef.Cursor
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			phase := contentReadPhase(f, ctx, 2)
			type answer struct {
				chunk sp.EntryChunk
				err   error
			}
			done := make(chan answer, 1)
			go func() {
				chunk, err := f.s.ReadLiveEntry(phase, f.p, f.project, f.task, v.SessionID, v.HistoryEpoch, token)
				f.dao.FinishContext(phase)
				done <- answer{chunk, err}
			}()
			request := nextContent(t, f, v)
			if request["kind"] != "entry_chunk" || request["cursor"] != token || request["limit"] != sp.MaxEntryChunkBytes {
				t.Fatal(request)
			}
			if changed {
				replyContent(t, f, v, request, nil, &sp.OperationError{Code: "content_changed", Message: "revision changed"})
			} else {
				chunk, e := BuildEntryChunk(v.SessionID, v.HistoryEpoch, "live", v.HistoryEpoch, []sp.TimelineEntry{entry}, token, time.Now())
				if e != nil {
					t.Fatal(e)
				}
				replyContent(t, f, v, request, &sp.ContentResult{Kind: "entry_chunk", HistoryEpoch: v.HistoryEpoch, EntryID: chunk.EntryID, Revision: chunk.Revision, SHA256: chunk.SHA256, ByteLength: chunk.ByteLength, Offset: chunk.Offset, Fragment: chunk.Fragment, NextCursor: chunk.NextCursor, EOF: chunk.EOF}, nil)
			}
			received := <-done
			if changed {
				var fault *model.Fault
				if !errors.As(received.err, &fault) || fault.Code != "content_changed" {
					t.Fatal(received.err)
				}
			} else if received.err != nil || received.chunk.EntryID != entry.EntryID || len(received.chunk.Fragment) > sp.MaxEntryChunkBytes || received.chunk.NextCursor == nil || received.chunk.EOF {
				t.Fatalf("chunk %#v %v", received.chunk, received.err)
			}
		})
	}
}
func TestLiveHistoryRechecksAuthorizationAfterNetworkWait(t *testing.T) {
	f, v := connectFixture(t)
	syncContent(t, f, v)
	prepareHistoryReads(f)
	f.s.live[v.SessionID].value.ContentReadVersion = 1
	type readerKey struct{}
	ctx, cancel := context.WithTimeout(context.WithValue(t.Context(), readerKey{}, true), 5*time.Second)
	defer cancel()
	phase := f.dao.ContextPhase(ctx, map[string]int{"LockTask": 2, "LockCredential": 2, "ProjectAccess": 1, "SessionBotID": 1, "LockSession": 1})
	original := f.dao.LockCredentialFn
	calls := 0
	f.dao.LockCredentialFn = func(c context.Context, p model.Principal, now time.Time) error {
		if c.Value(readerKey{}) == true {
			calls++
			if calls == 2 {
				return model.ErrNotFound
			}
		}
		return original(c, p, now)
	}
	done := make(chan error, 1)
	go func() {
		_, err := f.s.ReadLivePage(phase, f.p, f.project, f.task, v.SessionID, LiveHistoryRequest{Limit: 1, ContentReadVersion: 1})
		f.dao.FinishContext(phase)
		done <- err
	}()
	request := nextContent(t, f, v)
	replyContent(t, f, v, request, &sp.ContentResult{Kind: "inspect_page", HistoryEpoch: v.HistoryEpoch, MessageItems: []sp.MessageItem{}, Coverage: sp.HistoryCoverage{State: "complete"}}, nil)
	var fault *model.Fault
	if err := <-done; !errors.As(err, &fault) || fault.Code != "unauthenticated" {
		t.Fatal("revoked actor received page", err)
	}
}

func TestLiveHistoryEpochChangePrecedesCapabilityFallback(t *testing.T) {
	f, v := connectFixture(t)
	syncContent(t, f, v)
	prepareHistoryReads(f)
	phase := contentReadPhase(f, t.Context(), 1)
	_, err := f.s.ReadLivePage(phase, f.p, f.project, f.task, v.SessionID, LiveHistoryRequest{Epoch: "11111111-1111-4111-8111-111111111111", Limit: 1, ContentReadVersion: 1})
	f.dao.FinishContext(phase)
	var failure *model.Fault
	if !errors.As(err, &failure) || failure.Code != "reset_required" {
		t.Fatal("stale epoch lost reset semantics", err)
	}
}
