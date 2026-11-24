package sessionprotocol

import (
	"encoding/json"
	"strconv"

	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

const BotHistoryWindowVersion = 1
const MaxBotHistoryWindowEntries = 500
const MaxBotHistoryWindowPreviewBytes = 32 * 1024

// BotHistoryWindowEntryDigest binds the complete preview and resource references
// to the checkpoint with the same canonical JSON encoding on Go and TypeScript.
func BotHistoryWindowEntryDigest(entry BotHistoryWindowEntry) (string, error) {
	data, err := v2.CanonicalJSON(entry)
	if err != nil {
		return "", err
	}
	if !botWindowEntry(data) {
		return "", errInvalid
	}
	return v2.HashBytes(data), nil
}

// BotHistoryWindowBoundary describes retained display content, independently of
// operation receipts, pending approvals and Provider recovery material.
type BotHistoryWindowBoundary struct {
	ControllerFence
	BotHistoryWindowVersion   int     `json:"botHistoryWindowVersion"`
	HistoryEpoch              string  `json:"historyEpoch"`
	WindowRevision            string  `json:"windowRevision"`
	RetainedFromSeq           *string `json:"retainedFromSeq"`
	ThroughSeq                *string `json:"throughSeq"`
	EarlierHistoryUnavailable bool    `json:"earlierHistoryUnavailable"`
}

// Preview never promises that an omitted suffix remains downloadable.
type BotHistoryWindowEntry struct {
	EntryID           string                `json:"entryId"`
	EntrySeq          string                `json:"entrySeq"`
	Revision          string                `json:"revision"`
	Kind              string                `json:"kind"`
	Preview           string                `json:"preview"`
	Truncated         bool                  `json:"truncated"`
	OriginalBytes     *string               `json:"originalBytes"`
	PreviewBytes      string                `json:"previewBytes"`
	OmissionReason    *string               `json:"omissionReason"`
	OmittedEntryCount int                   `json:"omittedEntryCount"`
	ResourceIDs       []string              `json:"resourceIds"`
	Tool              *BotHistoryWindowTool `json:"tool"`
}

// Tool metadata retains unknown fields explicitly. Command truncation is part
// of the enclosing entry's omission facts and cannot imply a full command.
type BotHistoryWindowTool struct {
	ToolName *string `json:"toolName"`
	Command  *string `json:"command"`
	CWD      *string `json:"cwd"`
	Status   *string `json:"status"`
	ExitCode *int    `json:"exitCode"`
}

type BotHistoryWindowPage struct {
	BotHistoryWindowBoundary
	Kind              string                  `json:"kind"`
	Items             []BotHistoryWindowEntry `json:"items"`
	HasEarlierHistory bool                    `json:"hasEarlierHistory"`
	BeforeCursor      *string                 `json:"beforeCursor"`
	NextCursor        *string                 `json:"nextCursor"`
}

type BotHistoryWindowRequest struct {
	Kind             string  `json:"kind"`
	HistoryEpoch     string  `json:"historyEpoch"`
	Mode             string  `json:"mode"`
	Cursor           *string `json:"cursor"`
	Limit            int     `json:"limit"`
	ResponseOverhead int     `json:"responseOverhead"`
}

type BotHistoryCheckpointEntry struct {
	EntryID          string            `json:"entryId"`
	EntrySeq         string            `json:"entrySeq"`
	Revision         string            `json:"revision"`
	SHA256           string            `json:"sha256"`
	ResourceIDs      []string          `json:"resourceIds"`
	ImageOccurrences []ImageOccurrence `json:"imageOccurrences"`
}

type BotHistoryCheckpoint struct {
	BotHistoryWindowBoundary
	// SourceEpoch qualifies the source watermark independently of logical history.
	SourceEpoch   string                      `json:"sourceEpoch"`
	SourceThrough string                      `json:"sourceThrough"`
	Entries       []BotHistoryCheckpointEntry `json:"entries"`
}

type BotHistoryCheckpointReceipt struct {
	BotHistoryWindowBoundary
	SourceEpoch    string `json:"sourceEpoch"`
	SourceThrough  string `json:"sourceThrough"`
	CleanupPending bool   `json:"cleanupPending"`
}

var botWindowBoundarySchema = schema{
	"sessionId": identifier, "testExecutionId": identifier,
	"executionGeneration": sequence, "connectionEpoch": sequence,
	"botHistoryWindowVersion": version, "historyEpoch": identifier,
	"windowRevision": sequence, "retainedFromSeq": optional(sequence),
	"throughSeq": optional(sequence), "earlierHistoryUnavailable": boolean,
}

var botWindowCursorAlphabet = pattern(`^[A-Za-z0-9_-]+$`)

func botWindowCursor(data json.RawMessage) bool {
	return relayString(MaxHistoryCursorBytes)(data) && botWindowCursorAlphabet(data)
}

func windowNumber(value string) int64 { n, _ := strconv.ParseInt(value, 10, 64); return n }

func validBotWindowBoundary(v BotHistoryWindowBoundary) bool {
	if v.ThroughSeq == nil {
		return v.RetainedFromSeq == nil && !v.EarlierHistoryUnavailable
	}
	if v.RetainedFromSeq == nil {
		return v.EarlierHistoryUnavailable
	}
	return windowNumber(*v.RetainedFromSeq) <= windowNumber(*v.ThroughSeq)
}

func decodeBotWindow[T any](data []byte, fields schema) (T, error) {
	var result T
	if !validUnicode(data) || !validateObject(data, fields) {
		return result, errInvalid
	}
	var normalized map[string]json.RawMessage
	_ = json.Unmarshal(data, &normalized)
	normalized["botHistoryWindowVersion"] = json.RawMessage("1")
	canonical, _ := json.Marshal(normalized)
	if json.Unmarshal(canonical, &result) != nil {
		return result, errInvalid
	}
	return result, nil
}

func botWindowEntry(data json.RawMessage) bool {
	fields := schema{
		"entryId": identifier, "entrySeq": sequence, "revision": sequence,
		"kind":      enum("user_message", "assistant_message", "tool_call"),
		"preview":   func(v json.RawMessage) bool { return stringValue(v, true, MaxBotHistoryWindowPreviewBytes) },
		"truncated": boolean, "originalBytes": optional(zeroSequence), "previewBytes": zeroSequence,
		"omissionReason": optional(relayString(1024)), "omittedEntryCount": integerRange(0, 2147483647),
		"resourceIds": many(identifier, 0, 1000, "$"),
		"tool": optional(nested(schema{
			"toolName": optional(relayString(256)), "command": optional(func(v json.RawMessage) bool { return stringValue(v, true, 8192) }),
			"cwd": optional(relayString(4096)), "status": optional(relayString(256)), "exitCode": optional(integerRange(-2147483648, 2147483647)),
		})),
	}
	var v BotHistoryWindowEntry
	if !validateObject(data, fields) || json.Unmarshal(data, &v) != nil || windowNumber(v.PreviewBytes) != int64(len(v.Preview)) {
		return false
	}
	if v.Truncated != (v.OmissionReason != nil) || v.OmittedEntryCount > 0 && (!v.Truncated || v.Kind != "tool_call") {
		return false
	}
	if v.Kind != "tool_call" && v.Tool != nil {
		return false
	}
	if !v.Truncated {
		return v.OriginalBytes != nil && *v.OriginalBytes == v.PreviewBytes
	}
	return v.OriginalBytes == nil || windowNumber(*v.OriginalBytes) >= windowNumber(v.PreviewBytes)
}

func DecodeBotHistoryWindowPage(data []byte) (BotHistoryWindowPage, error) {
	fields := extend(botWindowBoundarySchema, schema{
		"kind": enum("bot_history_window"), "items": many(botWindowEntry, 0, 200, "entryId"),
		"hasEarlierHistory": boolean, "beforeCursor": optional(botWindowCursor),
		"nextCursor": optional(botWindowCursor),
	})
	if len(data) > MaxHistoryResponseBytes {
		return BotHistoryWindowPage{}, errInvalid
	}
	v, err := decodeBotWindow[BotHistoryWindowPage](data, fields)
	if err != nil || !validBotWindowBoundary(v.BotHistoryWindowBoundary) || v.HasEarlierHistory != (v.BeforeCursor != nil) || v.BeforeCursor != nil && len(v.Items) == 0 {
		return BotHistoryWindowPage{}, errInvalid
	}
	var last int64
	for _, entry := range v.Items {
		n := windowNumber(entry.EntrySeq)
		if v.RetainedFromSeq == nil || n < windowNumber(*v.RetainedFromSeq) || n > windowNumber(*v.ThroughSeq) || n <= last {
			return BotHistoryWindowPage{}, errInvalid
		}
		last = n
	}
	return v, nil
}

func DecodeBotHistoryWindowRequest(data []byte) (BotHistoryWindowRequest, error) {
	v, err := decode[BotHistoryWindowRequest](data, nested(schema{
		"kind": enum("bot_history_window"), "historyEpoch": identifier,
		"mode": enum("tail", "before", "changes"), "cursor": optional(botWindowCursor),
		"limit": integerRange(1, 200), "responseOverhead": integerRange(0, MaxHistoryResponseBytes-1),
	}))
	if err != nil || (v.Mode == "tail") != (v.Cursor == nil) {
		return BotHistoryWindowRequest{}, errInvalid
	}
	return v, nil
}

func DecodeBotHistoryCheckpoint(data []byte) (BotHistoryCheckpoint, error) {
	fields := extend(botWindowBoundarySchema, schema{
		"sourceEpoch":   identifier,
		"sourceThrough": zeroSequence,
		"entries": many(nested(schema{
			"entryId": identifier, "entrySeq": sequence, "revision": sequence,
			"sha256": pattern(`^[a-f0-9]{64}$`), "resourceIds": many(identifier, 0, 1000, "$"),
			"imageOccurrences": many(validateOccurrence, 0, 1000, "imageId"),
		}), 0, MaxBotHistoryWindowEntries, "entryId"),
	})
	if len(data) > MaxFrameBytes {
		return BotHistoryCheckpoint{}, errInvalid
	}
	v, err := decodeBotWindow[BotHistoryCheckpoint](data, fields)
	if err != nil || !validBotWindowBoundary(v.BotHistoryWindowBoundary) || (len(v.Entries) == 0) != (v.RetainedFromSeq == nil) {
		return BotHistoryCheckpoint{}, errInvalid
	}
	var last int64
	imageIDs := map[string]bool{}
	for i, entry := range v.Entries {
		n := windowNumber(entry.EntrySeq)
		if n <= last || n > windowNumber(*v.ThroughSeq) || i == 0 && entry.EntrySeq != *v.RetainedFromSeq {
			return BotHistoryCheckpoint{}, errInvalid
		}
		last = n
		for _, occurrence := range entry.ImageOccurrences {
			if occurrence.EntryID != entry.EntryID || imageIDs[occurrence.ImageID] {
				return BotHistoryCheckpoint{}, errInvalid
			}
			imageIDs[occurrence.ImageID] = true
		}
	}
	return v, nil
}

func DecodeBotHistoryCheckpointReceipt(data []byte) (BotHistoryCheckpointReceipt, error) {
	v, err := decodeBotWindow[BotHistoryCheckpointReceipt](data, extend(botWindowBoundarySchema, schema{"sourceEpoch": identifier, "sourceThrough": zeroSequence, "cleanupPending": boolean}))
	if err != nil || !validBotWindowBoundary(v.BotHistoryWindowBoundary) {
		return BotHistoryCheckpointReceipt{}, errInvalid
	}
	return v, nil
}
