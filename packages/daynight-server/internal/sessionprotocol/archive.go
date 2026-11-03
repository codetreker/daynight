package sessionprotocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
	"unicode"
)

const MaxArchiveBytes = 64 * 1024 * 1024

type ArchiveResource struct {
	Resource Resource `json:"resource"`
	Data     *string  `json:"data"`
}
type ArchiveDocument struct {
	Fence
	SchemaVersion        int               `json:"schemaVersion"`
	ControllerID         string            `json:"controllerId"`
	ControllerInstanceID string            `json:"controllerInstanceId"`
	Provider             string            `json:"provider"`
	NativeSessionID      *string           `json:"nativeSessionId"`
	Entries              []TimelineEntry   `json:"entries"`
	Resources            []ArchiveResource `json:"resources"`
}
type ArchiveStatus struct {
	State      string  `json:"state"`
	SHA256     *string `json:"sha256"`
	ByteLength *string `json:"byteLength"`
	ErrorCode  *string `json:"errorCode"`
}
type ArchiveUpdate struct {
	Fence
	ControllerID         string  `json:"controllerId"`
	ControllerInstanceID string  `json:"controllerInstanceId"`
	State                string  `json:"state"`
	ErrorCode            *string `json:"errorCode"`
}

var archiveIdentitySchema = extend(fenceSchema, schema{"controllerId": identifier, "controllerInstanceId": identifier})

func DecodeArchiveUpdate(data []byte) (ArchiveUpdate, error) {
	v, err := decode[ArchiveUpdate](data, nested(extend(archiveIdentitySchema, schema{"state": enum("pending", "failed"), "errorCode": optional(pattern(`^[a-z_]{1,64}$`))})))
	if err == nil && (v.State == "pending" && v.ErrorCode != nil) {
		err = errInvalid
	}
	return v, err
}
func DecodeArchive(data []byte) (ArchiveDocument, error) {
	var out ArchiveDocument
	if len(data) > MaxArchiveBytes || !validUnicode(data) {
		return out, errInvalid
	}
	rawArray := func(v json.RawMessage) bool { return len(bytes.TrimSpace(v)) > 0 && bytes.TrimSpace(v)[0] == '[' }
	if !validateObject(data, extend(archiveIdentitySchema, schema{"schemaVersion": version, "provider": enum("codex", "claude", "copilot"), "nativeSessionId": optional(func(v json.RawMessage) bool {
		return key(v) && strings.IndexFunc(stringField(v), unicode.IsControl) < 0
	}), "entries": rawArray, "resources": rawArray})) {
		return out, errInvalid
	}
	var raw struct {
		Fence
		ControllerID         string            `json:"controllerId"`
		ControllerInstanceID string            `json:"controllerInstanceId"`
		Provider             string            `json:"provider"`
		NativeSessionID      *string           `json:"nativeSessionId"`
		Entries              []json.RawMessage `json:"entries"`
		Resources            []json.RawMessage `json:"resources"`
	}
	if json.Unmarshal(data, &raw) != nil || len(raw.Entries) > 100000 || len(raw.Resources) > 1000 {
		return out, errInvalid
	}
	out = ArchiveDocument{Fence: raw.Fence, SchemaVersion: 1, ControllerID: raw.ControllerID, ControllerInstanceID: raw.ControllerInstanceID, Provider: raw.Provider, NativeSessionID: raw.NativeSessionID, Entries: []TimelineEntry{}, Resources: []ArchiveResource{}}
	ids := map[string]bool{}
	refs := map[string]bool{}
	var previous int64
	for _, b := range raw.Entries {
		e, err := DecodeTimeline(b)
		seq, _ := strconv.ParseInt(e.EntrySeq, 10, 64)
		if err != nil || ids[e.EntryID] || seq <= previous {
			return ArchiveDocument{}, errInvalid
		}
		ids[e.EntryID] = true
		previous = seq
		out.Entries = append(out.Entries, e)
		for _, field := range []string{"content", "output"} {
			var parts []struct {
				Type       string `json:"type"`
				ResourceID string `json:"resourceId"`
			}
			_ = json.Unmarshal(e.Data[field], &parts)
			for _, part := range parts {
				if part.Type == "resource" {
					refs[part.ResourceID] = true
				}
			}
		}
	}
	resources := map[string]bool{}
	for _, b := range raw.Resources {
		fields, err := object(b, "resource", "data")
		if err != nil {
			return ArchiveDocument{}, errInvalid
		}
		r, err := DecodeResource(fields["resource"])
		if err != nil || resources[r.ResourceID] || r.Status == "pending" {
			return ArchiveDocument{}, errInvalid
		}
		resources[r.ResourceID] = true
		var encoded *string
		if r.Status == "available" {
			if json.Unmarshal(fields["data"], &encoded) != nil || encoded == nil {
				return ArchiveDocument{}, errInvalid
			}
			content, err := base64.StdEncoding.Strict().DecodeString(*encoded)
			if err != nil || len(content) > MaxResourceBytes || base64.StdEncoding.EncodeToString(content) != *encoded {
				return ArchiveDocument{}, errInvalid
			}
			sum := sha256.Sum256(content)
			if strconv.Itoa(len(content)) != *r.ByteLength || hex.EncodeToString(sum[:]) != *r.SHA256 {
				return ArchiveDocument{}, errInvalid
			}
		} else if !null(fields["data"]) {
			return ArchiveDocument{}, errInvalid
		}
		out.Resources = append(out.Resources, ArchiveResource{Resource: r, Data: encoded})
	}
	for ref := range refs {
		if !resources[ref] {
			return ArchiveDocument{}, errInvalid
		}
	}
	return out, nil
}
