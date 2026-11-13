package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestContentTimelineCostMatchesWire(t *testing.T) {
	entries := []sp.TimelineEntry{
		{EntryID: "one", EntrySeq: "1", Revision: "1", Kind: "message", Data: map[string]json.RawMessage{"text": json.RawMessage(`"<中文>\n\"😀"`)}},
		{EntryID: "two", EntrySeq: "2", Revision: "2", Kind: "message", Data: map[string]json.RawMessage{"text": json.RawMessage(`"withdrawn"`)}},
	}
	ledger := archiveLedger{HistoryID: "saved", Entries: []archiveLedgerEntry{}, Occurrences: []archiveLedgerOccurrence{}}
	for _, entry := range entries {
		wire, err := sp.MarshalWire(entry)
		if err != nil {
			t.Fatal(err)
		}
		ledger.Entries = append(ledger.Entries, archiveLedgerEntry{ByteLength: len(wire)})
	}
	allEntries := ledger.Entries
	for _, n := range []int{0, 1, 2} {
		ledger.Entries = allEntries[:n]
		wire, err := sp.MarshalWire(sp.ArchiveTimeline{Entries: entries[:n]})
		if err != nil {
			t.Fatal(err)
		}
		cost, err := measureContent(contentState{ledger: &ledger})
		if err != nil || cost.TimelineBytes != int64(len(wire)) {
			t.Fatalf("entries=%d timeline=%d wire=%d err=%v", n, cost.TimelineBytes, len(wire), err)
		}
	}
}

func TestContentReplacementBoundaryAndIdentity(t *testing.T) {
	length, hash := "7", "same"
	r1 := sp.Resource{ResourceID: "a", Status: "available", Name: "图<1>", ByteLength: &length, SHA256: &hash}
	r2 := r1
	r2.ResourceID = "b"
	state := contentState{resources: []sp.Resource{r2, r1}, manifestBytes: 9}
	cost, err := measureContent(state)
	if err != nil || cost.ResourceBytes != 14 || cost.ManifestBytes != 9 {
		t.Fatalf("cost=%+v err=%v", cost, err)
	}
	wire, err := sp.MarshalWire(struct {
		Resources []sp.Resource `json:"resources"`
	}{[]sp.Resource{r1, r2}})
	if err != nil || cost.ResourceMetadataBytes != int64(len(wire)) {
		t.Fatalf("metadata=%d wire=%d err=%v", cost.ResourceMetadataBytes, len(wire), err)
	}
	again, err := checkContentReplacement(state, resourceContentChange{r1})
	if err != nil || again.ResourceBytes != cost.ResourceBytes || again.ResourceMetadataBytes != cost.ResourceMetadataBytes {
		t.Fatalf("replay cost=%+v err=%v", again, err)
	}
	changed := r1
	changed.Name = "different"
	if _, err = checkContentReplacement(state, resourceContentChange{changed}); err == nil {
		t.Fatal("same resource identity accepted different descriptor")
	}

	ledger := archiveLedger{HistoryID: "saved", Entries: []archiveLedgerEntry{{ByteLength: int(MaxSessionContentBytes - 1000)}}, Occurrences: []archiveLedgerOccurrence{}}
	base, err := measureContent(contentState{ledger: &ledger})
	if err != nil {
		t.Fatal(err)
	}
	baseTotal := base.TimelineBytes + base.IndexBytes
	for _, offset := range []int64{-1, 0, 1} {
		manifest := make([]byte, int(MaxSessionContentBytes-baseTotal+offset))
		_, err := checkContentReplacement(contentState{ledger: &ledger}, manifestContentChange{manifest})
		var f *model.Fault
		if offset <= 0 && err != nil || offset > 0 && (!errors.As(err, &f) || f.Code != "quota_exceeded") {
			t.Fatalf("offset=%d err=%v", offset, err)
		}
	}
}

func TestContentResourceCollectionLimitAtPublication(t *testing.T) {
	length := "1"
	state := contentState{}
	for i := 0; i < sp.MaxSessionResources; i++ {
		state.resources = append(state.resources, sp.Resource{ResourceID: fmt.Sprintf("%04d", i), Status: "available", ByteLength: &length})
	}
	if _, err := checkContentReplacement(state, resourceContentChange{state.resources[0]}); err != nil {
		t.Fatal("existing resource replay rejected", err)
	}
	_, err := checkContentReplacement(state, resourceContentChange{sp.Resource{ResourceID: "new", Status: "available", ByteLength: &length}})
	var refusal *model.Fault
	if !errors.As(err, &refusal) || refusal.Code != "quota_exceeded" || len(state.resources) != sp.MaxSessionResources {
		t.Fatal("new resource exceeded collection limit", err)
	}
}

func TestSealedDescriptorCostAndLimit(t *testing.T) {
	unavailable := sp.Resource{ResourceID: "failed", Status: "unavailable", Name: "lost <source>"}
	state := contentState{resources: []sp.Resource{unavailable}}
	cost, err := measureContent(state)
	wire, wireErr := sp.MarshalWire(struct {
		Resources []sp.Resource `json:"resources"`
	}{[]sp.Resource{unavailable}})
	if err != nil || wireErr != nil || cost.ResourceBytes != 0 || cost.ResourceMetadataBytes != int64(len(wire)) {
		t.Fatal("unavailable descriptor cost", cost, err, wireErr)
	}
	if replay, err := checkContentReplacement(state, sealedDescriptorsChange{[]sp.Resource{unavailable}}); err != nil || replay != cost {
		t.Fatal("descriptor replay changed cost", replay, err)
	}
	ledger := archiveLedger{HistoryID: "saved", Entries: []archiveLedgerEntry{{ByteLength: int(MaxSessionContentBytes - 1000)}}}
	base, err := measureContent(contentState{ledger: &ledger})
	if err != nil {
		t.Fatal(err)
	}
	for _, offset := range []int64{-1, 0, 1} {
		candidate := contentState{ledger: &ledger, manifestBytes: MaxSessionContentBytes - base.TimelineBytes - base.IndexBytes - cost.ResourceMetadataBytes + offset}
		_, err := checkContentReplacement(candidate, sealedDescriptorsChange{[]sp.Resource{unavailable}})
		var refusal *model.Fault
		if offset <= 0 && err != nil || offset > 0 && (!errors.As(err, &refusal) || refusal.Code != "quota_exceeded") {
			t.Fatalf("offset=%d: %v", offset, err)
		}
	}
}
