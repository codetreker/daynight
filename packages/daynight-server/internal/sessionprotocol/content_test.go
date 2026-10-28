package sessionprotocol

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func contentFrame(result any) []byte {
	b, _ := json.Marshal(result)
	return []byte(`{` + relayFence + `,"type":"content_response","requestId":"` + relayID + `","sourceThrough":"0","result":` + string(b) + `,"error":null}`)
}
func contentPage() map[string]any {
	return map[string]any{"kind": "timeline", "historyEpoch": relayID, "items": []any{map[string]any{"entryId": relayID, "entrySeq": "1", "revision": "1", "kind": "reasoning", "text": "local history"}}, "resources": []any{}, "beforeCursor": nil, "afterCursor": nil, "hasMoreBefore": false, "hasMoreAfter": false}
}
func TestControllerLocalContentUnion(t *testing.T) {
	page := contentFrame(contentPage())
	v, err := DecodeController(page)
	if err != nil || v.ContentResult == nil || v.ContentResult.Items[0].EntrySeq != "1" || string(v.ContentResult.Items[0].Data["text"]) != `"local history"` {
		t.Fatalf("decode: %#v %v", v, err)
	}
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = DecodeController(data); err != nil {
		t.Fatal("roundtrip", err)
	}
	for _, bad := range []string{strings.Replace(string(page), `"sourceThrough":"0"`, `"sourceThrough":"01"`, 1), strings.Replace(string(page), `"error":null`, `"error":{"code":"missing","message":"Local history missing"}`, 1), strings.Replace(string(page), `"entrySeq":"1"`, `"entrySeq":"0"`, 1), strings.Replace(string(page), `"requestId":"`+relayID+`"`, `"requestId":null`, 1), strings.Replace(string(page), `"hasMoreBefore":false`, `"hasMoreBefore":false,"unexpected":true`, 1)} {
		if _, e := DecodeController([]byte(bad)); e == nil {
			t.Fatalf("accepted invalid %s", bad)
		}
	}
	failure := []byte(`{` + relayFence + `,"type":"content_response","requestId":"` + relayID + `","sourceThrough":"0","result":null,"error":{"code":"not_found","message":"Local resource missing"}}`)
	if v, e := DecodeController(failure); e != nil || v.ContentError == nil || v.ContentResult != nil {
		t.Fatalf("failure union: %#v %v", v, e)
	}
	if _, e := DecodeController([]byte(strings.Replace(string(failure), `{"code":"not_found","message":"Local resource missing"}`, `null`, 1))); e == nil {
		t.Fatal("accepted both null")
	}
}
func TestControllerResourceChunksAreBoundedAndCanonical(t *testing.T) {
	result := map[string]any{"kind": "resource", "resource": map[string]any{"resourceId": relayID, "status": "available", "name": "text", "mediaType": "text/plain", "byteLength": "1", "sha256": strings.Repeat("a", 64), "error": nil}, "offset": "0", "data": "YQ==", "eof": true}
	if _, e := DecodeController(contentFrame(result)); e != nil {
		t.Fatal(e)
	}
	for _, bad := range []string{"YR==", "YQ", "YQ==\n", base64.StdEncoding.EncodeToString(make([]byte, MaxContentChunkBytes+1))} {
		result["data"] = bad
		if _, e := DecodeController(contentFrame(result)); e == nil {
			t.Fatal("accepted invalid or oversized chunk")
		}
	}
	result["data"] = base64.StdEncoding.EncodeToString(make([]byte, MaxContentChunkBytes))
	if _, e := DecodeController(contentFrame(result)); e != nil {
		t.Fatal("rejected boundary", e)
	}
}
func TestSourceTimelineSequenceAndLiveSync(t *testing.T) {
	raw := `{"entryId":"` + relayID + `","entrySeq":"9","revision":"1","kind":"interaction","interaction":{"interactionId":"` + relayID + `","revision":"1","state":"pending","kind":"approval","title":"Approve","detail":"Read file","actions":["allow_once"]}}`
	if v, e := DecodeSourceTimeline([]byte(raw)); e != nil || v.EntrySeq != "9" {
		t.Fatalf("source stable sequence %#v %v", v, e)
	}
	state := `{"nativeSessionId":"native","initialInputState":"confirmed","synchronized":true,"activity":"waiting_input","currentTurnId":"turn","capabilities":{"send":true,"steer":false,"cancel":true,"respond":true}}`
	frame := []byte(`{` + relayFence + `,"type":"sync_state","state":` + state + `,"pendingInteractions":[` + raw + `]}`)
	v, e := DecodeController(frame)
	if e != nil || v.State == nil || len(v.PendingInteractions) != 1 || v.PendingInteractions[0].EntrySeq != "9" {
		t.Fatalf("live sync %#v %v", v, e)
	}
	for _, bad := range []string{strings.Replace(string(frame), `"entrySeq":"9",`, "", 1), strings.Replace(string(frame), `"state":"pending"`, `"state":"resolved"`, 1), strings.Replace(string(frame), `"pendingInteractions":[`+raw+`]`, `"pendingInteractions":[`+raw+`,`+raw+`]`, 1)} {
		if _, e = DecodeController([]byte(bad)); e == nil {
			t.Fatal("invalid pending sync accepted")
		}
	}
	hello := `{"type":"hello","protocol":"daynight.session.v1","sessionId":"` + relayID + `","claimId":"` + relayID + `","executionGeneration":"1","controllerId":"` + relayID + `","controllerInstanceId":"` + relayID + `","provider":"codex","sourceEpoch":"` + relayID + `","lastAckedSourceSeq":"0","schemaVersion":1,"projectionVersion":1,"sourceFloor":"0"}`
	if v, e := DecodeController([]byte(hello)); e != nil || v.SourceFloor == nil || *v.SourceFloor != "0" {
		t.Fatalf("source floor %#v %v", v, e)
	}
	if _, e := DecodeController([]byte(strings.Replace(hello, `"sourceFloor":"0"`, `"sourceFloor":0`, 1))); e == nil {
		t.Fatal("numeric source floor accepted")
	}
}

func TestContentResultsRoundTripAndRejectInvalidLocalPages(t *testing.T) {
	resource := map[string]any{"resourceId": relayID, "status": "available", "name": "local.txt", "mediaType": "text/plain", "byteLength": "1", "sha256": strings.Repeat("a", 64), "error": nil}
	page := contentPage()
	page["resources"] = []any{resource}
	chunk := map[string]any{"kind": "resource", "resource": resource, "offset": "0", "data": "YQ==", "eof": true}
	for _, input := range []any{page, chunk} {
		raw, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := DecodeContentResult(raw)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(decoded)
		if err != nil {
			t.Fatal(err)
		}
		again, err := DecodeContentResult(encoded)
		if err != nil || again.Kind != decoded.Kind {
			t.Fatalf("content roundtrip: %#v %v", again, err)
		}
	}
	if _, err := json.Marshal(ContentResult{Kind: "unexpected"}); err == nil {
		t.Fatal("unknown content result was encoded")
	}
	for _, invalid := range []string{`{`, `[]`, `null`, `{"kind":"unexpected"}`, `{"kind":"timeline"}`, `{"kind":false}`} {
		if _, err := DecodeContentResult([]byte(invalid)); err == nil {
			t.Fatalf("invalid local content accepted: %s", invalid)
		}
	}
	page["resources"] = []any{resource, resource}
	raw, _ := json.Marshal(page)
	if _, err := DecodeContentResult(raw); err == nil {
		t.Fatal("duplicate resource descriptors accepted")
	}
	page["resources"] = []any{}
	page["items"] = []any{
		map[string]any{"entryId": relayID, "entrySeq": "2", "revision": "1", "kind": "reasoning", "text": "newer"},
		map[string]any{"entryId": "00000000-0000-4000-8000-000000000099", "entrySeq": "1", "revision": "1", "kind": "reasoning", "text": "older"},
	}
	raw, _ = json.Marshal(page)
	if _, err := DecodeContentResult(raw); err == nil {
		t.Fatal("descending local timeline accepted")
	}
	chunk["data"] = 1
	raw, _ = json.Marshal(chunk)
	if _, err := DecodeContentResult(raw); err == nil {
		t.Fatal("non-string resource chunk accepted")
	}
}
