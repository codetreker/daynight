package sessionprotocol

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func directContent(t *testing.T, data []byte) DirectImageContent {
	t.Helper()
	var spec ImageUploadSpec
	if err := json.Unmarshal(imageSpecBytes(), &spec); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	return DirectImageContent{Spec: spec, Offset: "0", SHA256: hex.EncodeToString(sum[:]), Data: base64.StdEncoding.EncodeToString(data)}
}

func TestDirectImageContentValidatesActualFirstChunk(t *testing.T) {
	for _, size := range []int{1, MaxContentChunkBytes} {
		input := directContent(t, make([]byte, size))
		input.Spec.ByteLength = strconv.Itoa(size)
		raw := mustMediaJSON(t, input)
		got, err := DecodeDirectImageContent(raw)
		if err != nil || got != input {
			t.Fatalf("size %d: got %#v, error %v", size, got, err)
		}
	}
	for _, tc := range []struct {
		name string
		edit func(*DirectImageContent)
	}{
		{"empty", func(v *DirectImageContent) { v.Data = "" }},
		{"oversized", func(v *DirectImageContent) { *v = directContent(t, make([]byte, MaxContentChunkBytes+1)) }},
		{"exceeds declared length", func(v *DirectImageContent) { v.Spec.ByteLength = "1" }},
		{"nonzero offset", func(v *DirectImageContent) { v.Offset = "1" }},
		{"wrong digest", func(v *DirectImageContent) { v.SHA256 = strings.Repeat("a", 64) }},
		{"noncanonical base64", func(v *DirectImageContent) { v.Data = "YWJj\n" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := directContent(t, []byte("abc"))
			tc.edit(&input)
			if _, err := DecodeDirectImageContent(mustMediaJSON(t, input)); err == nil {
				t.Fatal("invalid first chunk accepted")
			}
		})
	}
	raw := string(mustMediaJSON(t, directContent(t, []byte("abc"))))
	for _, bad := range []string{
		strings.Replace(raw, `"offset":"0"`, `"offset":"0","extra":1`, 1),
		strings.Replace(raw, `"offset":"0"`, `"offset":"0","offset":"0"`, 1),
	} {
		if _, err := DecodeDirectImageContent([]byte(bad)); err == nil {
			t.Fatal("unknown or duplicate field accepted")
		}
	}
}

func TestDirectCaptureSubmissionStrictVariantsAndFrames(t *testing.T) {
	request := ImageCaptureRequest{CaptureID: uuid.NewString(), AttemptID: uuid.NewString(), Occurrence: ImageOccurrence{ImageID: uuid.NewString(), EntryID: uuid.NewString(), Container: "content", SourceKey: "original"}, Locator: ImageLocator{Kind: "external", URL: "https://images.example/image.png"}}
	validated := ValidatedImage{MediaType: "image/png", ByteLength: "3", SHA256: strings.Repeat("a", 64), Width: 2, Height: 3, FrameCount: 1}
	failure := ImageError{Code: "invalid_image", Message: "Rejected original."}
	for _, outcome := range []DirectCaptureOutcome{{Kind: "validated", Validated: &validated}, {Kind: "resource"}, {Kind: "failed", Error: &failure}} {
		// A later attempt differs from the original request; Core resolves it against the receipt.
		submission := DirectCaptureSubmission{Request: request, AttemptID: uuid.NewString(), Outcome: outcome}
		if _, err := DecodeDirectCaptureSubmission(mustMediaJSON(t, submission)); err != nil {
			t.Fatalf("%s submission rejected: %v", outcome.Kind, err)
		}
		if _, err := DecodeController(mediaFrame(t, "image_capture", "submit", submission, nil, nil)); err != nil {
			t.Fatalf("%s frame rejected: %v", outcome.Kind, err)
		}
	}
	resource := uuid.NewString()
	receipt := ImageCaptureReceipt{CaptureID: request.CaptureID, AttemptID: request.AttemptID, Revision: "1", Occurrence: request.Occurrence, State: "copying", ResourceID: &resource}
	if _, err := DecodeImageMedia(mediaFrame(t, "image_capture_result", "submit", nil, receipt, nil)); err != nil {
		t.Fatal("submit receipt rejected", err)
	}
	for _, outcome := range []any{
		map[string]any{"kind": "validated"},
		map[string]any{"kind": "validated", "validated": validated, "error": failure},
		map[string]any{"kind": "resource", "validated": validated},
		map[string]any{"kind": "failed", "error": failure, "extra": true},
		map[string]any{"kind": "unknown"},
	} {
		body := map[string]any{"request": request, "attemptId": request.AttemptID, "outcome": outcome}
		if _, err := DecodeController(mediaFrame(t, "image_capture", "submit", body, nil, nil)); err == nil {
			t.Fatalf("invalid outcome accepted: %#v", outcome)
		}
	}
	if _, err := DecodeImageMedia(mediaFrame(t, "image_response", "submit", nil, nil, &failure)); err == nil {
		t.Fatal("submit accepted as unrelated media response")
	}
}
