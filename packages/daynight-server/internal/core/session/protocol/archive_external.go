package sessionprotocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
	"unicode"
)

const MaxArchiveManifestBytes = 4 * 1024 * 1024
const MaxArchiveTimelineBytes = 128 * 1024 * 1024
const MaxArchiveHistoryBytes = MaxArchiveTimelineBytes + 16*1024
const MaxArchiveBlobBytes = 10 * 1024 * 1024
const ArchiveMetadataReserveBytes = 132 * 1024 * 1024

type ArchiveFileReference struct {
	FileID     string `json:"fileId"`
	SHA256     string `json:"sha256"`
	ByteLength string `json:"byteLength"`
}
type ArchiveResourceReference struct {
	Resource Resource `json:"resource"`
	BlobID   *string  `json:"blobId"`
}
type ArchiveManifest struct {
	SchemaVersion        int                        `json:"schemaVersion"`
	ContentKind          string                     `json:"contentKind"`
	RecordID             string                     `json:"recordId"`
	Fence                Fence                      `json:"fence"`
	Provider             string                     `json:"provider"`
	NativeSessionID      *string                    `json:"nativeSessionId"`
	ControllerID         string                     `json:"controllerId"`
	ControllerInstanceID string                     `json:"controllerInstanceId"`
	Timeline             ArchiveFileReference       `json:"timeline"`
	Resources            []ArchiveResourceReference `json:"resources"`
	Completeness         string                     `json:"completeness"`
}
type ArchiveTimeline struct {
	Entries []TimelineEntry `json:"entries"`
}
type ArchivePrepareRequest struct {
	Fence                    Fence  `json:"fence"`
	ControllerID             string `json:"controllerId"`
	ControllerInstanceID     string `json:"controllerInstanceId"`
	ExpectedTimelineRevision string `json:"expectedTimelineRevision,omitempty"`
	FailedFileID             string `json:"failedFileId,omitempty"`
}
type ArchivePrepareReceipt struct {
	RecordID         string                     `json:"recordId"`
	Phase            string                     `json:"phase"`
	Resources        []ArchiveResourceReference `json:"resources"`
	TimelineRevision *string                    `json:"timelineRevision"`
	Error            *ImageError                `json:"error"`
	HistoryEpoch     string                     `json:"historyEpoch"`
	SourceThrough    string                     `json:"sourceThrough"`
}
type ArchiveFileReceipt struct {
	TimelineRevision *string     `json:"-"`
	FileID           string      `json:"fileId"`
	State            string      `json:"state"`
	AcceptedOffset   string      `json:"acceptedOffset"`
	ByteLength       string      `json:"byteLength"`
	SHA256           string      `json:"sha256"`
	Error            *ImageError `json:"error"`
}
type ArchiveHistoryContent struct {
	HistoryEpoch  string          `json:"historyEpoch"`
	SourceThrough string          `json:"sourceThrough"`
	Entries       []TimelineEntry `json:"entries"`
	Resources     []Resource      `json:"resources"`
}

func DecodeArchivePrepareRequest(data []byte) (ArchivePrepareRequest, error) {
	fields, err := object(data, "fence", "controllerId", "controllerInstanceId")
	if err == nil {
		return decode[ArchivePrepareRequest](data, nested(schema{"fence": nested(fenceSchema), "controllerId": identifier, "controllerInstanceId": identifier}))
	}
	fields, err = object(data, "fence", "controllerId", "controllerInstanceId", "expectedTimelineRevision", "failedFileId")
	if err != nil || !sequence(fields["expectedTimelineRevision"]) || !identifier(fields["failedFileId"]) {
		return ArchivePrepareRequest{}, errInvalid
	}
	return decode[ArchivePrepareRequest](data, nested(schema{"fence": nested(fenceSchema), "controllerId": identifier, "controllerInstanceId": identifier, "expectedTimelineRevision": sequence, "failedFileId": identifier}))
}
func DecodeArchiveManifest(data []byte) (ArchiveManifest, error) {
	var out ArchiveManifest
	if len(data) == 0 || len(data) > MaxArchiveManifestBytes || !validUnicode(data) {
		return out, errInvalid
	}
	fields, err := object(data, "schemaVersion", "contentKind", "recordId", "fence", "provider", "nativeSessionId", "controllerId", "controllerInstanceId", "timeline", "resources", "completeness")
	if err != nil {
		return out, err
	}
	if string(fields["schemaVersion"]) != "3" || !enum("native_timeline")(fields["contentKind"]) || !identifier(fields["recordId"]) || !nested(fenceSchema)(fields["fence"]) || !enum("codex", "claude", "copilot")(fields["provider"]) || !optional(func(value json.RawMessage) bool {
		return key(value) && strings.IndexFunc(stringField(value), unicode.IsControl) < 0
	})(fields["nativeSessionId"]) || !identifier(fields["controllerId"]) || !identifier(fields["controllerInstanceId"]) || !enum("complete", "partial")(fields["completeness"]) {
		return out, errInvalid
	}
	if !nested(schema{"fileId": identifier, "sha256": pattern(`^[a-f0-9]{64}$`), "byteLength": sequence})(fields["timeline"]) || json.Unmarshal(data, &out) != nil || out.RecordID != out.Fence.SessionID {
		return ArchiveManifest{}, errInvalid
	}
	n, e := strconv.ParseInt(out.Timeline.ByteLength, 10, 64)
	if e != nil || n > MaxArchiveTimelineBytes {
		return ArchiveManifest{}, errInvalid
	}
	values, e := array(fields["resources"])
	if e != nil || len(values) > 1000 {
		return ArchiveManifest{}, errInvalid
	}
	out.Resources = []ArchiveResourceReference{}
	seen := map[string]bool{}
	total := int64(0)
	for _, raw := range values {
		f, e := object(raw, "resource", "blobId")
		if e != nil {
			return ArchiveManifest{}, e
		}
		r, e := DecodeResource(f["resource"])
		if e != nil || r.Status == "pending" || seen[r.ResourceID] {
			return ArchiveManifest{}, errInvalid
		}
		seen[r.ResourceID] = true
		var blob *string
		if json.Unmarshal(f["blobId"], &blob) != nil || blob != nil && !identifier(f["blobId"]) {
			return ArchiveManifest{}, errInvalid
		}
		if r.Status == "available" {
			if blob == nil || r.ByteLength == nil || r.SHA256 == nil {
				return ArchiveManifest{}, errInvalid
			}
			n, e := strconv.ParseInt(*r.ByteLength, 10, 64)
			if e != nil || n > MaxArchiveBlobBytes {
				return ArchiveManifest{}, errInvalid
			}
			total += n
		} else if blob != nil {
			return ArchiveManifest{}, errInvalid
		}
		out.Resources = append(out.Resources, ArchiveResourceReference{Resource: r, BlobID: blob})
	}
	if total > 1073741824 {
		return ArchiveManifest{}, errInvalid
	}
	return out, nil
}
func DecodeArchiveTimeline(data []byte) (ArchiveTimeline, error) {
	var out ArchiveTimeline
	if len(data) == 0 || len(data) > MaxArchiveTimelineBytes || !validUnicode(data) {
		return out, errInvalid
	}
	f, e := object(data, "entries")
	if e != nil {
		return out, e
	}
	var values []json.RawMessage
	entries := bytes.TrimSpace(f["entries"])
	if len(entries) == 0 || entries[0] != '[' || json.Unmarshal(entries, &values) != nil || len(values) > 100000 {
		return out, errInvalid
	}
	out.Entries = []TimelineEntry{}
	seen := map[string]bool{}
	previous := int64(0)
	for _, raw := range values {
		entry, e := DecodeTimeline(raw)
		n, _ := strconv.ParseInt(entry.EntrySeq, 10, 64)
		if e != nil || seen[entry.EntryID] || n <= previous {
			return ArchiveTimeline{}, errInvalid
		}
		seen[entry.EntryID] = true
		previous = n
		out.Entries = append(out.Entries, entry)
	}
	return out, nil
}
func DecodeArchiveHistory(data []byte) (ArchiveHistoryContent, error) {
	var out ArchiveHistoryContent
	if len(data) == 0 || len(data) > MaxArchiveHistoryBytes || !validUnicode(data) {
		return out, errInvalid
	}
	f, e := object(data, "historyEpoch", "sourceThrough", "entries", "resources")
	if e != nil || !key(f["historyEpoch"]) || !zeroSequence(f["sourceThrough"]) {
		return out, errInvalid
	}
	timeline, e := DecodeArchiveTimeline(append(append([]byte(`{"entries":`), f["entries"]...), '}'))
	if e != nil {
		return out, e
	}
	values, e := array(f["resources"])
	if e != nil || len(values) > 1000 {
		return out, errInvalid
	}
	out.HistoryEpoch = stringField(f["historyEpoch"])
	out.SourceThrough = stringField(f["sourceThrough"])
	out.Entries = timeline.Entries
	out.Resources = []Resource{}
	seen := map[string]bool{}
	for _, raw := range values {
		r, e := DecodeResource(raw)
		if e != nil || seen[r.ResourceID] {
			return ArchiveHistoryContent{}, errInvalid
		}
		seen[r.ResourceID] = true
		out.Resources = append(out.Resources, r)
	}
	return out, nil
}
func ArchiveReferences(entries []TimelineEntry) (map[string]bool, bool, error) {
	return archiveReferences(entries, true)
}

// ArchiveHistoryReferences retains known references while projection is pending.
// Such a history can be synchronized but cannot be sealed.
func ArchiveHistoryReferences(entries []TimelineEntry) (map[string]bool, bool, error) {
	return archiveReferences(entries, false)
}
func archiveReferences(entries []TimelineEntry, sealable bool) (map[string]bool, bool, error) {
	refs := map[string]bool{}
	missing := false
	var visit func(any) error
	visit = func(value any) error {
		switch item := value.(type) {
		case []any:
			for _, v := range item {
				if e := visit(v); e != nil {
					return e
				}
			}
		case map[string]any:
			if v, ok := item["imageProjectionError"]; sealable && ok && v != nil {
				return errInvalid
			}
			if _, exists := item["bindings"]; exists {
				if v, ok := item["bindings"]; sealable && ok && v == nil {
					return errInvalid
				}
			}
			if item["type"] == "resource" || item["type"] == "image" {
				if item["resourceId"] == nil {
					missing = true
				} else {
					id, ok := item["resourceId"].(string)
					if !ok || !uuidPattern.MatchString(id) {
						return errInvalid
					}
					refs[id] = true
				}
			}
			if item["type"] == "image_unavailable" {
				missing = true
			}
			for _, v := range item {
				if e := visit(v); e != nil {
					return e
				}
			}
		}
		return nil
	}
	for _, entry := range entries {
		raw, _ := MarshalWire(entry)
		var value any
		if json.Unmarshal(raw, &value) != nil {
			return nil, false, errInvalid
		}
		if e := visit(value); e != nil {
			return nil, false, e
		}
	}
	return refs, missing, nil
}
func VerifyArchiveClosure(manifest ArchiveManifest, timeline []byte, read func(ArchiveResourceReference) ([]byte, error)) (ArchiveTimeline, error) {
	sum := sha256.Sum256(timeline)
	if strconv.Itoa(len(timeline)) != manifest.Timeline.ByteLength || hex.EncodeToString(sum[:]) != manifest.Timeline.SHA256 {
		return ArchiveTimeline{}, errInvalid
	}
	out, e := DecodeArchiveTimeline(timeline)
	if e != nil {
		return out, e
	}
	refs, missing, e := ArchiveReferences(out.Entries)
	if e != nil {
		return out, e
	}
	found := map[string]bool{}
	for _, ref := range manifest.Resources {
		if !refs[ref.Resource.ResourceID] {
			return out, errInvalid
		}
		found[ref.Resource.ResourceID] = true
		if ref.Resource.Status != "available" {
			missing = true
			continue
		}
		bytes, e := read(ref)
		if e != nil {
			return out, e
		}
		sum := sha256.Sum256(bytes)
		if strconv.Itoa(len(bytes)) != *ref.Resource.ByteLength || hex.EncodeToString(sum[:]) != *ref.Resource.SHA256 {
			return out, errInvalid
		}
	}
	if len(found) != len(refs) || (manifest.Completeness == "partial") != missing {
		return out, errInvalid
	}
	return out, nil
}
