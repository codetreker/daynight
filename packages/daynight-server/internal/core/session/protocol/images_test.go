package sessionprotocol

import (
	"encoding/json"
	"strings"
	"testing"
)

func imageSpecBytes() []byte {
	return []byte(`{"uploadId":"11111111-1111-4111-8111-111111111111","imageId":"22222222-2222-4222-8222-222222222222","target":{"serverOrigin":"https://daynight.cc","actorUserId":"33333333-3333-4333-8333-333333333333","fence":{"sessionId":"44444444-4444-4444-8444-444444444444","testExecutionId":"55555555-5555-4555-8555-555555555555","executionGeneration":"1"},"expectedNativeSessionId":null},"name":"image.png","mediaType":"image/png","byteLength":"10485760","sha256":"` + strings.Repeat("a", 64) + `"}`)
}

func TestUploadSpecIsStrictAndSupportsTenMiB(t *testing.T) {
	if _, err := DecodeImageUploadSpec(imageSpecBytes()); err != nil {
		t.Fatal(err)
	}
	for _, change := range [][2]string{{`"byteLength":"10485760"`, `"byteLength":"10485761"`}, {`"byteLength":"10485760"`, `"byteLength":"010485760"`}, {`"mediaType":"image/png"`, `"mediaType":"image/svg+xml"`}, {`"name":"image.png"`, `"name":"image.png","extra":1`}, {`"expectedNativeSessionId":null`, `"expectedNativeSessionId":null,"expectedNativeSessionId":"other"`}, {`"serverOrigin":"https://daynight.cc"`, `"serverOrigin":"https://daynight.cc/path"`}} {
		if _, err := DecodeImageUploadSpec([]byte(strings.Replace(string(imageSpecBytes()), change[0], change[1], 1))); err == nil {
			t.Errorf("accepted %v", change)
		}
	}
}

func TestImageIntentPreservesOrderAndCanonicalUnicode(t *testing.T) {
	var spec ImageUploadSpec
	if err := json.Unmarshal(imageSpecBytes(), &spec); err != nil {
		t.Fatal(err)
	}
	value := map[string]any{"z": "中文<\u2028>", "a": []any{map[string]any{"b": 1, "a": nil}, 2}}
	bytes, err := CanonicalImageJSON(value)
	if err != nil || string(bytes) != "{\"a\":[{\"a\":null,\"b\":1},2],\"z\":\"中文<\u2028>\"}" {
		t.Fatalf("canonical=%q err=%v", bytes, err)
	}
	if _, err := CanonicalImageJSON(map[string]any{"value": 1.25}); err == nil {
		t.Fatal("canonical intent accepted fractional number")
	}
}
