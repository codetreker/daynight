package sessionprotocol

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strconv"
)

type DirectImageContent struct {
	Spec   ImageUploadSpec `json:"spec"`
	Offset string          `json:"offset"`
	SHA256 string          `json:"sha256"`
	Data   string          `json:"data"`
}

type DirectCaptureOutcome struct {
	Kind      string          `json:"kind"`
	Validated *ValidatedImage `json:"validated,omitempty"`
	Error     *ImageError     `json:"error,omitempty"`
}

type DirectCaptureSubmission struct {
	Request   ImageCaptureRequest  `json:"request"`
	AttemptID string               `json:"attemptId"`
	Outcome   DirectCaptureOutcome `json:"outcome"`
}

func DecodeDirectImageContent(data []byte) (DirectImageContent, error) {
	return decode[DirectImageContent](data, func(raw json.RawMessage) bool {
		if !validateObject(raw, schema{
			"spec":   func(v json.RawMessage) bool { _, err := DecodeImageUploadSpec(v); return err == nil },
			"offset": enum("0"), "sha256": imageDigest, "data": canonicalChunk,
		}) {
			return false
		}
		var value DirectImageContent
		_ = json.Unmarshal(raw, &value)
		chunk, err := base64.StdEncoding.Strict().DecodeString(value.Data)
		size, parseErr := strconv.ParseInt(value.Spec.ByteLength, 10, 64)
		if err != nil || parseErr != nil || len(chunk) == 0 || len(chunk) > MaxContentChunkBytes || int64(len(chunk)) > size {
			return false
		}
		digest := sha256.Sum256(chunk)
		return hex.EncodeToString(digest[:]) == value.SHA256
	})
}

func DecodeDirectCaptureSubmission(data []byte) (DirectCaptureSubmission, error) {
	return decode[DirectCaptureSubmission](data, nested(schema{
		"request":   func(v json.RawMessage) bool { _, err := DecodeImageCaptureRequest(v); return err == nil },
		"attemptId": identifier,
		"outcome": func(v json.RawMessage) bool {
			var kind struct {
				Kind string `json:"kind"`
			}
			if json.Unmarshal(v, &kind) != nil {
				return false
			}
			switch kind.Kind {
			case "validated":
				return validateObject(v, schema{"kind": enum("validated"), "validated": validImageMetadata})
			case "resource":
				return validateObject(v, schema{"kind": enum("resource")})
			case "failed":
				return validateObject(v, schema{"kind": enum("failed"), "error": nested(imageErrorSchema)})
			}
			return false
		},
	}))
}
