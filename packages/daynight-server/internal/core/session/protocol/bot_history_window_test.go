package sessionprotocol

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func windowString(v string) *string { return &v }

func windowBoundary() BotHistoryWindowBoundary {
	return BotHistoryWindowBoundary{
		ControllerFence:         ControllerFence{Fence: Fence{SessionID: relayID, TestExecutionID: relayID, ExecutionGeneration: "9007199254740993"}, ConnectionEpoch: "2"},
		BotHistoryWindowVersion: 1, HistoryEpoch: relayID, WindowRevision: "5",
		RetainedFromSeq: windowString("9007199254740993"), ThroughSeq: windowString("9007199254740995"), EarlierHistoryUnavailable: true,
	}
}

func windowEntry() BotHistoryWindowEntry {
	return BotHistoryWindowEntry{EntryID: relayID, EntrySeq: "9007199254740993", Revision: "2", Kind: "assistant_message", Preview: "<你好🙂>", Truncated: true, PreviewBytes: "12", OmissionReason: windowString("preview_budget"), ResourceIDs: []string{}}
}

func windowPage() BotHistoryWindowPage {
	return BotHistoryWindowPage{BotHistoryWindowBoundary: windowBoundary(), Kind: "bot_history_window", Items: []BotHistoryWindowEntry{windowEntry()}, NextCursor: windowString("next")}
}

func windowJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := MarshalWire(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestBotWindowPreviewRoundTripAndCanonicalDigest(t *testing.T) {
	page := windowPage()
	parsed, err := DecodeBotHistoryWindowPage(windowJSON(t, page))
	if err != nil || !reflect.DeepEqual(parsed, page) {
		t.Fatalf("page: %#v %v", parsed, err)
	}
	digest, err := BotHistoryWindowEntryDigest(page.Items[0])
	// This Unicode/HTML-sensitive vector is shared with the TypeScript parser.
	if err != nil || digest != "8a3bb9125548e65502e4948f8f14adf64e2e59c3197b719cd6b948b226d84b84" {
		t.Fatalf("digest %s: %v", digest, err)
	}
	result, err := DecodeContentResult(windowJSON(t, page))
	if err != nil || result.BotHistoryWindow == nil || result.BotHistoryWindow.Items[0].Preview != page.Items[0].Preview {
		t.Fatalf("content: %#v %v", result, err)
	}
	if _, err = DecodeContentResult(windowJSON(t, result)); err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeBotHistoryWindowPage([]byte(strings.Replace(string(windowJSON(t, page)), `"botHistoryWindowVersion":1`, `"botHistoryWindowVersion":1e0`, 1))); err != nil {
		t.Fatal("equivalent version", err)
	}
	invalid := windowEntry()
	invalid.PreviewBytes = "1"
	if _, err := BotHistoryWindowEntryDigest(invalid); err == nil {
		t.Fatal("hashed inconsistent preview")
	}
	invalid.Preview = string([]byte{0xff})
	if _, err := BotHistoryWindowEntryDigest(invalid); err == nil {
		t.Fatal("hashed invalid UTF-8")
	}
	if _, err := DecodeBotHistoryWindowPage(make([]byte, MaxHistoryResponseBytes+1)); err == nil {
		t.Fatal("accepted oversized page")
	}
	if _, err := DecodeBotHistoryCheckpoint(make([]byte, MaxFrameBytes+1)); err == nil {
		t.Fatal("accepted oversized checkpoint")
	}
}

func TestBotWindowRejectsMalformedPreviewAndBoundary(t *testing.T) {
	tests := map[string]func(*BotHistoryWindowPage){
		"invalid cursor alphabet": func(v *BotHistoryWindowPage) { v.NextCursor = windowString("cursor with spaces") },
		"byte count":              func(v *BotHistoryWindowPage) { v.Items[0].PreviewBytes = "6" },
		"original count":          func(v *BotHistoryWindowPage) { v.Items[0].OriginalBytes = windowString("11") },
		"no omission reason":      func(v *BotHistoryWindowPage) { v.Items[0].OmissionReason = nil },
		"summary for message":     func(v *BotHistoryWindowPage) { v.Items[0].OmittedEntryCount = 1 },
		"unmarked truncation":     func(v *BotHistoryWindowPage) { v.Items[0].Truncated = false },
		"oversized preview": func(v *BotHistoryWindowPage) {
			v.Items[0].Preview = strings.Repeat("a", MaxBotHistoryWindowPreviewBytes+1)
			v.Items[0].PreviewBytes = "32769"
		},
		"duplicate resources":     func(v *BotHistoryWindowPage) { v.Items[0].ResourceIDs = []string{relayID, relayID} },
		"entry below floor":       func(v *BotHistoryWindowPage) { v.RetainedFromSeq = windowString("9007199254740994") },
		"entry past upper":        func(v *BotHistoryWindowPage) { v.ThroughSeq = windowString("9007199254740992") },
		"duplicate entry":         func(v *BotHistoryWindowPage) { v.Items = append(v.Items, v.Items[0]) },
		"unreadable earlier page": func(v *BotHistoryWindowPage) { v.HasEarlierHistory = true },
		"missing epoch":           func(v *BotHistoryWindowPage) { v.HistoryEpoch = "" },
		"unsupported version":     func(v *BotHistoryWindowPage) { v.BotHistoryWindowVersion = 2 },
		"task claim":              func(v *BotHistoryWindowPage) { v.ClaimID = relayID },
		"zero revision":           func(v *BotHistoryWindowPage) { v.WindowRevision = "0" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			page := windowPage()
			mutate(&page)
			if _, err := DecodeBotHistoryWindowPage(windowJSON(t, page)); err == nil {
				t.Fatal("accepted invalid page")
			}
		})
	}
	page := windowPage()
	page.Items[0].Truncated = false
	page.Items[0].OmissionReason = nil
	page.Items[0].OriginalBytes = windowString("12")
	if _, err := DecodeBotHistoryWindowPage(windowJSON(t, page)); err != nil {
		t.Fatal("complete preview", err)
	}
	page.Items[0].Kind = "tool_call"
	page.Items[0].Truncated = true
	page.Items[0].OmissionReason = windowString("tool_summary")
	page.Items[0].OmittedEntryCount = 3
	if _, err := DecodeBotHistoryWindowPage(windowJSON(t, page)); err != nil {
		t.Fatal("tool summary", err)
	}
	if _, err := DecodeBotHistoryWindowPage([]byte(strings.Replace(string(windowJSON(t, page)), `"preview":"<你好🙂>"`, `"preview":"\ud800"`, 1))); err == nil {
		t.Fatal("accepted invalid Unicode")
	}
}

func TestBotWindowEmptyDoesNotEraseEviction(t *testing.T) {
	page := windowPage()
	page.Items = []BotHistoryWindowEntry{}
	page.RetainedFromSeq = nil
	if _, err := DecodeBotHistoryWindowPage(windowJSON(t, page)); err != nil {
		t.Fatal(err)
	}
	page.EarlierHistoryUnavailable = false
	if _, err := DecodeBotHistoryWindowPage(windowJSON(t, page)); err == nil {
		t.Fatal("accepted false initial-empty history")
	}
	page.ThroughSeq = nil
	if _, err := DecodeBotHistoryWindowPage(windowJSON(t, page)); err != nil {
		t.Fatal("initial empty", err)
	}
	page.EarlierHistoryUnavailable = true
	if _, err := DecodeBotHistoryWindowPage(windowJSON(t, page)); err == nil {
		t.Fatal("accepted eviction without observation")
	}
}

func TestBotWindowToolMetadataPreservesUnknownsAndBounds(t *testing.T) {
	page := windowPage()
	code := -1
	page.Items[0].Kind = "tool_call"
	page.Items[0].Tool = &BotHistoryWindowTool{ToolName: windowString("shell"), Command: windowString("echo 你好"), Status: windowString("completed"), ExitCode: &code}
	parsed, err := DecodeBotHistoryWindowPage(windowJSON(t, page))
	if err != nil || !reflect.DeepEqual(parsed.Items[0].Tool, page.Items[0].Tool) {
		t.Fatalf("metadata: %#v %v", parsed, err)
	}
	page.Items[0].Tool.Command = windowString(strings.Repeat("🙂", 2049))
	if _, err := DecodeBotHistoryWindowPage(windowJSON(t, page)); err == nil {
		t.Fatal("accepted oversized command")
	}
	page.Items[0].Tool.Command = nil
	page.Items[0].Tool.CWD = windowString(strings.Repeat("x", 4097))
	if _, err := DecodeBotHistoryWindowPage(windowJSON(t, page)); err == nil {
		t.Fatal("accepted oversized cwd")
	}
	page.Items[0].Tool.CWD = nil
	page.Items[0].Kind = "assistant_message"
	if _, err := DecodeBotHistoryWindowPage(windowJSON(t, page)); err == nil {
		t.Fatal("accepted tool metadata on assistant message")
	}
}

func TestBotWindowCheckpointClosureAndRequest(t *testing.T) {
	checkpoint := BotHistoryCheckpoint{BotHistoryWindowBoundary: windowBoundary(), SourceThrough: "99", Entries: []BotHistoryCheckpointEntry{{EntryID: relayID, EntrySeq: "9007199254740993", Revision: "2", SHA256: strings.Repeat("a", 64), ResourceIDs: []string{relayID}, ImageOccurrences: []ImageOccurrence{}}}}
	if _, err := DecodeBotHistoryCheckpoint(windowJSON(t, checkpoint)); err != nil {
		t.Fatal(err)
	}
	occurrence := ImageOccurrence{ImageID: relayID, EntryID: relayID, Container: "content", PartID: windowString(relayID), SourceRevision: windowString("2"), SourceTextSHA256: windowString(strings.Repeat("a", 64)), SourceKey: "image"}
	checkpoint.Entries[0].ImageOccurrences = []ImageOccurrence{occurrence}
	if _, err := DecodeBotHistoryCheckpoint(windowJSON(t, checkpoint)); err != nil {
		t.Fatal("image occurrence", err)
	}
	checkpoint.Entries[0].ImageOccurrences[0].EntryID = "00000000-0000-4000-8000-000000000002"
	if _, err := DecodeBotHistoryCheckpoint(windowJSON(t, checkpoint)); err == nil {
		t.Fatal("accepted foreign entry occurrence")
	}
	checkpoint.Entries[0].ImageOccurrences = []ImageOccurrence{occurrence, occurrence}
	if _, err := DecodeBotHistoryCheckpoint(windowJSON(t, checkpoint)); err == nil {
		t.Fatal("accepted duplicate image occurrence")
	}
	checkpoint.Entries[0].ImageOccurrences = []ImageOccurrence{}
	receipt := BotHistoryCheckpointReceipt{BotHistoryWindowBoundary: checkpoint.BotHistoryWindowBoundary, SourceThrough: checkpoint.SourceThrough}
	if _, err := DecodeBotHistoryCheckpointReceipt(windowJSON(t, receipt)); err != nil {
		t.Fatal(err)
	}
	checkpoint.Entries[0].EntrySeq = "9007199254740994"
	if _, err := DecodeBotHistoryCheckpoint(windowJSON(t, checkpoint)); err == nil {
		t.Fatal("accepted incomplete retained prefix")
	}
	checkpoint.Entries = nil
	if _, err := DecodeBotHistoryCheckpoint(windowJSON(t, checkpoint)); err == nil {
		t.Fatal("accepted null entries")
	}
	checkpoint.Entries = []BotHistoryCheckpointEntry{}
	checkpoint.RetainedFromSeq = nil
	if _, err := DecodeBotHistoryCheckpoint(windowJSON(t, checkpoint)); err != nil {
		t.Fatal("empty retained checkpoint", err)
	}
	for _, mode := range []string{"tail", "before", "changes"} {
		req := BotHistoryWindowRequest{Kind: "bot_history_window", HistoryEpoch: relayID, Mode: mode, Limit: 50}
		if mode != "tail" {
			req.Cursor = windowString("position")
		}
		if _, err := DecodeBotHistoryWindowRequest(windowJSON(t, req)); err != nil {
			t.Fatal(mode, err)
		}
		req.Cursor = nil
		if mode == "tail" {
			req.Cursor = windowString("position")
		}
		if _, err := DecodeBotHistoryWindowRequest(windowJSON(t, req)); err == nil {
			t.Fatal("accepted wrong cursor", mode)
		}
	}
}

func TestBotWindowCheckpointReceiptRequiresCompleteCommitFacts(t *testing.T) {
	for _, pending := range []bool{false, true} {
		receipt := BotHistoryCheckpointReceipt{BotHistoryWindowBoundary: windowBoundary(), SourceThrough: "9007199254740997", CleanupPending: pending}
		parsed, err := DecodeBotHistoryCheckpointReceipt(windowJSON(t, receipt))
		if err != nil || !reflect.DeepEqual(parsed, receipt) {
			t.Fatalf("cleanup pending %v: %#v %v", pending, parsed, err)
		}
	}
	tests := map[string]func(map[string]any){
		"missing cleanup outcome":            func(v map[string]any) { delete(v, "cleanupPending") },
		"unknown cleanup outcome":            func(v map[string]any) { v["cleanupPending"] = nil },
		"rounded source watermark":           func(v map[string]any) { v["sourceThrough"] = float64(9007199254740997) },
		"reversed retained boundary":         func(v map[string]any) { v["retainedFromSeq"] = "9007199254740996" },
		"eviction reported as initial empty": func(v map[string]any) { v["retainedFromSeq"] = nil; v["earlierHistoryUnavailable"] = false },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			receipt := BotHistoryCheckpointReceipt{BotHistoryWindowBoundary: windowBoundary(), SourceThrough: "9007199254740997", CleanupPending: true}
			var input map[string]any
			if err := json.Unmarshal(windowJSON(t, receipt), &input); err != nil {
				t.Fatal(err)
			}
			mutate(input)
			parsed, err := DecodeBotHistoryCheckpointReceipt(windowJSON(t, input))
			if err == nil || !reflect.DeepEqual(parsed, BotHistoryCheckpointReceipt{}) {
				t.Fatalf("unusable receipt exposed commit facts: %#v %v", parsed, err)
			}
		})
	}
}

func TestBotWindowHelloCapabilityIsExplicitAndOptional(t *testing.T) {
	hello := map[string]any{"type": "hello", "protocol": Protocol, "schemaVersion": 1, "projectionVersion": 1, "sessionId": relayID, "testExecutionId": relayID, "executionGeneration": "1", "controllerId": relayID, "controllerInstanceId": relayID, "provider": "codex", "sourceEpoch": relayID, "lastAckedSourceSeq": "0"}
	legacy, err := DecodeController(windowJSON(t, hello))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(windowJSON(t, legacy)), "botHistoryWindowVersion") {
		t.Fatal("legacy hello gained capability")
	}
	hello["botHistoryWindowVersion"] = 1
	parsed, err := DecodeController(windowJSON(t, hello))
	if err != nil || parsed.BotHistoryWindowVersion != 1 {
		t.Fatalf("capability: %#v %v", parsed, err)
	}
	if _, err = DecodeController(windowJSON(t, parsed)); err != nil {
		t.Fatal(err)
	}
	if _, err = DecodeController([]byte(strings.Replace(string(windowJSON(t, parsed)), `"botHistoryWindowVersion":1`, `"botHistoryWindowVersion":1.0`, 1))); err != nil {
		t.Fatal("equivalent capability", err)
	}
	for _, bad := range []any{nil, 0, 2, "1"} {
		hello["botHistoryWindowVersion"] = bad
		if _, err := DecodeController(windowJSON(t, hello)); err == nil {
			t.Fatalf("accepted %v", bad)
		}
	}
	hello["botHistoryWindowVersion"] = 1
	delete(hello, "testExecutionId")
	hello["claimId"] = relayID
	if _, err := DecodeController(windowJSON(t, hello)); err == nil {
		t.Fatal("accepted Task window capability")
	}
	var page map[string]any
	_ = json.Unmarshal(windowJSON(t, windowPage()), &page)
	page["body"] = "not complete history"
	if _, err := DecodeBotHistoryWindowPage(windowJSON(t, page)); err == nil {
		t.Fatal("accepted a complete body field")
	}
}
