package sessionprotocol

import (
	"encoding/base64"
	"encoding/json"
	"strconv"
)

const MaxContentChunkBytes = 512 * 1024

// Content responses are transient reads from the owning controller. They never
// establish a server-side copy of native session history.
type ContentResult struct {
	Kind          string          `json:"kind"`
	HistoryEpoch  string          `json:"historyEpoch,omitempty"`
	Items         []TimelineEntry `json:"items,omitempty"`
	Resources     []Resource      `json:"resources,omitempty"`
	BeforeCursor  *string         `json:"beforeCursor,omitempty"`
	AfterCursor   *string         `json:"afterCursor,omitempty"`
	HasMoreBefore bool            `json:"hasMoreBefore,omitempty"`
	HasMoreAfter  bool            `json:"hasMoreAfter,omitempty"`
	Resource      *Resource       `json:"resource,omitempty"`
	Offset        string          `json:"offset,omitempty"`
	Data          string          `json:"data,omitempty"`
	EOF           bool            `json:"eof,omitempty"`
}

func (v ContentResult) MarshalJSON() ([]byte, error) {
	if v.Kind == "timeline" {
		return MarshalWire(map[string]any{"kind": v.Kind, "historyEpoch": v.HistoryEpoch, "items": v.Items, "resources": v.Resources, "beforeCursor": v.BeforeCursor, "afterCursor": v.AfterCursor, "hasMoreBefore": v.HasMoreBefore, "hasMoreAfter": v.HasMoreAfter})
	}
	if v.Kind == "resource" {
		return MarshalWire(map[string]any{"kind": v.Kind, "resource": v.Resource, "offset": v.Offset, "data": v.Data, "eof": v.EOF})
	}
	return nil, errInvalid
}
func contentResult(data json.RawMessage) bool {
	var k struct {
		Kind string `json:"kind"`
	}
	if json.Unmarshal(data, &k) != nil {
		return false
	}
	if k.Kind == "timeline" {
		return validateObject(data, schema{"kind": enum("timeline"), "historyEpoch": identifier, "items": many(func(v json.RawMessage) bool { _, err := DecodeTimeline(v); return err == nil }, 0, 200, "entryId"), "resources": many(func(v json.RawMessage) bool { _, err := DecodeResource(v); return err == nil }, 0, 1000, "resourceId"), "beforeCursor": optional(relayString(512)), "afterCursor": optional(relayString(512)), "hasMoreBefore": boolean, "hasMoreAfter": boolean})
	}
	if k.Kind == "resource" {
		return validateObject(data, schema{"kind": enum("resource"), "resource": func(v json.RawMessage) bool { _, err := DecodeResource(v); return err == nil }, "offset": zeroSequence, "data": func(v json.RawMessage) bool {
			var s string
			if json.Unmarshal(v, &s) != nil || len(s) > base64.StdEncoding.EncodedLen(MaxContentChunkBytes) {
				return false
			}
			decoded, err := base64.StdEncoding.Strict().DecodeString(s)
			return err == nil && len(decoded) <= MaxContentChunkBytes && base64.StdEncoding.EncodeToString(decoded) == s
		}, "eof": boolean})
	}
	return false
}
func DecodeContentResult(data []byte) (ContentResult, error) {
	var out ContentResult
	if !validUnicode(data) || !contentResult(data) || json.Unmarshal(data, &out) != nil {
		return out, errInvalid
	}
	if out.Kind == "timeline" {
		var raw struct {
			Items []json.RawMessage `json:"items"`
		}
		_ = json.Unmarshal(data, &raw)
		out.Items = make([]TimelineEntry, 0, len(raw.Items))
		var previous int64
		for _, v := range raw.Items {
			entry, err := DecodeTimeline(v)
			if err != nil {
				return ContentResult{}, err
			}
			n, _ := strconv.ParseInt(entry.EntrySeq, 10, 64)
			if n <= previous {
				return ContentResult{}, errInvalid
			}
			previous = n
			out.Items = append(out.Items, entry)
		}
	}
	return out, nil
}
func pendingTimeline(data json.RawMessage) bool {
	v, err := DecodeTimeline(data)
	if err != nil || v.Kind != "interaction" {
		return false
	}
	var i struct {
		State string `json:"state"`
	}
	return json.Unmarshal(v.Data["interaction"], &i) == nil && i.State == "pending"
}
