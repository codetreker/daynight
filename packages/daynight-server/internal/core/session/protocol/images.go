package sessionprotocol

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

const (
	ContentRevision               = 2
	MaxImageBytes                 = 10 * 1024 * 1024
	MaxMessageImageBytes          = 20 * 1024 * 1024
	MaxImagesPerMessage           = 8
	MaxSessionResourceBytes int64 = 1024 * 1024 * 1024
	MaxSessionResources           = 1000
)

type ImageError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type ImageTarget struct {
	ServerOrigin            string  `json:"serverOrigin"`
	ActorUserID             string  `json:"actorUserId"`
	Fence                   Fence   `json:"fence"`
	ExpectedNativeSessionID *string `json:"expectedNativeSessionId"`
}
type ImageGeometry struct {
	Version   int  `json:"version"`
	Known     bool `json:"known"`
	MaxWidth  int  `json:"maxWidth"`
	MaxHeight int  `json:"maxHeight"`
	MaxPixels int  `json:"maxPixels"`
	MaxFrames int  `json:"maxFrames"`
}
type ImageCapabilities struct {
	Revision                string        `json:"revision"`
	ProviderRevision        string        `json:"providerRevision"`
	ExpectedNativeSessionID *string       `json:"expectedNativeSessionId"`
	ModelID                 *string       `json:"modelId"`
	ControlsRevision        *string       `json:"controlsRevision"`
	Send                    string        `json:"send"`
	Steer                   string        `json:"steer"`
	ReasonCode              *string       `json:"reasonCode"`
	InputMediaTypes         []string      `json:"inputMediaTypes"`
	MaxImageBytes           string        `json:"maxImageBytes"`
	MaxMessageImageBytes    string        `json:"maxMessageImageBytes"`
	MaxImagesPerMessage     int           `json:"maxImagesPerMessage"`
	Geometry                ImageGeometry `json:"geometry"`
}
type ProviderImageCapabilities struct {
	Revision                string        `json:"revision"`
	ExpectedNativeSessionID *string       `json:"expectedNativeSessionId"`
	ModelID                 *string       `json:"modelId"`
	ControlsRevision        *string       `json:"controlsRevision"`
	Send                    string        `json:"send"`
	Steer                   string        `json:"steer"`
	ReasonCode              *string       `json:"reasonCode"`
	InputMediaTypes         []string      `json:"inputMediaTypes"`
	MaxImageBytes           string        `json:"maxImageBytes"`
	MaxMessageImageBytes    string        `json:"maxMessageImageBytes"`
	MaxImagesPerMessage     int           `json:"maxImagesPerMessage"`
	Geometry                ImageGeometry `json:"geometry"`
}
type ImageBudget struct {
	Revision           string `json:"revision"`
	MaxBytes           string `json:"maxBytes"`
	CommittedBytes     string `json:"committedBytes"`
	ReservedBytes      string `json:"reservedBytes"`
	MaxResources       int    `json:"maxResources"`
	CommittedResources int    `json:"committedResources"`
	ReservedResources  int    `json:"reservedResources"`
}
type ValidatedImage struct {
	MediaType  string `json:"mediaType"`
	ByteLength string `json:"byteLength"`
	SHA256     string `json:"sha256"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	FrameCount int    `json:"frameCount"`
}
type ImageUploadSpec struct {
	UploadID   string      `json:"uploadId"`
	ImageID    string      `json:"imageId"`
	Target     ImageTarget `json:"target"`
	Name       string      `json:"name"`
	MediaType  string      `json:"mediaType"`
	ByteLength string      `json:"byteLength"`
	SHA256     string      `json:"sha256"`
}
type ImageUploadMetadata struct {
	Name       string `json:"name"`
	MediaType  string `json:"mediaType"`
	ByteLength string `json:"byteLength"`
	SHA256     string `json:"sha256"`
}
type ImageUploadReceipt struct {
	UploadID       string              `json:"uploadId"`
	ImageID        string              `json:"imageId"`
	Target         ImageTarget         `json:"target"`
	State          string              `json:"state"`
	AcceptedOffset string              `json:"acceptedOffset"`
	Spec           ImageUploadMetadata `json:"spec"`
	Resource       *Resource           `json:"resource"`
	ExpiresAt      string              `json:"expiresAt"`
	Error          *ImageError         `json:"error"`
}
type ImageUploadComplete struct {
	SHA256     string `json:"sha256"`
	ByteLength string `json:"byteLength"`
}
type ImageChunkWrite struct {
	UploadID string `json:"uploadId"`
	Offset   string `json:"offset"`
	SHA256   string `json:"sha256"`
	Data     string `json:"data"`
}
type LocalImagePreparation struct {
	UploadID       string          `json:"uploadId"`
	ImageID        string          `json:"imageId"`
	Target         ImageTarget     `json:"target"`
	State          string          `json:"state"`
	AcceptedOffset string          `json:"acceptedOffset"`
	Validated      *ValidatedImage `json:"validated"`
	Error          *ImageError     `json:"error"`
}
type PreparedImageChunk struct {
	PreparationID string `json:"preparationId"`
	SHA256        string `json:"sha256"`
	ByteLength    string `json:"byteLength"`
	Offset        string `json:"offset"`
	Data          string `json:"data"`
	EOF           bool   `json:"eof"`
}
type ImageOccurrence struct {
	ImageID          string  `json:"imageId"`
	EntryID          string  `json:"entryId"`
	Container        string  `json:"container"`
	PartID           *string `json:"partId"`
	SourceRevision   *string `json:"sourceRevision"`
	SourceTextSHA256 *string `json:"sourceTextSha256"`
	CallID           *string `json:"callId"`
	SourceKey        string  `json:"sourceKey"`
}
type ImageLocator struct {
	Kind            string `json:"kind"`
	ResourceID      string `json:"resourceId,omitempty"`
	Provider        string `json:"provider,omitempty"`
	NativeSessionID string `json:"nativeSessionId,omitempty"`
	NativeMessageID string `json:"nativeMessageId,omitempty"`
	NativePartID    string `json:"nativePartId,omitempty"`
	Path            string `json:"path,omitempty"`
	ContextID       string `json:"contextId,omitempty"`
	URL             string `json:"url,omitempty"`
}
type NativeImageSource struct {
	Provider        string `json:"provider"`
	NativeSessionID string `json:"nativeSessionId"`
	NativeMessageID string `json:"nativeMessageId"`
	NativePartID    string `json:"nativePartId"`
}
type ImageCaptureRequest struct {
	AttemptID    string             `json:"attemptId"`
	CaptureID    string             `json:"captureId"`
	Occurrence   ImageOccurrence    `json:"occurrence"`
	Locator      ImageLocator       `json:"locator"`
	NativeSource *NativeImageSource `json:"nativeSource"`
}
type ImageCaptureReceipt struct {
	AttemptID  string          `json:"attemptId"`
	Revision   string          `json:"revision"`
	CaptureID  string          `json:"captureId"`
	Occurrence ImageOccurrence `json:"occurrence"`
	State      string          `json:"state"`
	ResourceID *string         `json:"resourceId"`
	Resource   *Resource       `json:"resource"`
	Error      *ImageError     `json:"error"`
}
type ImageCaptureCommit struct {
	AttemptID string         `json:"attemptId"`
	CaptureID string         `json:"captureId"`
	Validated ValidatedImage `json:"validated"`
}
type ImageReadRequest struct {
	ResourceID string `json:"resourceId"`
	Offset     string `json:"offset"`
	Limit      int    `json:"limit"`
}
type ImageReadChunk struct {
	ResourceID string `json:"resourceId"`
	SHA256     string `json:"sha256"`
	ByteLength string `json:"byteLength"`
	Offset     string `json:"offset"`
	Data       string `json:"data"`
	EOF        bool   `json:"eof"`
}

// MarshalJSON keeps the legacy shape intact and makes new unavailable geometry explicit.
func (r Resource) MarshalJSON() ([]byte, error) {
	type plain Resource
	b, e := json.Marshal(plain(r))
	if e != nil || r.Revision == "" {
		return b, e
	}
	var raw map[string]any
	if e = json.Unmarshal(b, &raw); e != nil {
		return nil, e
	}
	raw["width"], raw["height"], raw["frameCount"] = r.Width, r.Height, r.FrameCount
	return MarshalWire(raw)
}

func ContainsImages(data []byte) bool {
	var v struct {
		Content []struct {
			Type string `json:"type"`
		}
	}
	if json.Unmarshal(data, &v) != nil {
		return false
	}
	for _, p := range v.Content {
		if p.Type == "image" {
			return true
		}
	}
	return false
}
func validateImageSend(data []byte) error {
	fields, err := messageObject(data, "content", "expectedTurnId", "target", "draftId", "draftRevision", "expectedImageCapabilityRevision")
	if err != nil || !nullableString(fields["expectedTurnId"], false, 256) || !validateObject(fields["target"], imageTargetSchema) || !identifier(fields["draftId"]) || !sequence(fields["draftRevision"]) || !sequence(fields["expectedImageCapabilityRevision"]) {
		return errInvalid
	}
	parts, e := array(fields["content"])
	if e != nil || len(parts) < 1 || len(parts) > 9 {
		return errInvalid
	}
	seenImages, seenUploads := map[string]bool{}, map[string]bool{}
	var total int64
	count := 0
	for i, p := range parts {
		var typ struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(p, &typ)
		if typ.Type == "text" {
			if i != 0 || !validateObject(p, schema{"type": enum("text"), "text": text}) {
				return errInvalid
			}
			continue
		}
		if !validateObject(p, schema{"type": enum("image"), "imageId": identifier, "uploadId": identifier, "resourceId": identifier, "sha256": imageDigest, "byteLength": decimalRange(MaxImageBytes, false)}) {
			return errInvalid
		}
		var part TextPart
		_ = json.Unmarshal(p, &part)
		if seenImages[part.ImageID] || seenUploads[part.UploadID] {
			return errInvalid
		}
		seenImages[part.ImageID], seenUploads[part.UploadID] = true, true
		size, _ := strconv.ParseInt(part.ByteLength, 10, 64)
		total += size
		count++
	}
	if count < 1 || count > MaxImagesPerMessage || total > MaxMessageImageBytes {
		return errInvalid
	}
	return nil
}

func validateImageGeometry(data json.RawMessage) bool {
	if !validateObject(data, schema{"version": version, "known": boolean, "maxWidth": integerRange(0, 16384), "maxHeight": integerRange(0, 16384), "maxPixels": integerRange(0, 33554432), "maxFrames": integerRange(0, 256)}) {
		return false
	}
	var v ImageGeometry
	_ = json.Unmarshal(data, &v)
	if !v.Known {
		return v.MaxWidth == 0 && v.MaxHeight == 0 && v.MaxPixels == 0 && v.MaxFrames == 0
	}
	return v.MaxWidth > 0 && v.MaxHeight > 0 && v.MaxPixels > 0 && v.MaxFrames > 0
}

var imageCapabilitySchema = schema{"revision": sequence, "providerRevision": sequence, "expectedNativeSessionId": optional(key), "modelId": optional(key), "controlsRevision": optional(sequence), "send": enum("supported", "unsupported", "unknown"), "steer": enum("supported", "unsupported", "unknown"), "reasonCode": optional(enum("model_unsupported", "capability_unknown", "provider_unsupported", "component_unsupported", "policy_restricted", "worker_upgrade_required", "profile_disabled")), "inputMediaTypes": many(inputMime, 0, 3, "$"), "maxImageBytes": decimalRange(MaxImageBytes, true), "maxMessageImageBytes": decimalRange(MaxMessageImageBytes, true), "maxImagesPerMessage": integerRange(0, 8), "geometry": validateImageGeometry}

func validateImageCapabilities(raw json.RawMessage) bool {
	if !validateObject(raw, imageCapabilitySchema) {
		return false
	}
	var c ImageCapabilities
	_ = json.Unmarshal(raw, &c)
	if c.Send == "supported" || c.Steer == "supported" {
		return c.Geometry.Known && c.ModelID != nil && len(c.InputMediaTypes) > 0 && c.MaxImageBytes != "0" && c.MaxMessageImageBytes != "0" && c.MaxImagesPerMessage > 0
	}
	return c.ReasonCode != nil
}
func validateProviderImages(raw json.RawMessage) bool {
	f := extend(imageCapabilitySchema, schema{})
	delete(f, "providerRevision")
	if !validateObject(raw, f) {
		return false
	}
	var m map[string]json.RawMessage
	_ = json.Unmarshal(raw, &m)
	m["providerRevision"] = json.RawMessage(`"1"`)
	b, _ := json.Marshal(m)
	return validateImageCapabilities(b)
}
func validateImageBudget(raw json.RawMessage) bool {
	if !validateObject(raw, schema{"revision": sequence, "maxBytes": decimalRange(MaxSessionResourceBytes, true), "committedBytes": decimalRange(MaxSessionResourceBytes, true), "reservedBytes": decimalRange(MaxSessionResourceBytes, true), "maxResources": integerRange(0, 1000), "committedResources": integerRange(0, 1000), "reservedResources": integerRange(0, 1000)}) {
		return false
	}
	var b ImageBudget
	_ = json.Unmarshal(raw, &b)
	max, _ := strconv.ParseInt(b.MaxBytes, 10, 64)
	c, _ := strconv.ParseInt(b.CommittedBytes, 10, 64)
	r, _ := strconv.ParseInt(b.ReservedBytes, 10, 64)
	return c+r <= max && b.CommittedResources+b.ReservedResources <= b.MaxResources
}

type ImageMediaMessage struct {
	ControllerFence
	Type      string          `json:"type"`
	Protocol  string          `json:"protocol"`
	RequestID string          `json:"requestId"`
	Action    string          `json:"action"`
	Body      json.RawMessage `json:"body,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *ImageError     `json:"error,omitempty"`
}

func displayMime(raw json.RawMessage) bool {
	return enum("image/png", "image/jpeg", "image/webp", "image/gif", "image/avif")(raw)
}
func inputMime(raw json.RawMessage) bool { return enum("image/png", "image/jpeg", "image/webp")(raw) }
func imageLabel(raw json.RawMessage) bool {
	if !stringValue(raw, false, 1024) {
		return false
	}
	return !strings.ContainsFunc(stringField(raw), unicode.IsControl)
}
func imageDigest(raw json.RawMessage) bool { return pattern(`^[a-f0-9]{64}$`)(raw) }
func decimalRange(max int64, zero bool) validator {
	return func(raw json.RawMessage) bool {
		if !(sequence(raw) || zero && zeroSequence(raw)) {
			return false
		}
		n, e := strconv.ParseInt(stringField(raw), 10, 64)
		return e == nil && n <= max
	}
}
func integerRange(min, max int) validator {
	return func(raw json.RawMessage) bool {
		var n int
		return !null(raw) && json.Unmarshal(raw, &n) == nil && n >= min && n <= max
	}
}
func originValue(raw json.RawMessage) bool {
	v := stringField(raw)
	u, e := url.Parse(v)
	return e == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == "" && u.String() == v && strings.ToLower(u.Host) == u.Host
}

var imageTargetSchema = schema{"serverOrigin": originValue, "actorUserId": identifier, "fence": nested(fenceSchema), "expectedNativeSessionId": optional(imageLabel)}
var validatedImageSchema = schema{"mediaType": displayMime, "byteLength": decimalRange(MaxImageBytes, false), "sha256": imageDigest, "width": integerRange(1, 16384), "height": integerRange(1, 16384), "frameCount": integerRange(1, 256)}

func validImageMetadata(raw json.RawMessage) bool {
	var v ValidatedImage
	return validateObject(raw, validatedImageSchema) && json.Unmarshal(raw, &v) == nil && int64(v.Width)*int64(v.Height) <= 33554432 && int64(v.Width)*int64(v.Height)*int64(v.FrameCount) <= 67108864
}
func DecodeValidatedImage(data []byte) (ValidatedImage, error) {
	return decode[ValidatedImage](data, validImageMetadata)
}
func DecodeImageUploadSpec(data []byte) (ImageUploadSpec, error) {
	return decode[ImageUploadSpec](data, nested(schema{"uploadId": identifier, "imageId": identifier, "target": nested(imageTargetSchema), "name": imageLabel, "mediaType": inputMime, "byteLength": decimalRange(MaxImageBytes, false), "sha256": imageDigest}))
}
func DecodeImageUploadComplete(data []byte) (ImageUploadComplete, error) {
	return decode[ImageUploadComplete](data, nested(schema{"sha256": imageDigest, "byteLength": decimalRange(MaxImageBytes, false)}))
}
func DecodeImageTarget(data []byte) (ImageTarget, error) {
	return decode[ImageTarget](data, nested(imageTargetSchema))
}
func DecodeImageReadRequest(data []byte) (ImageReadRequest, error) {
	return decode[ImageReadRequest](data, nested(schema{"resourceId": identifier, "offset": decimalRange(9223372036854775807, true), "limit": integerRange(1, MaxContentChunkBytes)}))
}
func canonicalChunk(raw json.RawMessage) bool {
	s := stringField(raw)
	if len(s) > base64.StdEncoding.EncodedLen(MaxContentChunkBytes) {
		return false
	}
	b, e := base64.StdEncoding.Strict().DecodeString(s)
	return e == nil && base64.StdEncoding.EncodeToString(b) == s
}

var imageOccurrenceSchema = schema{"imageId": identifier, "entryId": identifier, "container": enum("content", "tool_output", "reasoning"), "partId": optional(identifier), "sourceRevision": optional(sequence), "sourceTextSha256": optional(imageDigest), "callId": optional(imageLabel), "sourceKey": imageLabel}

func validateOccurrence(raw json.RawMessage) bool {
	if !validateObject(raw, imageOccurrenceSchema) {
		return false
	}
	var v ImageOccurrence
	_ = json.Unmarshal(raw, &v)
	if (v.CallID != nil) != (v.Container == "tool_output") {
		return false
	}
	return (v.PartID == nil && v.SourceRevision == nil && v.SourceTextSHA256 == nil && v.Container != "reasoning") || (v.PartID != nil && v.SourceRevision != nil && v.SourceTextSHA256 != nil)
}

var nativeImageSourceSchema = schema{"provider": enum("codex", "claude", "copilot"), "nativeSessionId": imageLabel, "nativeMessageId": imageLabel, "nativePartId": imageLabel}

func validateLocator(raw json.RawMessage) bool {
	var v ImageLocator
	if json.Unmarshal(raw, &v) != nil {
		return false
	}
	switch v.Kind {
	case "resource":
		return validateObject(raw, schema{"kind": enum("resource"), "resourceId": identifier})
	case "native":
		return validateObject(raw, extend(nativeImageSourceSchema, schema{"kind": enum("native")}))
	case "local":
		return validateObject(raw, schema{"kind": enum("local"), "path": relayString(8192), "contextId": identifier})
	case "external":
		return validateObject(raw, schema{"kind": enum("external"), "url": func(raw json.RawMessage) bool {
			if !stringValue(raw, false, 8192) {
				return false
			}
			u, e := url.Parse(stringField(raw))
			return e == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" && u.User == nil
		}})
	}
	return false
}
func DecodeImageCaptureRequest(data []byte) (ImageCaptureRequest, error) {
	return decode[ImageCaptureRequest](data, nested(schema{"captureId": identifier, "attemptId": identifier, "occurrence": validateOccurrence, "locator": validateLocator, "nativeSource": optional(nested(nativeImageSourceSchema))}))
}
func DecodeImageCaptureCommit(data []byte) (ImageCaptureCommit, error) {
	return decode[ImageCaptureCommit](data, nested(schema{"captureId": identifier, "attemptId": identifier, "validated": validImageMetadata}))
}
func DecodeImageMedia(data []byte) (ImageMediaMessage, error) {
	var v ImageMediaMessage
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(data, &v)
	_ = json.Unmarshal(data, &raw)
	fields := extend(fenceSchema, schema{"type": enum("image_request", "image_response", "image_capture", "image_capture_result"), "protocol": enum(Protocol), "connectionEpoch": sequence, "requestId": identifier, "action": enum("prepare", "write", "complete", "status", "release", "read_prepared", "read_capture", "read", "register", "query", "commit", "failed", "retry_capture", "submit")})
	if v.Type == "image_request" || v.Type == "image_capture" {
		fields["body"] = func(data json.RawMessage) bool { return !null(data) }
	} else {
		fields["result"] = func(json.RawMessage) bool { return true }
		fields["error"] = optional(nested(schema{"code": key, "message": func(raw json.RawMessage) bool { return stringValue(raw, false, 256) }}))
	}
	out, e := decode[ImageMediaMessage](data, nested(fields))
	if e != nil {
		return out, e
	}
	if v.Action == "submit" && v.Type != "image_capture" && v.Type != "image_capture_result" {
		return out, errInvalid
	}
	if v.Type == "image_request" && !validImageMediaBody(v.Action, v.Body) || v.Type == "image_capture" && !validCaptureBody(v.Action, v.Body) {
		return out, errInvalid
	}
	if v.Type == "image_response" || v.Type == "image_capture_result" {
		if null(raw["result"]) == (out.Error == nil) {
			return out, errInvalid
		}
		if out.Error == nil {
			valid := false
			if v.Type == "image_capture_result" {
				valid = validCaptureReceipt(v.Result)
			} else {
				switch v.Action {
				case "retry_capture":
					valid = validImageMetadata(v.Result)
				case "read":
					valid = validImageChunk(v.Result, false)
				case "read_prepared", "read_capture":
					valid = validImageChunk(v.Result, true)
				default:
					valid = validPreparation(v.Result)
				}
			}
			if !valid {
				return out, errInvalid
			}
		}
	}
	return out, nil
}

// CanonicalImageJSON preserves array order and Unicode while rejecting noninteger intent values.
func CanonicalImageJSON(value any) ([]byte, error) {
	b, e := json.Marshal(value)
	if e != nil {
		return nil, e
	}
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var normalized any
	if e = d.Decode(&normalized); e != nil {
		return nil, e
	}
	var out bytes.Buffer
	if e = writeCanonical(&out, normalized); e != nil {
		return nil, e
	}
	return out.Bytes(), nil
}
func canonicalString(out *bytes.Buffer, s string) {
	out.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"', '\\':
			out.WriteByte('\\')
			out.WriteRune(r)
		default:
			if r < 32 {
				out.WriteString(`\u00`)
				out.WriteByte("0123456789abcdef"[r>>4])
				out.WriteByte("0123456789abcdef"[r&15])
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
}
func writeCanonical(out *bytes.Buffer, v any) error {
	switch v := v.(type) {
	case nil:
		out.WriteString("null")
	case bool:
		out.WriteString(strconv.FormatBool(v))
	case string:
		canonicalString(out, v)
	case json.Number:
		n, e := strconv.ParseInt(string(v), 10, 64)
		if e != nil {
			return errInvalid
		}
		out.WriteString(strconv.FormatInt(n, 10))
	case []any:
		out.WriteByte('[')
		for i, x := range v {
			if i > 0 {
				out.WriteByte(',')
			}
			if e := writeCanonical(out, x); e != nil {
				return e
			}
		}
		out.WriteByte(']')
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		out.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				out.WriteByte(',')
			}
			canonicalString(out, k)
			out.WriteByte(':')
			if e := writeCanonical(out, v[k]); e != nil {
				return e
			}
		}
		out.WriteByte('}')
	default:
		return errInvalid
	}
	return nil
}

// Text parts retain the original shape, including an explicit empty text value.
func (p TextPart) MarshalJSON() ([]byte, error) {
	if p.Type == "text" {
		return MarshalWire(struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}{p.Type, p.Text})
	}
	type plain TextPart
	return MarshalWire(plain(p))
}

func DecodeImageDisplayUploadSpec(data []byte) (ImageUploadSpec, error) {
	return decode[ImageUploadSpec](data, nested(schema{"uploadId": identifier, "imageId": identifier, "target": nested(imageTargetSchema), "name": imageLabel, "mediaType": displayMime, "byteLength": decimalRange(MaxImageBytes, false), "sha256": imageDigest}))
}
