package sessionprotocol

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func mediaFrame(t *testing.T, typ, action string, body, result any, remote *ImageError) []byte {
	t.Helper()
	value := map[string]any{"protocol": Protocol, "type": typ, "sessionId": uuid.NewString(), "testExecutionId": uuid.NewString(), "executionGeneration": "1", "connectionEpoch": "1", "requestId": uuid.NewString(), "action": action}
	if typ == "image_request" || typ == "image_capture" {
		value["body"] = body
	} else {
		value["result"], value["error"] = result, remote
	}
	raw, e := json.Marshal(value)
	if e != nil {
		t.Fatal(e)
	}
	return raw
}
func TestImageMediaFramesValidateEveryActionAndOriginalChunkBoundary(t *testing.T) {
	var spec ImageUploadSpec
	if e := json.Unmarshal(imageSpecBytes(), &spec); e != nil {
		t.Fatal(e)
	}
	capture, attempt, resource := uuid.NewString(), uuid.NewString(), uuid.NewString()
	metadata := ValidatedImage{MediaType: "image/png", ByteLength: "3", SHA256: spec.SHA256, Width: 2, Height: 3, FrameCount: 1}
	preparation := LocalImagePreparation{UploadID: spec.UploadID, ImageID: spec.ImageID, Target: spec.Target, State: "receiving", AcceptedOffset: "0"}
	chunk := PreparedImageChunk{PreparationID: attempt, SHA256: metadata.SHA256, ByteLength: "3", Offset: "0", Data: "cG5n", EOF: true}
	read := ImageReadChunk{ResourceID: resource, SHA256: metadata.SHA256, ByteLength: "3", Offset: "0", Data: "cG5n", EOF: true}
	for _, tc := range []struct {
		action       string
		body, result any
	}{
		{"prepare", spec, preparation},
		{"write", map[string]any{"uploadId": spec.UploadID, "offset": "0", "sha256": spec.SHA256, "data": "cG5n"}, preparation},
		{"complete", map[string]any{"uploadId": spec.UploadID, "sha256": spec.SHA256, "byteLength": spec.ByteLength}, preparation},
		{"status", map[string]any{"uploadId": spec.UploadID}, preparation},
		{"release", map[string]any{"uploadId": spec.UploadID}, preparation},
		{"read_prepared", map[string]any{"preparationId": attempt, "offset": "0", "limit": 3}, chunk},
		{"read_capture", map[string]any{"captureId": capture, "attemptId": attempt, "sha256": spec.SHA256, "byteLength": "3", "offset": "0", "limit": 3}, chunk},
		{"retry_capture", map[string]any{"captureId": capture, "attemptId": attempt}, metadata},
		{"read", ImageReadRequest{ResourceID: resource, Offset: "0", Limit: 3}, read},
	} {
		t.Run(tc.action, func(t *testing.T) {
			for _, typ := range []string{"image_request", "image_response"} {
				frame := mediaFrame(t, typ, tc.action, tc.body, tc.result, nil)
				got, e := DecodeImageMedia(frame)
				if e != nil || got.Action != tc.action {
					t.Fatal("valid media frame rejected", string(frame), e)
				}
				if typ == "image_response" {
					controller, e := DecodeController(frame)
					if e != nil || controller.Action != tc.action || !json.Valid(controller.MediaResult) {
						t.Fatal("controller image response lost result", controller, e)
					}
				}
			}
			if _, e := DecodeImageMedia(mediaFrame(t, "image_request", tc.action, map[string]any{"unexpected": true}, nil, nil)); e == nil {
				t.Fatal("invalid action body accepted")
			}
			if _, e := DecodeImageMedia(mediaFrame(t, "image_response", tc.action, nil, map[string]any{"unexpected": true}, nil)); e == nil {
				t.Fatal("invalid action result accepted")
			}
		})
	}
	for _, change := range []struct {
		data, offset, size string
		eof                bool
	}{
		{"cG5n=", "0", "3", true}, {"cG5n", "1", "3", true}, {"cG5n", "0", "3", false}, {"", "0", "3", false}, {strings.Repeat("a", 699053), "0", "3", true},
	} {
		invalid := chunk
		invalid.Data, invalid.Offset, invalid.ByteLength, invalid.EOF = change.data, change.offset, change.size, change.eof
		if _, e := DecodeImageMedia(mediaFrame(t, "image_response", "read_capture", nil, invalid, nil)); e == nil {
			t.Fatal("invalid original chunk accepted", change.offset, change.size)
		}
	}
	body := map[string]any{"captureId": capture, "attemptId": attempt, "sha256": spec.SHA256, "byteLength": "3", "offset": "3", "limit": 3}
	if _, e := DecodeImageMedia(mediaFrame(t, "image_request", "read_capture", body, nil, nil)); e == nil {
		t.Fatal("EOF offset accepted as source request")
	}
	if _, e := DecodeImageMedia(mediaFrame(t, "image_request", "register", body, nil, nil)); e == nil {
		t.Fatal("capture action admitted as media request")
	}
	remote := &ImageError{Code: "rate_limited", Message: "Controller capacity is unavailable."}
	if _, e := DecodeImageMedia(mediaFrame(t, "image_response", "complete", nil, nil, remote)); e != nil {
		t.Fatal(e)
	}
	if _, e := DecodeImageMedia(mediaFrame(t, "image_response", "complete", nil, nil, nil)); e == nil {
		t.Fatal("absent media outcome accepted")
	}
	if _, e := DecodeImageMedia(mediaFrame(t, "image_response", "complete", nil, preparation, remote)); e == nil {
		t.Fatal("both result and error accepted")
	}
}
func TestImageCaptureFramesRequireCurrentAttemptAndCoherentReceipt(t *testing.T) {
	var spec ImageUploadSpec
	_ = json.Unmarshal(imageSpecBytes(), &spec)
	c := ImageCaptureRequest{CaptureID: uuid.NewString(), AttemptID: uuid.NewString(), Occurrence: ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "content", SourceKey: "original"}, Locator: ImageLocator{Kind: "external", URL: "https://images.example/image.png"}}
	resource := uuid.NewString()
	receipt := ImageCaptureReceipt{CaptureID: c.CaptureID, AttemptID: c.AttemptID, Revision: "1", Occurrence: c.Occurrence, State: "reserved", ResourceID: &resource}
	metadata := ValidatedImage{MediaType: "image/png", ByteLength: "3", SHA256: spec.SHA256, Width: 2, Height: 3, FrameCount: 1}
	remote := ImageError{Code: "invalid_image", Message: "Rejected original."}
	for _, tc := range []struct {
		action string
		body   any
	}{
		{"register", c}, {"query", map[string]any{"captureId": c.CaptureID}},
		{"commit", ImageCaptureCommit{CaptureID: c.CaptureID, AttemptID: c.AttemptID, Validated: metadata}},
		{"failed", map[string]any{"captureId": c.CaptureID, "attemptId": c.AttemptID, "error": remote}},
	} {
		frame := mediaFrame(t, "image_capture", tc.action, tc.body, nil, nil)
		if _, e := DecodeController(frame); e != nil {
			t.Fatal("capture action rejected", tc.action, e)
		}
		if _, e := DecodeImageMedia(mediaFrame(t, "image_capture_result", tc.action, nil, receipt, nil)); e != nil {
			t.Fatal("capture receipt rejected", tc.action, e)
		}
	}
	if _, e := DecodeImageMedia(mediaFrame(t, "image_capture", "retry_capture", map[string]any{"captureId": c.CaptureID}, nil, nil)); e == nil {
		t.Fatal("reverse source retry action accepted")
	}
	for _, state := range []string{"reserved", "copying", "committed", "failed"} {
		current := receipt
		current.State = state
		if state == "committed" {
			size, digest, media := "3", spec.SHA256, "image/png"
			w, h, frames := 2, 3, 1
			current.Resource = &Resource{Revision: "1", ResourceID: resource, Status: "available", Name: "original.png", MediaType: &media, ByteLength: &size, SHA256: &digest, Width: &w, Height: &h, FrameCount: &frames}
		}
		if state == "failed" {
			current.ResourceID = nil
			current.Error = &remote
		}
		if _, e := DecodeImageMedia(mediaFrame(t, "image_capture_result", "query", nil, current, nil)); e != nil {
			t.Fatal("valid capture state rejected", state, e)
		}
		current.Error = &remote
		if state == "failed" {
			current.ResourceID = &resource
		}
		if _, e := DecodeImageMedia(mediaFrame(t, "image_capture_result", "query", nil, current, nil)); e == nil {
			t.Fatal("incoherent capture receipt accepted", state)
		}
	}
	missingAttempt := map[string]any{"captureId": c.CaptureID, "validated": metadata}
	if _, e := DecodeImageMedia(mediaFrame(t, "image_capture", "commit", missingAttempt, nil, nil)); e == nil {
		t.Fatal("unfenced capture completion accepted")
	}
	if _, e := DecodeController(mediaFrame(t, "image_capture", "register", map[string]any{}, nil, nil)); e == nil {
		t.Fatal("invalid capture reached controller")
	}
	if _, e := DecodeImageTarget(mustMediaJSON(t, spec.Target)); e != nil {
		t.Fatal(e)
	}
}
func mustMediaJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return raw
}

func TestImagePublicDecodersPreserveDisplayFormatsAndRejectUnboundLocators(t *testing.T) {
	var spec ImageUploadSpec
	_ = json.Unmarshal(imageSpecBytes(), &spec)
	for _, media := range []string{"image/gif", "image/avif"} {
		spec.MediaType = media
		if _, e := DecodeImageDisplayUploadSpec(mustMediaJSON(t, spec)); e != nil {
			t.Fatal("display-only original rejected", media, e)
		}
		if _, e := DecodeImageUploadSpec(mustMediaJSON(t, spec)); e == nil {
			t.Fatal("display-only format admitted as provider input", media)
		}
	}
	metadata := ValidatedImage{MediaType: "image/png", ByteLength: "3", SHA256: spec.SHA256, Width: 2, Height: 3, FrameCount: 1}
	if got, e := DecodeValidatedImage(mustMediaJSON(t, metadata)); e != nil || got != metadata {
		t.Fatal(got, e)
	}
	if _, e := DecodeImageUploadComplete(mustMediaJSON(t, ImageUploadComplete{SHA256: spec.SHA256, ByteLength: "3"})); e != nil {
		t.Fatal(e)
	}
	for _, locator := range []ImageLocator{
		{Kind: "native", Provider: "codex", NativeSessionID: "native", NativeMessageID: "message", NativePartID: "part"},
		{Kind: "local", Path: "/original.png", ContextID: uuid.NewString()},
		{Kind: "resource", ResourceID: uuid.NewString()},
		{Kind: "external", URL: "https://images.example/original.png"},
	} {
		request := ImageCaptureRequest{CaptureID: uuid.NewString(), AttemptID: uuid.NewString(), Occurrence: ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "content", SourceKey: "original"}, Locator: locator}
		if _, e := DecodeImageCaptureRequest(mustMediaJSON(t, request)); e != nil {
			t.Fatal(locator.Kind, e)
		}
		request.Occurrence.SourceKey = "bad\nlabel"
		if _, e := DecodeImageCaptureRequest(mustMediaJSON(t, request)); e == nil {
			t.Fatal("control character entered an image source label")
		}
	}
}

func TestImageSnapshotBudgetIncludesCommittedAndReservedUse(t *testing.T) {
	snapshot := relayObject(t, commandFixture(t, "snapshot"))
	snapshot["contentRevision"] = 2
	budget := map[string]any{"revision": "1", "maxBytes": "100", "committedBytes": "40", "reservedBytes": "60", "maxResources": 2, "committedResources": 1, "reservedResources": 1}
	snapshot["imageBudget"] = budget
	reason := "profile_disabled"
	snapshot["capabilities"].(map[string]any)["images"] = ImageCapabilities{Revision: "1", ProviderRevision: "1", Send: "unsupported", Steer: "unsupported", ReasonCode: &reason, InputMediaTypes: []string{}, MaxImageBytes: "0", MaxMessageImageBytes: "0", Geometry: ImageGeometry{Version: 1}}
	if _, e := DecodeSnapshot(relayJSON(t, snapshot)); e != nil {
		t.Fatal("fully reserved budget rejected", e)
	}
	for _, field := range []string{"reservedBytes", "reservedResources"} {
		old := budget[field]
		if field == "reservedBytes" {
			budget[field] = "61"
		} else {
			budget[field] = 2
		}
		if _, e := DecodeSnapshot(relayJSON(t, snapshot)); e == nil {
			t.Fatal("combined resource budget overflow accepted", field)
		}
		budget[field] = old
	}
	budget["reservedBytes"] = "01"
	if _, e := DecodeSnapshot(relayJSON(t, snapshot)); e == nil {
		t.Fatal("noncanonical budget decimal accepted")
	}
}

func TestImageMarkdownPartRoundTripRetainsSourceBindings(t *testing.T) {
	text := "![original](image.png)"
	digest := sha256.Sum256([]byte(text))
	image := uuid.NewString()
	part := map[string]any{"type": "markdown", "text": text, "partId": uuid.NewString(), "revision": "2", "textSha256": hex.EncodeToString(digest[:]), "complete": true, "truncated": false, "bindings": []any{}, "retainedImages": []any{map[string]any{"imageId": image, "start": 0, "end": len(text), "sourceRevision": "1", "sourceTextSha256": strings.Repeat("a", 64), "linkHref": "https://images.example/original", "part": map[string]any{"type": "image_unavailable", "imageId": image, "label": "original", "error": ImageError{Code: "source_unavailable", Message: "Original unavailable."}}}}}
	entry := relayTimeline("assistant_message", map[string]any{"content": []any{part}})
	entry["imageProjectionError"] = nil
	if _, e := DecodeTimeline(relayJSON(t, entry)); e != nil {
		t.Fatal("retained markdown source rejected", e)
	}
	retained := part["retainedImages"].([]any)[0].(map[string]any)
	retained["linkHref"] = "https://user:password@images.example/original"
	if _, e := DecodeTimeline(relayJSON(t, entry)); e == nil {
		t.Fatal("retained image source URL accepted credentials")
	}
	for _, value := range []TextPart{{Type: "text", Text: ""}, {Type: "image_unavailable", Text: ""}} {
		raw, e := json.Marshal(value)
		if e != nil || !json.Valid(raw) || value.Type == "text" && !strings.Contains(string(raw), `"text":""`) {
			t.Fatal("text part wire shape changed", string(raw), e)
		}
	}
}
