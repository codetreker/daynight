package sessionprotocol

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func taskBodyFixture(t *testing.T) (ArchiveManifest, []byte, ArchiveHistoryContent) {
	t.Helper()
	identity := func(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n) }
	timeline := []byte(fmt.Sprintf(`{"entries":[{"entryId":%q,"entrySeq":"3","revision":"2","kind":"assistant_message","content":[{"type":"text","text":"$ echo stdout\\nerror: original"}]}]}`, identity(5)))
	parsed, err := DecodeArchiveTimeline(timeline)
	if err != nil {
		t.Fatal(err)
	}
	manifest := ArchiveManifest{SchemaVersion: 3, ContentPolicy: "task_body", ContentKind: "native_timeline", RecordID: identity(1), Fence: Fence{SessionID: identity(1), ClaimID: identity(2), ExecutionGeneration: "1"}, Provider: "codex", ControllerID: identity(3), ControllerInstanceID: identity(4), Timeline: ArchiveFileReference{FileID: identity(6), SHA256: fmt.Sprintf("%x", sha256.Sum256(timeline)), ByteLength: fmt.Sprint(len(timeline))}, Resources: []ArchiveResourceReference{}, Completeness: "complete"}
	callID := "tool-call"
	history := ArchiveHistoryContent{ContentPolicy: "task_body", HistoryEpoch: "epoch", SourceThrough: "9", Entries: parsed.Entries, Resources: []Resource{}, OnlineImageOccurrences: []ImageOccurrence{{ImageID: identity(7), EntryID: identity(8), Container: "tool_output", CallID: &callID, SourceKey: "tool-image"}}}
	return manifest, timeline, history
}

func TestTaskBodyHistoryAndManifestPreserveExplicitPolicy(t *testing.T) {
	manifest, timeline, history := taskBodyFixture(t)
	bytes, err := MarshalWire(history)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeArchiveHistory(bytes)
	if err != nil || decoded.ContentPolicy != "task_body" || len(decoded.OnlineImageOccurrences) != 1 || decoded.Entries[0].EntrySeq != "3" {
		t.Fatalf("%+v %v", decoded, err)
	}
	bytes, _ = MarshalWire(manifest)
	parsed, err := DecodeArchiveManifest(bytes)
	if err != nil || parsed.ContentPolicy != "task_body" {
		t.Fatal(parsed, err)
	}
	if _, err = VerifyArchiveClosure(parsed, timeline, func(ArchiveResourceReference) ([]byte, error) { t.Fatal("unexpected resource"); return nil, nil }); err != nil {
		t.Fatal(err)
	}
	history.OnlineImageOccurrences = nil
	bytes, _ = MarshalWire(history)
	if !strings.Contains(string(bytes), `"onlineImageOccurrences":[]`) {
		t.Fatal(string(bytes))
	}
	if _, err = DecodeArchiveHistory(bytes); err != nil {
		t.Fatal(err)
	}
	history.ContentPolicy = ""
	bytes, _ = MarshalWire(history)
	if strings.Contains(string(bytes), "contentPolicy") || strings.Contains(string(bytes), "onlineImageOccurrences") {
		t.Fatal("legacy shape changed", string(bytes))
	}
	if _, err = DecodeArchiveHistory(bytes); err != nil {
		t.Fatal(err)
	}
}

func TestTaskBodyHistoryRejectsExcludedEntriesAndMalformedPositions(t *testing.T) {
	_, _, history := taskBodyFixture(t)
	original, _ := MarshalWire(history)
	for _, test := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"unknown policy", func(v map[string]any) { v["contentPolicy"] = "legacy" }},
		{"missing positions", func(v map[string]any) { delete(v, "onlineImageOccurrences") }},
		{"null positions", func(v map[string]any) { v["onlineImageOccurrences"] = nil }},
		{"duplicate positions", func(v map[string]any) {
			positions := v["onlineImageOccurrences"].([]any)
			v["onlineImageOccurrences"] = append(positions, positions[0])
		}},
		{"body occurrence", func(v map[string]any) {
			p := v["onlineImageOccurrences"].([]any)[0].(map[string]any)
			p["container"], p["callId"] = "content", nil
		}},
		{"body entry identity", func(v map[string]any) {
			v["onlineImageOccurrences"].([]any)[0].(map[string]any)["entryId"] = v["entries"].([]any)[0].(map[string]any)["entryId"]
		}},
		{"unknown field", func(v map[string]any) { v["tools"] = []any{} }},
		{"excluded entry", func(v map[string]any) {
			entry := v["entries"].([]any)[0].(map[string]any)
			entry["kind"] = "error"
			delete(entry, "content")
			entry["code"], entry["message"] = "tool", "output"
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var v map[string]any
			_ = json.Unmarshal(original, &v)
			test.mutate(v)
			bytes, _ := json.Marshal(v)
			if _, err := DecodeArchiveHistory(bytes); err == nil {
				t.Fatal("accepted", string(bytes))
			}
		})
	}
}

func TestTaskBodyManifestRejectsTestBindingAndToolClosure(t *testing.T) {
	manifest, _, history := taskBodyFixture(t)
	manifest.Fence.TestExecutionID, manifest.Fence.ClaimID = manifest.Fence.ClaimID, ""
	bytes, _ := MarshalWire(manifest)
	if _, err := DecodeArchiveManifest(bytes); err == nil {
		t.Fatal("accepted Test/Bot body policy")
	}
	manifest, _, _ = taskBodyFixture(t)
	timeline := []byte(fmt.Sprintf(`{"entries":[{"entryId":%q,"entrySeq":"3","revision":"2","kind":"error","code":"tool","message":"output"}]}`, history.Entries[0].EntryID))
	manifest.Timeline.SHA256, manifest.Timeline.ByteLength = fmt.Sprintf("%x", sha256.Sum256(timeline)), fmt.Sprint(len(timeline))
	if _, err := VerifyArchiveClosure(manifest, timeline, nil); err == nil {
		t.Fatal("accepted excluded entry in body closure")
	}
}
