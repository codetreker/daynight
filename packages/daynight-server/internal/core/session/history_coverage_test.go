package session

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func historyCoverageTool(t *testing.T, text string, truncated bool) sp.TimelineEntry {
	t.Helper()
	entry, err := sp.DecodeTimeline(encode(map[string]any{"entryId": uuid.NewString(), "entrySeq": "1", "revision": "1", "kind": "tool_call", "callId": "call", "name": "read", "input": "", "output": []any{map[string]any{"type": "text", "text": text}}, "status": "completed", "truncated": truncated}))
	if err != nil {
		t.Fatal(err)
	}
	return entry
}

func TestLiveHistoryPreservesSourceCoverageAcrossWireAndBodyReferences(t *testing.T) {
	for _, scenario := range []string{"short_truncated", "large_truncated", "older_truncated", "resource_gap", "complete", "large_complete"} {
		t.Run(scenario, func(t *testing.T) {
			f, snapshot := connectFixture(t)
			syncContent(t, f, snapshot)
			prepareHistoryReads(f)
			f.s.live[snapshot.SessionID].value.ContentReadVersion = 1
			text := "short tool result"
			if strings.HasPrefix(scenario, "large_") {
				text = strings.Repeat("汉🙂", 50000)
			}
			entry := historyCoverageTool(t, text, strings.HasSuffix(scenario, "truncated"))
			entries := []sp.TimelineEntry{entry}
			if scenario == "older_truncated" {
				entries = append(entries, historyEntry(t, "2", "reasoning", "latest page"))
			}
			var resources []sp.Resource
			if scenario == "resource_gap" {
				resources = []sp.Resource{{ResourceID: uuid.NewString(), Status: "unavailable", Name: "missing output"}}
			}
			page, err := BuildHistoryPage(snapshot.SessionID, snapshot.HistoryEpoch, "live", snapshot.HistoryEpoch, entries, resources, "", 1, false, 1500, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			if strings.HasPrefix(scenario, "large_") && (page.Items[0].Body != nil || page.Items[0].ContentRef == nil) {
				t.Fatal("large entry fixture did not replace its body with a reference")
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
				result, err := f.s.ReadLivePage(phase, f.p, f.project, f.task, snapshot.SessionID, LiveHistoryRequest{Limit: 1, ContentReadVersion: 1, ResponseOverhead: 1500})
				f.dao.FinishContext(phase)
				done <- outcome{result, err}
			}()
			request := nextContent(t, f, snapshot)
			reply := sp.ContentResult{Kind: "inspect_page", HistoryEpoch: snapshot.HistoryEpoch, MessageItems: page.Items, Coverage: page.Coverage, BeforeCursor: page.BeforeCursor, HasMoreBefore: page.HasMoreBefore}
			replyContent(t, f, snapshot, request, &reply, nil)
			got := <-done
			if got.err != nil {
				t.Fatal(got.err)
			}
			want := sp.HistoryCoverage{State: "complete"}
			if strings.HasSuffix(scenario, "truncated") {
				want = sp.HistoryCoverage{State: "partial", Reason: observationPointer("entry_truncated")}
			} else if scenario == "resource_gap" {
				want = sp.HistoryCoverage{State: "partial", Reason: observationPointer("resource_unavailable")}
			}
			if string(encode(got.page.Coverage)) != string(encode(want)) {
				t.Fatalf("live read lost source coverage: got %s want %s", encode(got.page.Coverage), encode(want))
			}
			wire, _ := sp.MarshalWire(reply)
			public, _ := json.Marshal(got.page)
			if len(public)+1500 > len(wire)+request["responseOverhead"].(int) {
				t.Fatal("Controller response budget omitted the coverage envelope")
			}
		})
	}
}

func TestHistoryCoverageIncludesMissingResourceReferencesBeforePagingAndFiltering(t *testing.T) {
	for _, field := range []string{"content", "output"} {
		t.Run(field, func(t *testing.T) {
			missing := uuid.NewString()
			entry := historyCoverageTool(t, "original", false)
			if field == "content" {
				entry.Kind = "user_message"
				entry.Data = map[string]json.RawMessage{}
			}
			entry.Data[field] = encode([]any{map[string]any{"type": "resource", "resourceId": missing, "label": "file"}})
			if _, err := sp.DecodeTimeline(encode(entry)); err != nil {
				t.Fatal("resource entry fixture is invalid", err)
			}
			later := historyEntry(t, "2", "reasoning", "later")
			page, err := BuildHistoryPage(uuid.NewString(), "epoch", "live", "epoch", []sp.TimelineEntry{entry, later}, nil, "", 1, true, 0, time.Now())
			if err != nil || len(page.Items) != 0 || !page.HasMoreBefore || page.Coverage.State != "partial" || page.Coverage.Reason == nil || *page.Coverage.Reason != "resource_unavailable" {
				t.Fatalf("global missing resource lost after empty-page filter: %#v %v", page, err)
			}
		})
	}
}

func TestHistoryCoverageKeepsCompleteResourcesAndTruncationPrecedence(t *testing.T) {
	for _, scenario := range []string{"available", "missing", "pending", "failed", "unavailable", "unreferenced", "entry_precedes_resource"} {
		t.Run(scenario, func(t *testing.T) {
			id := uuid.NewString()
			entry := historyCoverageTool(t, "body", scenario == "entry_precedes_resource")
			entry.Data["output"] = encode([]any{map[string]any{"type": "resource", "resourceId": id, "label": "file"}})
			resources := []sp.Resource{{ResourceID: id, Status: "available"}}
			wantReason := "resource_unavailable"
			switch scenario {
			case "available":
				wantReason = ""
			case "missing":
				resources = nil
			case "unreferenced":
				resources = append(resources, sp.Resource{ResourceID: uuid.NewString(), Status: "unavailable"})
			case "entry_precedes_resource":
				resources[0].Status = "unavailable"
				wantReason = "entry_truncated"
			default:
				resources[0].Status = scenario
			}
			coverage := historyCoverage([]sp.TimelineEntry{entry}, resources)
			if wantReason == "" {
				if coverage.State != "complete" || coverage.Reason != nil {
					t.Fatal("complete source lost its coverage", coverage)
				}
			} else if coverage.State != "partial" || coverage.Reason == nil || *coverage.Reason != wantReason {
				t.Fatalf("coverage %#v want partial %s", coverage, wantReason)
			}
		})
	}
}
