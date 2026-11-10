package sessionprotocol

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestRevisionedResourcePublicationRequiresCompleteImageMetadata(t *testing.T) {
	base := map[string]any{"resourceId": uuid.NewString(), "revision": "1", "status": "available", "name": "image.png", "mediaType": "image/png", "byteLength": "1", "sha256": strings.Repeat("a", 64), "width": 1, "height": 1, "frameCount": 1, "error": nil}
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
		valid  bool
	}{
		{"complete", func(map[string]any) {}, true},
		{"zero bytes", func(v map[string]any) { v["byteLength"] = "0" }, false},
		{"oversized", func(v map[string]any) { v["byteLength"] = "10485761" }, false},
		{"unsafe image format", func(v map[string]any) { v["mediaType"] = "image/svg+xml" }, false},
		{"nonimage geometry", func(v map[string]any) { v["mediaType"] = "text/plain" }, false},
		{"missing width", func(v map[string]any) { delete(v, "width") }, false},
		{"decoded pixel limit", func(v map[string]any) { v["width"], v["height"] = 16384, 16384 }, false},
		{"control label", func(v map[string]any) { v["name"] = "image\n.png" }, false},
		{"empty label", func(v map[string]any) { v["name"] = "" }, false},
		{"partial geometry on legacy record", func(v map[string]any) { delete(v, "revision"); delete(v, "height") }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := relayObject(t, relayJSON(t, base))
			tc.change(v)
			_, err := DecodeResource(relayJSON(t, v))
			if (err == nil) != tc.valid {
				t.Fatalf("resource admission = %v, want valid=%v", err, tc.valid)
			}
		})
	}
	for _, state := range []string{"pending", "failed", "unavailable"} {
		t.Run(state, func(t *testing.T) {
			v := map[string]any{"resourceId": base["resourceId"], "revision": "2", "status": state, "name": "image.png", "mediaType": nil, "byteLength": nil, "sha256": nil, "width": nil, "height": nil, "frameCount": nil, "error": nil}
			if state != "pending" {
				v["error"] = "Source unavailable."
			}
			if _, err := DecodeResource(relayJSON(t, v)); err != nil {
				t.Fatal(err)
			}
			v["sha256"] = base["sha256"]
			if _, err := DecodeResource(relayJSON(t, v)); err == nil {
				t.Fatal("unpublished resource leaked immutable metadata")
			}
			v["sha256"] = nil
			if state == "pending" {
				v["error"] = "failure"
			} else {
				v["error"] = nil
			}
			if _, err := DecodeResource(relayJSON(t, v)); err == nil {
				t.Fatal("resource state accepted inconsistent error")
			}
		})
	}
}

func TestImageMessageAdmissionRejectsWholeInvalidGroup(t *testing.T) {
	var spec ImageUploadSpec
	if err := json.Unmarshal(imageSpecBytes(), &spec); err != nil {
		t.Fatal(err)
	}
	image := func() map[string]any {
		return map[string]any{"type": "image", "imageId": uuid.NewString(), "uploadId": uuid.NewString(), "resourceId": uuid.NewString(), "sha256": spec.SHA256, "byteLength": "10485760"}
	}
	base := func() map[string]any {
		return map[string]any{"content": []any{image()}, "expectedTurnId": nil, "target": spec.Target, "draftId": uuid.NewString(), "draftRevision": "1", "expectedImageCapabilityRevision": "1"}
	}
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
		valid  bool
	}{
		{"image only", func(map[string]any) {}, true},
		{"two images at total limit", func(v map[string]any) { v["content"] = []any{image(), image()} }, true},
		{"missing content", func(v map[string]any) { delete(v, "content") }, false},
		{"empty content", func(v map[string]any) { v["content"] = []any{} }, false},
		{"text only", func(v map[string]any) { v["content"] = []any{map[string]any{"type": "text", "text": "hello"}} }, false},
		{"text after image", func(v map[string]any) { v["content"] = []any{image(), map[string]any{"type": "text", "text": "hello"}} }, false},
		{"invalid image descriptor", func(v map[string]any) { p := image(); p["sha256"] = "bad"; v["content"] = []any{p} }, false},
		{"duplicate image", func(v map[string]any) {
			a, b := image(), image()
			b["imageId"] = a["imageId"]
			v["content"] = []any{a, b}
		}, false},
		{"duplicate upload", func(v map[string]any) {
			a, b := image(), image()
			b["uploadId"] = a["uploadId"]
			v["content"] = []any{a, b}
		}, false},
		{"total bytes exceeded", func(v map[string]any) { v["content"] = []any{image(), image(), image()} }, false},
		{"image count exceeded", func(v map[string]any) {
			p := []any{}
			for range 9 {
				a := image()
				a["byteLength"] = "1"
				p = append(p, a)
			}
			v["content"] = p
		}, false},
		{"part count exceeded", func(v map[string]any) {
			p := []any{}
			for range 10 {
				p = append(p, image())
			}
			v["content"] = p
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := base()
			tc.change(v)
			err := validateImageSend(relayJSON(t, v))
			if (err == nil) != tc.valid {
				t.Fatalf("admission=%v want valid=%v", err, tc.valid)
			}
		})
	}
}

func TestImageCaptureLocatorAndGeometryBoundaries(t *testing.T) {
	for _, tc := range []struct {
		value any
		valid bool
	}{
		{false, false}, {map[string]any{"kind": "unknown"}, false},
		{map[string]any{"kind": "external", "url": "https://images.example/image.png"}, true},
		{map[string]any{"kind": "external", "url": "https://user:password@images.example/image.png"}, false},
		{map[string]any{"kind": "external", "url": "file:///image.png"}, false},
		{map[string]any{"kind": "external", "url": ""}, false},
		{map[string]any{"kind": "external", "url": "%"}, false},
		{map[string]any{"kind": "native", "provider": "codex", "nativeSessionId": "native", "nativeMessageId": "message", "nativePartId": "part"}, true},
		{map[string]any{"kind": "local", "path": "image.png", "contextId": uuid.NewString()}, true},
	} {
		if got := validateLocator(relayJSON(t, tc.value)); got != tc.valid {
			t.Fatalf("locator %v got %v", tc.value, got)
		}
	}
	for _, tc := range []struct {
		value any
		valid bool
	}{
		{nil, false},
		{ImageGeometry{Version: 1}, true},
		{ImageGeometry{Version: 1, MaxWidth: 1}, false},
		{ImageGeometry{Version: 1, Known: true, MaxWidth: 1, MaxHeight: 1, MaxPixels: 1, MaxFrames: 1}, true},
		{ImageGeometry{Version: 1, Known: true, MaxWidth: 1, MaxHeight: 1, MaxPixels: 1}, false},
	} {
		if got := validateImageGeometry(relayJSON(t, tc.value)); got != tc.valid {
			t.Fatalf("geometry %v got %v", tc.value, got)
		}
	}
}

func TestProjectionFailurePreservesReadableTextWithoutInventingBindings(t *testing.T) {
	text := "source"
	hash := sha256.Sum256([]byte(text))
	markdown := func() map[string]any {
		return map[string]any{"partId": uuid.NewString(), "revision": "1", "textSha256": hex.EncodeToString(hash[:]), "complete": true, "truncated": false, "bindings": nil, "retainedImages": []any{}}
	}
	entry := relayTimeline("reasoning", map[string]any{"text": text, "markdown": markdown()})
	entry["imageProjectionError"] = ImageError{Code: "source_unavailable", Message: "Source unavailable."}
	if _, err := DecodeTimeline(relayJSON(t, entry)); err != nil {
		t.Fatal(err)
	}
	entry["imageProjectionError"] = nil
	if _, err := DecodeTimeline(relayJSON(t, entry)); err == nil {
		t.Fatal("unknown reasoning bindings accepted without source failure")
	}
	entry["imageProjectionError"] = ImageError{Code: "other", Message: "Wrong failure."}
	if _, err := DecodeTimeline(relayJSON(t, entry)); err == nil {
		t.Fatal("unrelated error accepted as projection failure")
	}
	for _, kind := range []string{"user_message", "assistant_message", "tool_call"} {
		field := "content"
		extra := map[string]any{}
		if kind == "tool_call" {
			field = "output"
			extra = map[string]any{"callId": "call", "name": "tool", "input": "", "status": "completed", "truncated": false}
		}
		emptyHash := sha256.Sum256(nil)
		part := map[string]any{"type": "markdown", "text": "", "partId": uuid.NewString(), "revision": "1", "textSha256": hex.EncodeToString(emptyHash[:]), "complete": true, "truncated": false, "bindings": []any{}, "retainedImages": []any{}}
		extra[field] = []any{map[string]any{"type": "text", "text": text}, part}
		v := relayTimeline(kind, extra)
		v["imageProjectionError"] = ImageError{Code: "source_unavailable", Message: "Source unavailable."}
		if _, err := DecodeTimeline(relayJSON(t, v)); err != nil {
			t.Fatal(kind, err)
		}
		extra[field] = []any{part}
		v = relayTimeline(kind, extra)
		v["imageProjectionError"] = ImageError{Code: "source_unavailable", Message: "Source unavailable."}
		if _, err := DecodeTimeline(relayJSON(t, v)); err == nil {
			t.Fatal("projection failure discarded readable text", kind)
		}
	}
	image := map[string]any{"type": "image", "imageId": uuid.NewString(), "resourceId": uuid.NewString(), "label": "image"}
	duplicate := relayTimeline("assistant_message", map[string]any{"content": []any{image, image}})
	duplicate["imageProjectionError"] = nil
	if _, err := DecodeTimeline(relayJSON(t, duplicate)); err == nil {
		t.Fatal("duplicate occurrence accepted")
	}
	unsupported := relayTimeline("error", map[string]any{"code": "error", "message": "error"})
	unsupported["imageProjectionError"] = nil
	if _, err := DecodeTimeline(relayJSON(t, unsupported)); err == nil {
		t.Fatal("projection metadata accepted on unsupported entry")
	}
}
