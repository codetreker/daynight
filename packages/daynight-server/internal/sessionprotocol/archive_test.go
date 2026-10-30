package sessionprotocol

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func archiveFixture() map[string]any {
	return map[string]any{"schemaVersion": 1, "sessionId": "11111111-1111-1111-1111-111111111111", "claimId": "22222222-2222-2222-2222-222222222222", "executionGeneration": "1", "controllerId": "33333333-3333-3333-3333-333333333333", "controllerInstanceId": "44444444-4444-4444-4444-444444444444", "provider": "codex", "nativeSessionId": nil, "entries": []any{map[string]any{"entryId": "55555555-5555-5555-5555-555555555555", "entrySeq": "1", "revision": "1", "kind": "assistant_message", "content": []any{map[string]any{"type": "text", "text": "Archived reply"}}}}, "resources": []any{}}
}
func TestDecodeArchive(t *testing.T) {
	for _, provider := range []string{"codex", "claude", "copilot"} {
		v := archiveFixture()
		v["provider"] = provider
		b, _ := json.Marshal(v)
		out, err := DecodeArchive(b)
		if err != nil || len(out.Entries) != 1 || out.Entries[0].Data["content"] == nil {
			t.Fatal(out, err)
		}
		delete(v, "claimId")
		v["testExecutionId"] = "22222222-2222-2222-2222-222222222222"
		b, _ = json.Marshal(v)
		if _, err = DecodeArchive(b); err != nil {
			t.Fatal(err)
		}
	}
	for name, mutate := range map[string]func(map[string]any){
		"unknown":         func(v map[string]any) { v["extra"] = true },
		"both bindings":   func(v map[string]any) { v["testExecutionId"] = v["claimId"] },
		"null array":      func(v map[string]any) { v["entries"] = nil },
		"duplicate entry": func(v map[string]any) { a := v["entries"].([]any); v["entries"] = append(a, a[0]) },
		"missing resource": func(v map[string]any) {
			v["entries"].([]any)[0].(map[string]any)["content"] = []any{map[string]any{"type": "resource", "resourceId": "66666666-6666-6666-6666-666666666666", "label": "file"}}
		},
		"bad entry": func(v map[string]any) { v["entries"].([]any)[0].(map[string]any)["kind"] = "unknown" },
	} {
		t.Run(name, func(t *testing.T) {
			v := archiveFixture()
			mutate(v)
			b, _ := json.Marshal(v)
			if _, err := DecodeArchive(b); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	if _, err := DecodeArchive([]byte(strings.Repeat(" ", MaxArchiveBytes+1))); err == nil {
		t.Fatal("oversize accepted")
	}
}
func TestArchiveResources(t *testing.T) {
	sum := sha256.Sum256([]byte("hello"))
	digest := hex.EncodeToString(sum[:])
	for _, test := range []struct {
		name   string
		mutate func(map[string]any)
		valid  bool
	}{
		{"available", func(map[string]any) {}, true},
		{"bad hash", func(r map[string]any) { r["resource"].(map[string]any)["sha256"] = strings.Repeat("0", 64) }, false},
		{"bad length", func(r map[string]any) { r["resource"].(map[string]any)["byteLength"] = "4" }, false},
		{"base64 newline", func(r map[string]any) { r["data"] = "aGVs\nbG8=" }, false},
		{"base64 malformed", func(r map[string]any) { r["data"] = "!" }, false},
		{"missing data", func(r map[string]any) { r["data"] = nil }, false},
		{"pending", func(r map[string]any) { r["resource"].(map[string]any)["status"] = "pending" }, false},
		{"unavailable", func(r map[string]any) { r["resource"].(map[string]any)["status"] = "unavailable"; r["data"] = nil }, true},
		{"unavailable data", func(r map[string]any) { r["resource"].(map[string]any)["status"] = "unavailable" }, false},
		{"bad resource", func(r map[string]any) { r["resource"] = nil }, false},
		{"extra", func(r map[string]any) { r["extra"] = true }, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			v := archiveFixture()
			r := map[string]any{"resource": map[string]any{"resourceId": "66666666-6666-6666-6666-666666666666", "status": "available", "name": "file", "mediaType": "text/plain", "sha256": digest, "byteLength": "5", "error": nil}, "data": base64.StdEncoding.EncodeToString([]byte("hello"))}
			test.mutate(r)
			v["resources"] = []any{r}
			b, _ := json.Marshal(v)
			_, err := DecodeArchive(b)
			if (err == nil) != test.valid {
				t.Fatal(err)
			}
		})
	}
}
func TestArchiveUpdateValidation(t *testing.T) {
	v := archiveFixture()
	for _, k := range []string{"schemaVersion", "provider", "nativeSessionId", "entries", "resources"} {
		delete(v, k)
	}
	for _, test := range []struct {
		state string
		code  any
		valid bool
	}{{"pending", nil, true}, {"failed", "upload_failed", true}, {"failed", "archive_incomplete", true}, {"failed", nil, true}, {"pending", "upload_failed", false}, {"ready", nil, false}, {"failed", "Bad Code", false}} {
		v["state"] = test.state
		v["errorCode"] = test.code
		b, _ := json.Marshal(v)
		_, err := DecodeArchiveUpdate(b)
		if (err == nil) != test.valid {
			t.Fatalf("%#v %v", test, err)
		}
	}
}
