package v2

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixtureBytes(t *testing.T, name string) []byte {
	t.Helper()
	b, e := os.ReadFile(filepath.Join("..", "..", "..", "..", "daynight", "test", "session", "fixtures", "v2", name+".json"))
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func fixtureObject(t *testing.T, name string) map[string]any {
	t.Helper()
	v, e := strictJSON(fixtureBytes(t, name))
	if e != nil {
		t.Fatal(e)
	}
	return mapAt(v)
}
func wireBytes(t *testing.T, v any) []byte {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return b
}

func TestConsumerRoundTripsAndReceiptDigest(t *testing.T) {
	for _, name := range []string{"valid-registration", "valid-native-u32", "valid-native-adapter", "valid-ready-receipt", "valid-unavailable-receipt", "valid-operation", "valid-keys"} {
		t.Run(name, func(t *testing.T) {
			message, e := DecodeMessage(fixtureBytes(t, name))
			if e != nil {
				t.Fatal(e)
			}
			if _, e = DecodeMessage(wireBytes(t, message)); e != nil {
				t.Fatal(e)
			}
			if message.Type == "receipt" {
				digest, e := ReceiptDigest(message)
				if e != nil || digest != message.Payload.(Receipt).DispositionDigest {
					t.Fatalf("receipt digest %s %v", digest, e)
				}
			}
		})
	}
	for _, name := range []string{"valid-archive", "valid-partial-archive", "valid-multiple-runs-clock-rollback"} {
		archive, e := DecodeArchive(fixtureBytes(t, name))
		if e != nil {
			t.Fatal(e)
		}
		if _, e = DecodeArchive(wireBytes(t, archive)); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := ReceiptDigest(Message{}); e == nil {
		t.Fatal("wrong digest kind accepted")
	}
	if _, e := ReceiptDigest(Message{Envelope: Envelope{Type: "receipt"}}); e == nil {
		t.Fatal("missing receipt accepted")
	}
	if _, e := ReceiptDigest(Message{Envelope: Envelope{Type: "receipt"}, Payload: Registration{}}); e == nil {
		t.Fatal("wrong receipt payload accepted")
	}
}
func TestNativeIdentityAndProtocolSelection(t *testing.T) {
	for _, test := range []struct {
		old, next *string
		valid     bool
	}{{nil, nil, true}, {nil, pointer("opaque-session"), true}, {pointer("opaque-session"), pointer("opaque-session"), true}, {pointer("opaque-session"), nil, false}, {pointer("old"), pointer("new"), false}, {nil, pointer("\n"), false}, {pointer(""), pointer(""), false}} {
		if e := AssertNativeSessionIDProgression(test.old, test.next); (e == nil) != test.valid {
			t.Fatalf("native progression: %v", e)
		}
	}
	if v, e := SelectProtocol(nil); e != nil || v != "daynight.session.v1" {
		t.Fatal(v, e)
	}
	if _, e := SelectProtocol(pointer("")); e == nil {
		t.Fatal("explicit empty protocol accepted")
	}
	for _, raw := range []string{`"pane_1"`, `0`, `4294967295`, `1.0`, `1e0`} {
		var id NativePaneID
		if e := json.Unmarshal([]byte(raw), &id); e != nil {
			t.Fatal(e)
		}
		if _, e := json.Marshal(id); e != nil {
			t.Fatal(e)
		}
	}
	for _, raw := range []string{`null`, `true`, `-1`, `1.5`, `4294967296`, `""`, `"\ud800"`, `{`} {
		var id NativePaneID
		if e := json.Unmarshal([]byte(raw), &id); e == nil {
			t.Fatalf("invalid native ID %s", raw)
		}
	}
	if _, e := json.Marshal(NativePaneID{}); e == nil {
		t.Fatal("empty native ID encoded")
	}
	if _, e := json.Marshal(NativePaneID{Text: pointer("pane_1"), Number: pointer(uint32(1))}); e == nil {
		t.Fatal("ambiguous native ID encoded")
	}
}
func TestCanonicalEscapesAndMalformedRawJSON(t *testing.T) {
	value := map[string]any{"z": float64(-0), "a": "\x00\b\f\n\r\t\"\\<>&\u2028\u2029😀\\u2028\\u2029"}
	encoded, e := CanonicalJSON(value)
	if e != nil {
		t.Fatal(e)
	}
	if string(encoded) != "{\"a\":\"\\u0000\\b\\f\\n\\r\\t\\\"\\\\<>&\u2028\u2029😀\\\\u2028\\\\u2029\",\"z\":0}" {
		t.Fatalf("encoding: %s", encoded)
	}
	for _, v := range []any{make(chan int), float64(1.5), float64(9007199254740992)} {
		if _, e := CanonicalJSON(v); e == nil {
			t.Fatal("unrepresentable canonical value accepted")
		}
	}
	for _, raw := range []string{"", `{`, `[`, `{"x":`, `{"x":1,}`, `[1,]`, `{"x":1,"\u0078":2}`, `true false`, `NaN`, `1e9999`, `"\ud800"`, `"\udfff"`, `"\ud800x"`, `"\ud800\u0000"`, `"\uXXXX"`, `"\u0"`, `"\`, "\ufeff{}", strings.Repeat("[", 66) + "0" + strings.Repeat("]", 66), string([]byte{0xff})} {
		if _, e := DecodeMessage([]byte(raw)); e == nil {
			t.Fatalf("malformed JSON accepted: %q", raw)
		}
	}
	v := strings.Replace(registrationJSON, "term_18a03f12", `term_\ud83d\ude00`, 1)
	if _, e := DecodeMessage([]byte(v)); e != nil {
		t.Fatal(e)
	}
	if _, e := DecodeArchive([]byte(`null`)); e == nil {
		t.Fatal("null archive accepted")
	}
}
func TestAllV2ObjectFieldsAreRequiredAndClosed(t *testing.T) {
	for _, test := range []struct {
		name    string
		archive bool
	}{{"valid-registration", false}, {"valid-control", false}, {"valid-ledger", false}, {"valid-finalization", false}, {"valid-ready-receipt", false}, {"valid-archive", true}} {
		base := fixtureObject(t, test.name)
		var walk func(any, func())
		check := func() {
			raw := wireBytes(t, base)
			var e error
			if test.archive {
				_, e = DecodeArchive(raw)
			} else {
				_, e = DecodeMessage(raw)
			}
			if e == nil {
				t.Fatalf("accepted missing or unknown field in %s", test.name)
			}
		}
		walk = func(v any, verify func()) {
			switch n := v.(type) {
			case map[string]any:
				for key, item := range n {
					delete(n, key)
					verify()
					n[key] = item
					walk(item, verify)
				}
				n["unknownField"] = true
				verify()
				delete(n, "unknownField")
			case []any:
				for _, item := range n {
					walk(item, verify)
				}
			}
		}
		walk(base, check)
	}
}
func TestExactByteAndCountLimits(t *testing.T) {
	archive := fixtureObject(t, "valid-archive")
	file := mapAt(archive["files"].([]any)[0])
	data := stringAt(file["data"])
	file["data"] = data + strings.Repeat(" ", MaxFrameBytes-len(data))
	file["byteLength"] = fmt.Sprint(MaxFrameBytes)
	file["sha256"] = HashBytes([]byte(stringAt(file["data"])))
	if _, e := DecodeArchive(wireBytes(t, archive)); e != nil {
		t.Fatal(e)
	}
	file["data"] = stringAt(file["data"]) + " "
	file["byteLength"] = fmt.Sprint(MaxFrameBytes + 1)
	file["sha256"] = HashBytes([]byte(stringAt(file["data"])))
	if _, e := DecodeArchive(wireBytes(t, archive)); e == nil {
		t.Fatal("oversized raw frame accepted")
	}
	base := fixtureBytes(t, "valid-archive")
	padded := append(append([]byte{}, base...), []byte(strings.Repeat(" ", MaxArchiveBytes-len(base)))...)
	if _, e := DecodeArchive(padded); e != nil {
		t.Fatal(e)
	}
	padded = append(padded, ' ')
	if _, e := DecodeArchive(padded); e == nil {
		t.Fatal("oversized archive accepted")
	}
	registration := []byte(registrationJSON)
	message := append(append([]byte{}, registration...), []byte(strings.Repeat(" ", MaxMetadataBytes-len(registration)))...)
	if _, e := DecodeMessage(message); e != nil {
		t.Fatal(e)
	}
	message = append(message, ' ')
	if _, e := DecodeMessage(message); e == nil {
		t.Fatal("oversized message accepted")
	}
	for _, test := range []struct {
		key string
		max int
	}{{"files", MaxFrames}, {"index", MaxFrames}, {"segments", MaxSegments}, {"gaps", MaxGaps}, {"runs", MaxRuns}} {
		a := fixtureObject(t, "valid-archive")
		a[test.key] = make([]any, test.max+1)
		if _, e := DecodeArchive(wireBytes(t, a)); e == nil {
			t.Fatalf("oversized %s accepted", test.key)
		}
	}
}
func TestExactSegmentAndGapLimit(t *testing.T) {
	archive := fixtureObject(t, "valid-archive")
	original := mapAt(archive["segments"].([]any)[0])
	segments := []any{}
	ids := []any{}
	gaps := []any{}
	for i := 0; i < MaxSegments; i++ {
		s := map[string]any{}
		for k, v := range original {
			s[k] = v
		}
		id := fmt.Sprintf("00000000-0000-4000-8000-%012d", i+100)
		if i == 0 {
			id = stringAt(original["segmentId"])
		}
		s["segmentId"] = id
		s["segmentOrdinal"] = fmt.Sprint(i + 1)
		segments = append(segments, s)
		ids = append(ids, id)
		if i == 0 {
			gaps = append(gaps, map[string]any{"segmentId": id, "reason": "read_interrupted", "startElapsedMs": "5001", "endElapsedMs": "5002"})
		} else {
			gaps = append(gaps, map[string]any{"kind": "boundary", "reason": "restart", "from": map[string]any{"executionGeneration": "1", "segmentId": ids[i-1]}, "to": map[string]any{"executionGeneration": "1", "segmentId": id}})
		}
	}
	archive["segments"], archive["gaps"], archive["completeness"] = segments, gaps, "partial"
	mapAt(archive["runs"].([]any)[0])["segmentIds"] = ids
	if _, e := DecodeArchive(wireBytes(t, archive)); e != nil {
		t.Fatal(e)
	}
}

func TestCanonicalOriginEquivalence(t *testing.T) {
	for _, test := range []struct {
		value string
		valid bool
	}{
		{"https://daynight.cc", true}, {"http://localhost:3000", true}, {"https://example.com:0", true}, {"https://127.0.0.1", true}, {"https://[::1]:444", true}, {"http://[2001:db8::1]", true}, {"http://[::ffff:c000:201]", true}, {"http://[1:2:3:4:5:6:7:8]", true},
		{"https://daynight.cc?", false}, {"https://daynight.cc#", false}, {"https://daynight.cc/", false}, {"https://example.com:99999", false}, {"https://127.1", false}, {"https://example.com:0443", false}, {"https://example.com:", false}, {"https://example.com:443", false}, {"http://example.com:80", false}, {"https://EXAMPLE.com", false}, {"https://example.123", false}, {"https://127.0.0.1.", false}, {"https://[0:0:0:0:0:0:0:1]", false}, {"https://[::ffff:192.0.2.1]", false}, {"https://user@example.com", false}, {"https://foo!bar", false}, {"file://example.com", false}, {"https://", false},
	} {
		t.Run(test.value, func(t *testing.T) {
			message := fixtureObject(t, "valid-registration")
			mapAt(mapAt(message["payload"])["owner"])["serverOrigin"] = test.value
			_, e := DecodeMessage(wireBytes(t, message))
			if (e == nil) != test.valid {
				t.Fatalf("valid=%v %v", test.valid, e)
			}
		})
	}
}
func TestArchiveFailureBoundaries(t *testing.T) {
	tests := []struct {
		name   string
		change func(map[string]any)
	}{
		{"unknown schema", func(v map[string]any) { v["schemaVersion"] = 3 }},
		{"unknown kind", func(v map[string]any) { v["contentKind"] = "other" }},
		{"reversed archive interval", func(v map[string]any) { v["endedAt"] = "2026-11-03T09:00:00Z" }},
		{"missing run segment", func(v map[string]any) { mapAt(v["runs"].([]any)[0])["segmentIds"] = []any{} }},
		{"proof boot mismatch", func(v map[string]any) {
			proof := mapAt(mapAt(v["runs"].([]any)[0])["stopProof"])
			mapAt(proof["processes"].([]any)[0])["bootId"] = "other"
		}},
		{"duplicate process", func(v map[string]any) {
			proof := mapAt(mapAt(v["runs"].([]any)[0])["stopProof"])
			proof["processes"] = []any{proof["processes"].([]any)[0], proof["processes"].([]any)[0]}
		}},
		{"native changed at proof", func(v map[string]any) {
			run := mapAt(v["runs"].([]any)[0])
			mapAt(run["binding"])["nativeSessionId"] = "known"
			mapAt(mapAt(run["stopProof"])["binding"])["nativeSessionId"] = "other"
		}},
		{"run outside archive", func(v map[string]any) { mapAt(v["runs"].([]any)[0])["startedAt"] = "2026-11-03T09:00:00Z" }},
		{"segment outside run", func(v map[string]any) { mapAt(v["segments"].([]any)[0])["startedAt"] = "2026-11-03T09:00:00Z" }},
		{"segment binding changed", func(v map[string]any) { mapAt(mapAt(v["segments"].([]any)[0])["binding"])["terminalId"] = "other" }},
		{"duplicate frame identity", func(v map[string]any) {
			file := mapAt(v["files"].([]any)[0])
			copy := map[string]any{}
			for k, x := range file {
				copy[k] = x
			}
			copy["fileId"] = "00000000-0000-4000-8000-000000000099"
			v["files"] = append(v["files"].([]any), copy)
		}},
		{"gap invalid ownership", func(v map[string]any) {
			v["completeness"] = "partial"
			v["gaps"] = []any{map[string]any{"segmentId": "00000000-0000-4000-8000-000000000099", "reason": "restart", "startElapsedMs": "5001", "endElapsedMs": nil}}
		}},
		{"gap reversed interval", func(v map[string]any) {
			v["completeness"] = "partial"
			v["gaps"] = []any{map[string]any{"segmentId": mapAt(v["segments"].([]any)[0])["segmentId"], "reason": "restart", "startElapsedMs": "5001", "endElapsedMs": "5000"}}
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			v := fixtureObject(t, "valid-archive")
			test.change(v)
			_, e := DecodeArchive(wireBytes(t, v))
			if e == nil {
				t.Fatal("corruption accepted")
			}
			if !strings.Contains(e.Error(), "Daynight Session v2") {
				t.Fatal(e)
			}
		})
	}
}

func TestCanonicalJSONRejectsInvalidProducerUnicode(t *testing.T) {
	for _, value := range []any{string([]byte{0xff}), map[string]any{"value": string([]byte{0xff})}, []any{string([]byte{0xff})}} {
		if _, e := CanonicalJSON(value); e == nil {
			t.Fatal("invalid producer Unicode was replaced before hashing")
		}
	}
}

func TestLimitsSharedWithTypeScript(t *testing.T) {
	expected := map[string]any{"protocolHeader": ProtocolHeader, "leaseTtlMs": LeaseTTLMillis, "leaseRenewMs": LeaseRenewalMillis, "inputMaxBytes": MaxPasteBytes, "inputTimeoutMs": InputTimeoutMillis, "archiveMaxBytes": MaxArchiveBytes, "recordingMaxBytes": MaxRecordingBytes, "metadataMaxBytes": MaxMetadataBytes, "frameMaxBytes": MaxFrameBytes, "maxFrames": MaxFrames, "maxSegments": MaxSegments, "maxGaps": MaxGaps, "maxDimension": MaxDimension, "maxRuns": MaxRuns, "maxRowBytes": MaxRowBytes, "maxTextRuns": MaxTextRuns, "sampleIntervalMs": SampleIntervalMillis, "checkpointIntervalMs": CheckpointIntervalMillis, "maxRetainedWorktrees": MaxRetainedWorktrees, "pendingSourceMaxBytes": MaxPendingSourceBytes, "minimumFreeBytes": MinFreeDiskBytes, "viewerPendingFrames": ViewerPendingFrames, "viewerStallMs": ViewerStallMillis, "uploadRetryMinMs": ArchiveRetryInitialMillis, "uploadRetryMaxMs": ArchiveRetryMaxMillis}
	raw := fixtureBytes(t, "limits")
	got, e := strictJSON(raw)
	if e != nil {
		t.Fatal(e)
	}
	want, e := CanonicalJSON(expected)
	if e != nil {
		t.Fatal(e)
	}
	actual, e := CanonicalJSON(got)
	if e != nil || string(want) != string(actual) {
		t.Fatalf("cross-language limits differ: %s %s %v", want, actual, e)
	}
	message, e := DecodeMessage(fixtureBytes(t, "valid-ready-receipt"))
	if e != nil {
		t.Fatal(e)
	}
	message.Protocol = string([]byte{0xff})
	if _, e := ReceiptDigest(message); e == nil {
		t.Fatal("invalid producer Unicode receipt hashed")
	}
}

func archiveWithFrames(t *testing.T, count int, pad bool) Archive {
	t.Helper()
	archive, e := DecodeArchive(fixtureBytes(t, "valid-archive"))
	if e != nil {
		t.Fatal(e)
	}
	segmentID := archive.Segments[0].SegmentID
	archive.Segments[0].DurationMs = fmt.Sprint(count)
	archive.Files = make([]FrameFile, count)
	archive.Index = make([]FrameIndex, count)
	for i := 0; i < count; i++ {
		data := wireBytes(t, Frame{FrameSeq: fmt.Sprint(i + 1), CapturedAt: archive.StartedAt, ElapsedMs: fmt.Sprint(i), Width: 1, Height: 1, Full: true, Rows: [][]StyledText{{}}})
		if pad {
			data = append(data, []byte(strings.Repeat(" ", MaxFrameBytes-len(data)))...)
		}
		fileID := fmt.Sprintf("00000000-0000-4000-8000-%012d", i+100)
		archive.Files[i] = FrameFile{FileID: fileID, SegmentID: segmentID, FrameSeq: fmt.Sprint(i + 1), SHA256: HashBytes(data), ByteLength: fmt.Sprint(len(data)), Data: string(data)}
		archive.Index[i] = FrameIndex{SegmentID: segmentID, FrameSeq: fmt.Sprint(i + 1), FileID: fileID, FirstElapsedMs: fmt.Sprint(i), LastElapsedMs: fmt.Sprint(i)}
	}
	return archive
}
func TestArchiveFrameCountMaximum(t *testing.T) {
	archive := archiveWithFrames(t, MaxFrames, false)
	if _, e := DecodeArchive(wireBytes(t, archive)); e != nil {
		t.Fatal(e)
	}
	archive.Files = append(archive.Files, archive.Files[0])
	archive.Index = append(archive.Index, archive.Index[0])
	if _, e := DecodeArchive(wireBytes(t, archive)); e == nil {
		t.Fatal("over-limit frame count accepted")
	}
}
func TestExactRecordingBudget(t *testing.T) {
	archive := archiveWithFrames(t, 240, true)
	last := &archive.Files[len(archive.Files)-1]
	contentSize := func() int {
		b, e := CanonicalJSON(map[string]any{"files": archive.Files, "index": archive.Index})
		if e != nil {
			t.Fatal(e)
		}
		return len(b)
	}
	for i := 0; i < 3; i++ {
		excess := contentSize() - MaxRecordingBytes
		if excess > 0 {
			last.Data = last.Data[:len(last.Data)-excess]
		} else {
			last.Data += strings.Repeat(" ", -excess)
		}
		last.ByteLength = fmt.Sprint(len(last.Data))
	}
	last.SHA256 = HashBytes([]byte(last.Data))
	if contentSize() != MaxRecordingBytes {
		t.Fatal("recording boundary construction failed")
	}
	if _, e := DecodeArchive(wireBytes(t, archive)); e != nil {
		t.Fatal(e)
	}
	last.Data += " "
	last.ByteLength = fmt.Sprint(len(last.Data))
	last.SHA256 = HashBytes([]byte(last.Data))
	if _, e := DecodeArchive(wireBytes(t, archive)); e == nil {
		t.Fatal("recording budget exceeded")
	}
}
func TestExactMetadataBudget(t *testing.T) {
	archive, e := DecodeArchive(fixtureBytes(t, "valid-archive"))
	if e != nil {
		t.Fatal(e)
	}
	original := archive.Runs[0]
	archive.ExecutionGeneration = "8"
	archive.Runs = nil
	archive.Gaps = nil
	archive.Completeness = "partial"
	for i := 0; i < 8; i++ {
		run := original
		proof := *original.StopProof
		run.StopProof = &proof
		run.ExecutionGeneration = fmt.Sprint(i + 1)
		proof.ExecutionGeneration = run.ExecutionGeneration
		proof.RecordID = fmt.Sprintf("00000000-0000-4000-8000-%012d", 800+i)
		proof.BootID = strings.Repeat("b", 256)
		proof.Processes = nil
		for j := 0; j < 1000; j++ {
			role := "agent"
			if j == 0 {
				role = "shell"
			}
			token := fmt.Sprintf("token:%d:%d:", i, j)
			token += strings.Repeat("x", 256-len(token))
			proof.Processes = append(proof.Processes, ProcessProof{Role: role, PID: j + 100, BirthToken: token, BootID: proof.BootID})
		}
		if i > 0 {
			run.SegmentIDs = []string{}
			archive.UnavailableRuns = append(archive.UnavailableRuns, UnavailableRun{ExecutionGeneration: run.ExecutionGeneration, Reason: "ended_before_first_sample", Evidence: NoRecordingEvidence{RecordingEnabled: true, SelectedFrameCount: "0", RegisteredFrameCount: "0"}})
			from := BoundaryEndpoint{ExecutionGeneration: fmt.Sprint(i)}
			if i == 1 {
				from.SegmentID = &original.SegmentIDs[0]
			}
			archive.Gaps = append(archive.Gaps, Gap{Boundary: &BoundaryGap{Kind: "boundary", Reason: "restart", From: from, To: BoundaryEndpoint{ExecutionGeneration: run.ExecutionGeneration}}})
		}
		archive.Runs = append(archive.Runs, run)
	}
	content, e := CanonicalJSON(map[string]any{"files": archive.Files, "index": archive.Index})
	if e != nil {
		t.Fatal(e)
	}
	metadataSize := func() int {
		all, e := CanonicalJSON(archive)
		if e != nil {
			t.Fatal(e)
		}
		return len(all) - len(content)
	}
	excess := metadataSize() - MaxMetadataBytes
	if excess <= 0 {
		t.Fatal("metadata test must start above budget")
	}
	for i := range archive.Runs {
		for j := range archive.Runs[i].StopProof.Processes {
			p := &archive.Runs[i].StopProof.Processes[j]
			remove := min(excess, len(p.BirthToken)-24)
			p.BirthToken = p.BirthToken[:len(p.BirthToken)-remove]
			excess -= remove
		}
	}
	if excess != 0 || metadataSize() != MaxMetadataBytes {
		t.Fatal("metadata boundary construction failed")
	}
	if _, e := DecodeArchive(wireBytes(t, archive)); e != nil {
		t.Fatal(e)
	}
	archive.Runs[0].StopProof.Processes[0].BirthToken += "x"
	if _, e := DecodeArchive(wireBytes(t, archive)); e == nil {
		t.Fatal("metadata budget exceeded")
	}
}

func TestProducerRejectsMismatchedDiscriminators(t *testing.T) {
	registration, err := DecodeMessage(fixtureBytes(t, "valid-registration"))
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name    string
		payload Payload
		kind    string
	}{
		{"wrong message type", registration.Payload, "snapshot"},
		{"missing message payload", nil, "registration"},
		{"nil concrete payload", (*Registration)(nil), "registration"},
	} {
		t.Run(test.name, func(t *testing.T) {
			message := registration
			message.Type = test.kind
			message.Payload = test.payload
			if _, err := json.Marshal(message); err == nil {
				t.Fatal("message discriminator did not describe its payload")
			}
		})
	}
	keysMessage, err := DecodeMessage(fixtureBytes(t, "valid-keys"))
	if err != nil {
		t.Fatal(err)
	}
	original := keysMessage.Payload.(Operation)
	for _, test := range []struct {
		name    string
		payload InputPayload
		kind    string
	}{
		{"keys encoded as paste", original.Payload, "paste"},
		{"paste encoded as keys", Paste{Text: "hello"}, "keys"},
		{"missing operation payload", nil, "keys"},
		{"nil concrete operation payload", (*Keys)(nil), "keys"},
		{"nil concrete paste payload", (*Paste)(nil), "paste"},
	} {
		t.Run(test.name, func(t *testing.T) {
			operation := original
			operation.Kind = test.kind
			operation.Payload = test.payload
			if _, err := json.Marshal(operation); err == nil {
				t.Fatal("operation discriminator did not describe its payload")
			}
		})
	}
}
