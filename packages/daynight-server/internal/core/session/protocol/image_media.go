package sessionprotocol

import (
	"encoding/base64"
	"encoding/json"
	"strconv"
)

func validImageMediaBody(action string, body json.RawMessage) bool {
	switch action {
	case "prepare":
		_, e := DecodeImageUploadSpec(body)
		return e == nil
	case "write":
		return validateObject(body, schema{"uploadId": identifier, "offset": decimalRange(9223372036854775807, true), "sha256": imageDigest, "data": func(v json.RawMessage) bool { return stringField(v) != "" && canonicalChunk(v) }})
	case "complete":
		return validateObject(body, schema{"uploadId": identifier, "sha256": imageDigest, "byteLength": decimalRange(MaxImageBytes, false)})
	case "status":
		return validateObject(body, schema{"uploadId": identifier})
	case "release":
		var value map[string]json.RawMessage
		if json.Unmarshal(body, &value) != nil {
			return false
		}
		if _, present := value["spec"]; !present {
			return validateObject(body, schema{"uploadId": identifier})
		}
		if !validateObject(body, schema{"uploadId": identifier, "spec": func(raw json.RawMessage) bool { _, e := DecodeImageUploadSpec(raw); return e == nil }}) {
			return false
		}
		spec, e := DecodeImageUploadSpec(value["spec"])
		return e == nil && stringField(value["uploadId"]) == spec.UploadID
	case "read_prepared":
		return validateObject(body, schema{"preparationId": identifier, "offset": decimalRange(9223372036854775807, true), "limit": integerRange(1, MaxContentChunkBytes)})
	case "read_capture":
		if !validateObject(body, schema{"captureId": identifier, "attemptId": identifier, "sha256": imageDigest, "byteLength": decimalRange(MaxImageBytes, false), "offset": decimalRange(9223372036854775807, true), "limit": integerRange(1, MaxContentChunkBytes)}) {
			return false
		}
		var v struct{ Offset, ByteLength string }
		_ = json.Unmarshal(body, &v)
		a, e := strconv.ParseInt(v.Offset, 10, 64)
		b, f := strconv.ParseInt(v.ByteLength, 10, 64)
		return e == nil && f == nil && a < b
	case "retry_capture":
		return validateObject(body, schema{"captureId": identifier, "attemptId": identifier})
	case "read":
		_, e := DecodeImageReadRequest(body)
		return e == nil
	}
	return false
}
func validCaptureBody(action string, body json.RawMessage) bool {
	switch action {
	case "register":
		_, e := DecodeImageCaptureRequest(body)
		return e == nil
	case "commit":
		_, e := DecodeImageCaptureCommit(body)
		return e == nil
	case "submit":
		_, e := DecodeDirectCaptureSubmission(body)
		return e == nil
	case "query":
		return validateObject(body, schema{"captureId": identifier})
	case "failed":
		return validateObject(body, schema{"captureId": identifier, "attemptId": identifier, "error": nested(imageErrorSchema)})
	}
	return false
}

var imageErrorSchema = schema{"code": key, "message": func(raw json.RawMessage) bool { return stringValue(raw, false, 256) }}

func validPreparation(raw json.RawMessage) bool {
	if !validateObject(raw, schema{"uploadId": identifier, "imageId": identifier, "target": nested(imageTargetSchema), "state": enum("receiving", "validated", "failed", "released", "expired"), "acceptedOffset": decimalRange(MaxImageBytes, true), "validated": optional(validImageMetadata), "error": optional(nested(imageErrorSchema))}) {
		return false
	}
	var v LocalImagePreparation
	_ = json.Unmarshal(raw, &v)
	return (v.State == "validated") == (v.Validated != nil) && (v.State == "failed" || v.State == "expired") == (v.Error != nil) && (v.Validated == nil || v.AcceptedOffset == v.Validated.ByteLength)
}
func validImageChunk(raw json.RawMessage, prepared bool) bool {
	key := "resourceId"
	if prepared {
		key = "preparationId"
	}
	if !validateObject(raw, schema{key: identifier, "sha256": imageDigest, "byteLength": decimalRange(MaxImageBytes, false), "offset": decimalRange(9223372036854775807, true), "data": canonicalChunk, "eof": boolean}) {
		return false
	}
	var v struct {
		ByteLength, Offset, Data string
		EOF                      bool
	}
	_ = json.Unmarshal(raw, &v)
	data, e := base64.StdEncoding.Strict().DecodeString(v.Data)
	offset, a := strconv.ParseInt(v.Offset, 10, 64)
	size, b := strconv.ParseInt(v.ByteLength, 10, 64)
	return e == nil && a == nil && b == nil && offset+int64(len(data)) <= size && v.EOF == (offset+int64(len(data)) == size) && (len(data) > 0 || v.EOF)
}
func validCaptureReceipt(raw json.RawMessage) bool {
	if !validateObject(raw, schema{"captureId": identifier, "attemptId": identifier, "revision": sequence, "occurrence": validateOccurrence, "state": enum("reserved", "copying", "committed", "failed"), "resourceId": optional(identifier), "resource": optional(func(v json.RawMessage) bool { _, e := DecodeResource(v); return e == nil }), "error": optional(nested(imageErrorSchema))}) {
		return false
	}
	var v ImageCaptureReceipt
	_ = json.Unmarshal(raw, &v)
	return (v.State == "committed") == (v.Resource != nil) && (v.State == "failed") == (v.Error != nil) && (v.State == "failed") == (v.ResourceID == nil) && (v.Resource == nil || v.Resource.Status == "available" && v.ResourceID != nil && v.Resource.ResourceID == *v.ResourceID)
}
