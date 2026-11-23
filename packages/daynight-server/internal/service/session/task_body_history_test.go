package session

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

func TestTaskBodyArchiveReadCarriesPolicyOutsideLegacyJSON(t *testing.T) {
	raw, timeline, position := historySchema3Fixture(t)
	manifest, err := sp.DecodeArchiveManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	manifest.ContentPolicy = "task_body"
	entry, err := sp.DecodeTimeline([]byte(`{"entryId":"` + historyTestEntry + `","entrySeq":"3","revision":"1","kind":"assistant_message","content":[{"type":"text","text":"body"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	timeline, err = sp.MarshalWire(sp.ArchiveTimeline{Entries: []sp.TimelineEntry{entry}})
	if err != nil {
		t.Fatal(err)
	}
	manifest.Timeline.SHA256, manifest.Timeline.ByteLength = v2.HashBytes(timeline), strconv.Itoa(len(timeline))
	entryBytes, err := v2.CanonicalJSON(entry)
	if err != nil {
		t.Fatal(err)
	}
	position.SHA256, position.ByteLength = v2.HashBytes(entryBytes), strconv.Itoa(len(entryBytes))
	raw, err = sp.MarshalWire(manifest)
	if err != nil {
		t.Fatal(err)
	}
	position.Epoch, position.Version = v2.HashBytes(raw), v2.HashBytes(raw)
	lease := &retainedHistoryFixture{data: raw, timeline: timeline}
	s := NewHistory(historyReadInspector(func(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error) {
		return sp.TaskSessionInspection{SessionID: historyTestSession, Source: "archive"}, nil
	}), historyReadBackend{archive: func(context.Context, model.Principal, string, string, string) (core.HistoryArchive, error) {
		return lease, nil
	}})
	page, err := s.Read(t.Context(), model.Principal{}, "p", "t", historyTestSession, ReadRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if page.Data.ContentPolicy != "task_body" || page.Data.Coverage.State != "complete" {
		t.Fatalf("%+v", page.Data)
	}
	bytes, _ := json.Marshal(page.Data)
	if strings.Contains(string(bytes), "contentPolicy") {
		t.Fatal("legacy page shape changed")
	}
	if err = page.Close(); err != nil {
		t.Fatal(err)
	}
	cursor := position.Cursor()
	chunk, err := s.Entry(t.Context(), model.Principal{}, "p", "t", historyTestSession, EntryRequest{Cursor: cursor})
	if err != nil {
		t.Fatal(err)
	}
	if chunk.Data.ContentPolicy != "task_body" {
		t.Fatalf("%+v", chunk.Data)
	}
	if err = chunk.Close(); err != nil {
		t.Fatal(err)
	}
}
