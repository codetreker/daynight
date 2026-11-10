package sessionprotocol

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"testing"
)

func TestExternalArchivePreservesIdentityAndChecksExactClosure(t *testing.T) {
	id := func(n int) string { return fmt.Sprintf("00000000-0000-4000-8000-%012d", n) }
	timeline := []byte(fmt.Sprintf(`{"entries":[{"entryId":%q,"entrySeq":"1","revision":"1","kind":"assistant_message","content":[{"type":"resource","resourceId":%q,"label":"original"}]}]}`, id(5), id(6)))
	original := []byte("original")
	manifest := []byte(fmt.Sprintf(`{"schemaVersion":3,"contentKind":"native_timeline","recordId":%q,"fence":{"sessionId":%q,"claimId":%q,"executionGeneration":"1"},"provider":"codex","nativeSessionId":"native","controllerId":%q,"controllerInstanceId":%q,"timeline":{"fileId":%q,"sha256":"%x","byteLength":"%d"},"resources":[{"resource":{"resourceId":%q,"status":"available","name":"result","mediaType":"text/plain","byteLength":"8","sha256":"%x","error":null},"blobId":%q}],"completeness":"complete"}`, id(1), id(1), id(2), id(3), id(4), id(7), sha256.Sum256(timeline), len(timeline), id(6), sha256.Sum256(original), id(8)))
	parsed, err := DecodeArchiveManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyArchiveClosure(parsed, timeline, func(ArchiveResourceReference) ([]byte, error) { return original, nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyArchiveClosure(parsed, timeline, func(ArchiveResourceReference) ([]byte, error) { return []byte("changed!"), nil }); err == nil {
		t.Fatal("corrupt original accepted")
	}
	parsed.Resources = nil
	if _, err := VerifyArchiveClosure(parsed, timeline, func(ArchiveResourceReference) ([]byte, error) { return original, nil }); err == nil {
		t.Fatal("missing descriptor accepted")
	}
	var raw map[string]any
	_ = json.Unmarshal(manifest, &raw)
	raw["recordId"] = id(9)
	other, _ := json.Marshal(raw)
	if _, err := DecodeArchiveManifest(other); err == nil {
		t.Fatal("wrong record identity accepted")
	}
}

func TestExternalArchiveHistoryAcceptsMoreThanWireArrayLimit(t *testing.T) {
	const count = 1001
	entries := make([]json.RawMessage, count)
	for i := range entries {
		entries[i] = json.RawMessage(fmt.Sprintf(`{"entryId":"00000000-0000-4000-8000-%012d","entrySeq":"%d","revision":"1","kind":"assistant_message","content":[{"type":"text","text":"saved"}]}`, i+1, i+1))
	}
	timeline, err := json.Marshal(map[string]any{"entries": entries})
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := DecodeArchiveTimeline(timeline)
	if err != nil || len(parsed.Entries) != count || parsed.Entries[count-1].EntrySeq != "1001" {
		t.Fatal("archive timeline lost entries beyond the ordinary wire array limit", len(parsed.Entries), err)
	}
	history, err := json.Marshal(map[string]any{"historyEpoch": "saved-history", "sourceThrough": "1001", "entries": entries, "resources": []Resource{}})
	if err != nil {
		t.Fatal(err)
	}
	content, err := DecodeArchiveHistory(history)
	if err != nil || len(content.Entries) != count || content.Entries[count-1].EntrySeq != "1001" {
		t.Fatal("history synchronization lost entries beyond the ordinary wire array limit", len(content.Entries), err)
	}
}
