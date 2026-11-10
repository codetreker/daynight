package session

import (
	"encoding/json"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/google/uuid"
	"os"
	"strings"
	"testing"
	"time"
)

func historyEntry(t *testing.T, seq, kind, text string) sp.TimelineEntry {
	t.Helper()
	v, err := sp.DecodeTimeline(encode(map[string]any{"entryId": uuid.NewString(), "entrySeq": seq, "revision": "1", "kind": kind, "text": text}))
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func TestHistoryProjectionPaginatesAndChunksRawUnicode(t *testing.T) {
	id, epoch := uuid.NewString(), uuid.NewString()
	now := time.Now()
	entries := []sp.TimelineEntry{historyEntry(t, "1", "reasoning", "first"), historyEntry(t, "2", "reasoning", strings.Repeat("汉🙂", 50000)), historyEntry(t, "3", "reasoning", "last")}
	page, err := BuildHistoryPage(id, epoch, "live", epoch, entries, nil, "", 2, false, 2000, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || !page.HasMoreBefore || page.BeforeCursor == nil || !page.Items[0].Truncated || page.Items[0].ContentRef == nil {
		t.Fatalf("page %#v", page)
	}
	raw, _ := json.Marshal(page)
	if len(raw)+2000 > sp.MaxHistoryResponseBytes {
		t.Fatal("response exceeded budget")
	}
	earlier, err := BuildHistoryPage(id, epoch, "live", epoch, entries, nil, *page.BeforeCursor, 2, true, 2000, now)
	if err != nil || len(earlier.Items) != 0 || earlier.HasMoreBefore {
		t.Fatalf("filtered page %#v %v", earlier, err)
	}
	cursor := page.Items[0].ContentRef.Cursor
	var whole strings.Builder
	for cursor != "" {
		chunk, e := BuildEntryChunk(id, epoch, "live", epoch, entries, cursor, now)
		if e != nil {
			t.Fatal(e)
		}
		if len([]byte(chunk.Fragment)) > sp.MaxEntryChunkBytes {
			t.Fatal("large chunk")
		}
		whole.WriteString(chunk.Fragment)
		cursor = ""
		if chunk.NextCursor != nil {
			cursor = *chunk.NextCursor
		}
	}
	if !json.Valid([]byte(whole.String())) || !strings.Contains(whole.String(), "汉🙂") {
		t.Fatal("lost raw body")
	}
	entries[1].Revision = "2"
	if _, err = BuildEntryChunk(id, epoch, "live", epoch, entries, page.Items[0].ContentRef.Cursor, now); err == nil {
		t.Fatal("mixed revision")
	}
	if _, err = BuildHistoryPage(id, epoch, "archive", "changed", entries, nil, *page.BeforeCursor, 2, false, 2000, now); err == nil {
		t.Fatal("mixed sources")
	}
}

func TestHistoryCanonicalSharedFixture(t *testing.T) {
	raw, err := os.ReadFile("../../../../daynight/test/session/fixtures/history-canonical.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Entry     json.RawMessage `json:"entry"`
		Canonical string          `json:"canonical"`
		SHA256    string          `json:"sha256"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	entry, err := sp.DecodeTimeline(fixture.Entry)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := canonicalHistoryJSON(entry)
	if err != nil {
		t.Fatal(err)
	}
	if string(canonical) != fixture.Canonical || v2.HashBytes(canonical) != fixture.SHA256 {
		t.Fatalf("cross-language canonical mismatch\n%s\n%s", canonical, fixture.Canonical)
	}
}
