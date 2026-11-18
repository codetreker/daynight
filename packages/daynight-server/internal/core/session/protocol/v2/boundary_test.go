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
	b, e := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "..", "daynight", "test", "session", "fixtures", "v2", name+".json"))
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

func TestArchiveRoundTrips(t *testing.T) {
	for _, name := range []string{"valid-archive", "valid-partial-archive", "valid-multiple-runs-clock-rollback"} {
		archive, err := DecodeArchive(fixtureBytes(t, name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = DecodeArchive(wireBytes(t, archive)); err != nil {
			t.Fatal(err)
		}
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
		if _, e := strictJSON([]byte(raw)); e == nil {
			t.Fatalf("malformed JSON accepted: %q", raw)
		}
	}
	if _, e := DecodeArchive([]byte(`null`)); e == nil {
		t.Fatal("null archive accepted")
	}
}
func TestAllV2ObjectFieldsAreRequiredAndClosed(t *testing.T) {
	for _, test := range []struct {
		name    string
		archive bool
	}{{"valid-archive", true}} {
		base := fixtureObject(t, test.name)
		var walk func(any, func())
		check := func() {
			raw := wireBytes(t, base)
			var e error
			_, e = DecodeArchive(raw)
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
func TestExactFrameBytesAndCountLimits(t *testing.T) {
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

func TestOversizedRawPayloadsAreRejectedBeforeParsing(t *testing.T) {
	if _, err := DecodeArchive(make([]byte, MaxArchiveBytes+1)); err == nil {
		t.Fatal("oversized raw archive accepted")
	}

}

func archiveWithSegments(t *testing.T, count int) map[string]any {
	t.Helper()
	archive := fixtureObject(t, "valid-archive")
	original := mapAt(archive["segments"].([]any)[0])
	segments := []any{}
	ids := []any{}
	gaps := []any{}
	for i := 0; i < count; i++ {
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
	return archive
}

func TestOrderedSegmentsAndGaps(t *testing.T) {
	archive := archiveWithSegments(t, 3)
	if _, err := DecodeArchive(wireBytes(t, archive)); err != nil {
		t.Fatal(err)
	}
	segments := archive["segments"].([]any)
	segments[1], segments[2] = segments[2], segments[1]
	if _, err := DecodeArchive(wireBytes(t, archive)); err == nil {
		t.Fatal("out-of-order segments accepted")
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
			if origin(test.value) != test.valid {
				t.Fatalf("valid=%v", test.valid)
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
	expected := map[string]any{"protocolHeader": ProtocolHeader, "archiveMaxBytes": MaxArchiveBytes, "recordingMaxBytes": MaxRecordingBytes, "metadataMaxBytes": MaxMetadataBytes, "frameMaxBytes": MaxFrameBytes, "maxFrames": MaxFrames, "maxSegments": MaxSegments, "maxGaps": MaxGaps, "maxDimension": MaxDimension, "maxRuns": MaxRuns, "maxRowBytes": MaxRowBytes, "maxTextRuns": MaxTextRuns, "sampleIntervalMs": SampleIntervalMillis, "checkpointIntervalMs": CheckpointIntervalMillis}
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

}

func TestArchiveRejectsInvalidRetainedRecording(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(map[string]any)
	}{
		{"non-string completeness", func(archive map[string]any) { archive["completeness"] = float64(1) }},
		{"unfinished run", func(archive map[string]any) {
			run := mapAt(archive["runs"].([]any)[0])
			run["stoppedAt"], run["stopProof"] = nil, nil
		}},
		{"stop proof without stop time", func(archive map[string]any) {
			mapAt(archive["runs"].([]any)[0])["stoppedAt"] = nil
		}},
		{"frame row exceeds byte limit", func(archive map[string]any) {
			file := mapAt(archive["files"].([]any)[0])
			frame, err := strictJSON([]byte(stringAt(file["data"])))
			if err != nil {
				t.Fatal(err)
			}
			row := mapAt(mapAt(frame)["rows"].([]any)[0].([]any)[0])
			row["text"] = strings.Repeat("x", MaxRowBytes+1)
			data := wireBytes(t, frame)
			file["data"], file["byteLength"], file["sha256"] = string(data), fmt.Sprint(len(data)), HashBytes(data)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			archive := fixtureObject(t, "valid-archive")
			test.change(archive)
			if _, err := DecodeArchive(wireBytes(t, archive)); err == nil {
				t.Fatal("invalid retained recording accepted")
			}
		})
	}
}

func TestArchiveStatusMessageDiscriminator(t *testing.T) {
	for _, message := range []Message{
		{Envelope: Envelope{Type: "archive_status"}},
		{Envelope: Envelope{Type: "other"}, Payload: ArchiveStatus{State: "pending"}},
		{Envelope: Envelope{Type: "archive_status"}, Payload: (*ArchiveStatus)(nil)},
	} {
		if _, err := json.Marshal(message); err == nil {
			t.Fatal("invalid archive status envelope accepted")
		}
	}
	message := Message{Envelope: Envelope{Type: "archive_status"}, Payload: ArchiveStatus{State: "pending"}}
	if _, err := json.Marshal(message); err != nil {
		t.Fatal(err)
	}
}
