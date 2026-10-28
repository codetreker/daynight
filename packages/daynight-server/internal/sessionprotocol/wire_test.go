package sessionprotocol

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestMarshalWirePreservesNestedHTMLAndBudgetsUnicodeSeparators(t *testing.T) {
	entry := TimelineEntry{EntryID: "entry", EntrySeq: "1", Revision: "1", Kind: "reasoning", Data: map[string]json.RawMessage{"text": json.RawMessage(`"<>&"`)}}
	page := ContentResult{Kind: "timeline", HistoryEpoch: "epoch", Items: []TimelineEntry{entry}, Resources: []Resource{}}
	for _, value := range []any{entry, page, ControllerMessage{Type: "content_response", ContentResult: &page}} {
		raw, err := MarshalWire(value)
		if err != nil || !bytes.Contains(raw, []byte(`<>&`)) || !json.Valid(raw) || bytes.HasSuffix(raw, []byte("\n")) {
			t.Fatalf("invalid wire encoding: %s %v", raw, err)
		}
	}
	raw, err := MarshalWire(map[string]string{"text": strings.Repeat("\u2028\u2029", 10)})
	if err != nil || !bytes.Contains(raw, []byte(`\u2028\u2029`)) || len(raw) != 131 {
		t.Fatalf("separator budget: %d %v", len(raw), err)
	}
	if _, err := MarshalWire(make(chan int)); err == nil {
		t.Fatal("encoding failure hidden")
	}
}
