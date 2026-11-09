package sessionprotocol

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/google/uuid"
	"testing"
)

func TestImageMarkdownChecksOriginalHashAndUTF16Boundaries(t *testing.T) {
	text := "A😀B"
	hash := sha256.Sum256([]byte(text))
	imageID := uuid.NewString()
	binding := map[string]any{"imageId": imageID, "start": 1, "end": 3, "part": map[string]any{"type": "image_unavailable", "imageId": imageID, "label": "image", "error": map[string]any{"code": "source_unavailable", "message": "Source unavailable."}}}
	value := map[string]any{"partId": uuid.NewString(), "revision": "1", "textSha256": hex.EncodeToString(hash[:]), "complete": true, "truncated": false, "bindings": []any{binding}, "retainedImages": []any{}}
	check := func(want bool) {
		t.Helper()
		raw, _ := json.Marshal(value)
		if validateMarkdown(raw, text, false) != want {
			t.Fatalf("valid=%v %s", want, raw)
		}
	}
	check(true)
	binding["end"] = 2
	check(false)
	binding["end"] = 3
	binding["start"] = 2
	check(false)
	binding["start"] = 1
	value["textSha256"] = hex.EncodeToString(make([]byte, 32))
	check(false)
	value["textSha256"] = hex.EncodeToString(hash[:])
	value["complete"] = false
	check(false)
	value["complete"] = true
	value["bindings"] = nil
	check(false)
	raw, _ := json.Marshal(value)
	if !validateMarkdown(raw, text, true) {
		t.Fatal("projection failure cannot represent unknown bindings")
	}
}
