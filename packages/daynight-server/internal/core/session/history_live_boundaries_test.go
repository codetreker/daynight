package session

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
)

func TestLiveHistoryControllerPageBoundariesAndLegacyBudget(t *testing.T) {
	for _, scenario := range []string{"before", "invalid_cursor", "changed_epoch", "over_limit", "over_budget", "legacy_before", "legacy_changed_epoch", "legacy_trim", "legacy_large_entry", "legacy_failure", "legacy_wrong_boundary"} {
		t.Run(scenario, func(t *testing.T) {
			f, snapshot := connectFixture(t)
			syncContent(t, f, snapshot)
			prepareHistoryReads(f)
			version := 1
			if strings.HasPrefix(scenario, "legacy_") {
				version = 0
			}
			f.s.live[snapshot.SessionID].value.ContentReadVersion = version
			in := LiveHistoryRequest{Epoch: snapshot.HistoryEpoch, Limit: 2, ContentReadVersion: version}
			position := HistoryPosition{Source: "live", SessionID: snapshot.SessionID, Epoch: snapshot.HistoryEpoch, Version: snapshot.HistoryEpoch, Sequence: "3"}
			entries := []sp.TimelineEntry{localEntry(t, "1")}
			wantError := ""
			switch scenario {
			case "before", "legacy_before", "legacy_wrong_boundary":
				in.Before = position.Cursor()
				if scenario == "legacy_wrong_boundary" {
					entries[0].EntrySeq = "3"
					wantError = "reset_required"
				}
			case "invalid_cursor", "changed_epoch", "legacy_changed_epoch":
				wantError = "reset_required"
			case "over_limit":
				in.Limit = 1
				entries = append(entries, localEntry(t, "2"))
				wantError = "reset_required"
			case "over_budget":
				in.ResponseOverhead = sp.MaxHistoryResponseBytes - 10000
				entries = []sp.TimelineEntry{historyEntry(t, "1", "reasoning", strings.Repeat("x", 20000))}
				wantError = "content_unavailable"
			case "legacy_trim", "legacy_large_entry":
				in.ResponseOverhead = 100000
				entries = []sp.TimelineEntry{historyEntry(t, "1", "reasoning", strings.Repeat("x", 200000))}
				if scenario == "legacy_trim" {
					entries = append(entries, localEntry(t, "2"))
				} else {
					wantError = "upgrade_required"
				}
			case "legacy_failure":
				wantError = "content_unavailable"
			}
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			phase := contentReadPhase(f, ctx, 2)
			type outcome struct {
				page sp.MessagePage
				err  error
			}
			done := make(chan outcome, 1)
			go func() {
				page, err := f.s.ReadLivePage(phase, f.p, f.project, f.task, snapshot.SessionID, in)
				f.dao.FinishContext(phase)
				done <- outcome{page, err}
			}()
			request := nextContent(t, f, snapshot)
			if in.Before != "" {
				if version == 1 {
					if request["cursor"] != in.Before {
						t.Fatal("full history cursor changed")
					}
				} else {
					raw, err := base64.RawURLEncoding.DecodeString(request["cursor"].(string))
					var cursor []string
					if err != nil || json.Unmarshal(raw, &cursor) != nil || len(cursor) != 3 || cursor[0] != snapshot.SessionID || cursor[1] != snapshot.HistoryEpoch || cursor[2] != "3" || request["direction"] != "before" {
						t.Fatalf("legacy cursor lost identity or position: %#v", request)
					}
				}
			}
			result := pageResult(snapshot.HistoryEpoch, entries...)
			if version == 1 {
				page, err := BuildHistoryPage(snapshot.SessionID, snapshot.HistoryEpoch, "live", snapshot.HistoryEpoch, entries, nil, "", len(entries), false, 0, time.Now())
				if err != nil {
					t.Fatal(err)
				}
				result = &sp.ContentResult{Kind: "inspect_page", HistoryEpoch: snapshot.HistoryEpoch, MessageItems: page.Items}
			}
			switch scenario {
			case "invalid_cursor":
				result.BeforeCursor = observationPointer("invalid")
				result.HasMoreBefore = true
			case "changed_epoch", "legacy_changed_epoch":
				result.HistoryEpoch = uuid.NewString()
			case "legacy_before":
				result.HasMoreBefore = true
			}
			if scenario == "legacy_failure" {
				replyContent(t, f, snapshot, request, nil, &sp.OperationError{Code: "content_unavailable", Message: "local source failed"})
			} else {
				replyContent(t, f, snapshot, request, result, nil)
			}
			got := <-done
			if wantError != "" {
				botFault(t, got.err, wantError)
				return
			}
			if got.err != nil || len(got.page.Items) != 1 || got.page.Items[0].Truncated {
				t.Fatalf("page %#v %v", got.page, got.err)
			}
			if scenario == "legacy_trim" || scenario == "legacy_before" {
				if !got.page.HasMoreBefore || got.page.BeforeCursor == nil {
					t.Fatal("legacy budget dropped its continuation")
				}
				position, err := ParseHistoryPosition(*got.page.BeforeCursor, false)
				if err != nil || position.Sequence != got.page.Items[0].EntrySeq || !position.Matches(snapshot.SessionID, snapshot.HistoryEpoch, "live", snapshot.HistoryEpoch) {
					t.Fatal("legacy continuation skipped selected boundary")
				}
			}
		})
	}
}

func TestLiveHistoryEntryRejectsMixedIdentityAndInvalidContinuation(t *testing.T) {
	for _, scenario := range []string{"complete", "changed_epoch", "changed_revision", "malformed_next", "wrong_next"} {
		t.Run(scenario, func(t *testing.T) {
			f, snapshot := connectFixture(t)
			syncContent(t, f, snapshot)
			prepareHistoryReads(f)
			f.s.live[snapshot.SessionID].value.ContentReadVersion = 1
			text := strings.Repeat("汉🙂", 10000)
			if scenario == "complete" {
				text = "complete entry"
			}
			entry := historyEntry(t, "1", "reasoning", text)
			body, err := canonicalHistoryJSON(entry)
			if err != nil {
				t.Fatal(err)
			}
			position := HistoryPosition{Source: "live", SessionID: snapshot.SessionID, Epoch: snapshot.HistoryEpoch, Version: snapshot.HistoryEpoch, EntryID: entry.EntryID, Revision: entry.Revision, SHA256: v2.HashBytes(body), ByteLength: strconv.Itoa(len(body)), Offset: "0", Chunk: true}
			token := position.Cursor()
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			phase := contentReadPhase(f, ctx, 2)
			type outcome struct {
				chunk sp.EntryChunk
				err   error
			}
			done := make(chan outcome, 1)
			go func() {
				chunk, err := f.s.ReadLiveEntry(phase, f.p, f.project, f.task, snapshot.SessionID, snapshot.HistoryEpoch, token)
				f.dao.FinishContext(phase)
				done <- outcome{chunk, err}
			}()
			request := nextContent(t, f, snapshot)
			chunk, err := BuildEntryChunk(snapshot.SessionID, snapshot.HistoryEpoch, "live", snapshot.HistoryEpoch, []sp.TimelineEntry{entry}, token, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			result := &sp.ContentResult{Kind: "entry_chunk", HistoryEpoch: snapshot.HistoryEpoch, EntryID: chunk.EntryID, Revision: chunk.Revision, SHA256: chunk.SHA256, ByteLength: chunk.ByteLength, Offset: chunk.Offset, Fragment: chunk.Fragment, NextCursor: chunk.NextCursor, EOF: chunk.EOF}
			wantError := ""
			switch scenario {
			case "changed_epoch":
				result.HistoryEpoch = uuid.NewString()
				wantError = "reset_required"
			case "changed_revision":
				result.Revision = "2"
				wantError = "content_changed"
			case "malformed_next":
				result.NextCursor = observationPointer("invalid")
				wantError = "reset_required"
			case "wrong_next":
				position.Offset = "1"
				result.NextCursor = observationPointer(position.Cursor())
				wantError = "content_unavailable"
			}
			replyContent(t, f, snapshot, request, result, nil)
			got := <-done
			if wantError != "" {
				botFault(t, got.err, wantError)
			} else if got.err != nil || !got.chunk.EOF || got.chunk.NextCursor != nil || got.chunk.Fragment != string(body) {
				t.Fatalf("complete chunk %#v %v", got.chunk, got.err)
			}
		})
	}
}
