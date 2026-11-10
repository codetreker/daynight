package sessionprotocol

import (
	"encoding/json"
	"time"
)

const MaxHistoryResponseBytes = 256 * 1024
const MaxEntryChunkBytes = 32 * 1024
const MaxHistoryCursorBytes = 4096

type EntryContentRef struct {
	Cursor     string `json:"cursor"`
	SHA256     string `json:"sha256"`
	ByteLength string `json:"byteLength"`
}
type InspectionResource struct {
	ResourceID string  `json:"resourceId"`
	Status     string  `json:"status"`
	Name       string  `json:"name"`
	MediaType  *string `json:"mediaType"`
	ByteLength *string `json:"byteLength"`
	SHA256     *string `json:"sha256"`
}
type MessageItem struct {
	EntryID            string               `json:"entryId"`
	EntrySeq           string               `json:"entrySeq"`
	Revision           string               `json:"revision"`
	Kind               string               `json:"kind"`
	Role               *string              `json:"role"`
	Timestamp          *string              `json:"timestamp"`
	Body               json.RawMessage      `json:"body"`
	Truncated          bool                 `json:"truncated"`
	ContentRef         *EntryContentRef     `json:"contentRef"`
	Resources          []InspectionResource `json:"resources"`
	ResourcesTruncated bool                 `json:"resourcesTruncated"`
}
type HistoryCoverage struct {
	State  string  `json:"state"`
	Reason *string `json:"reason"`
}

func inspectionCoverage(data json.RawMessage) bool {
	if !validateObject(data, schema{"state": enum("complete", "partial"), "reason": optional(enum("entry_truncated", "resource_unavailable"))}) {
		return false
	}
	var coverage HistoryCoverage
	_ = json.Unmarshal(data, &coverage)
	return (coverage.State == "complete") == (coverage.Reason == nil)
}

type MessagePage struct {
	SessionID     string          `json:"sessionId"`
	HistoryEpoch  string          `json:"historyEpoch"`
	Source        string          `json:"source"`
	Items         []MessageItem   `json:"items"`
	BeforeCursor  *string         `json:"beforeCursor"`
	HasMoreBefore bool            `json:"hasMoreBefore"`
	Coverage      HistoryCoverage `json:"coverage"`
	ObservedAt    time.Time       `json:"observedAt"`
}
type EntryChunk struct {
	SessionID    string    `json:"sessionId"`
	HistoryEpoch string    `json:"historyEpoch"`
	Source       string    `json:"source"`
	EntryID      string    `json:"entryId"`
	Revision     string    `json:"revision"`
	SHA256       string    `json:"sha256"`
	ByteLength   string    `json:"byteLength"`
	Offset       string    `json:"offset"`
	Fragment     string    `json:"fragment"`
	NextCursor   *string   `json:"nextCursor"`
	EOF          bool      `json:"eof"`
	ObservedAt   time.Time `json:"observedAt"`
}
type TaskSessionCurrent struct {
	Status           string                 `json:"status"`
	ClaimID          *string                `json:"claimId"`
	AgentControlMode *string                `json:"agentControlMode"`
	Session          *TaskSessionInspection `json:"session"`
}
type SessionDirectoryArchive struct {
	State        string  `json:"state"`
	SHA256       *string `json:"sha256"`
	ByteLength   *string `json:"byteLength"`
	Completeness *string `json:"completeness"`
}
type TaskSessionDirectoryItem struct {
	SessionID           string                  `json:"sessionId"`
	ClaimID             string                  `json:"claimId"`
	ExecutionGeneration string                  `json:"executionGeneration"`
	AgentControlMode    string                  `json:"agentControlMode"`
	ContentKind         string                  `json:"contentKind"`
	CreatedAt           string                  `json:"createdAt"`
	EndedAt             *string                 `json:"endedAt"`
	CurrentBinding      bool                    `json:"currentBinding"`
	Archive             SessionDirectoryArchive `json:"archive"`
}
type TaskSessionList struct {
	Items      []TaskSessionDirectoryItem `json:"items"`
	NextCursor *string                    `json:"nextCursor"`
}

func inspectionItem(data json.RawMessage) bool {
	ref := nested(schema{"cursor": relayString(MaxHistoryCursorBytes), "sha256": pattern(`^[a-f0-9]{64}$`), "byteLength": sequence})
	resource := nested(schema{"resourceId": identifier, "status": enum("pending", "available", "unavailable", "failed"), "name": relayString(1024), "mediaType": optional(relayString(256)), "byteLength": optional(zeroSequence), "sha256": optional(pattern(`^[a-f0-9]{64}$`))})
	if !validateObject(data, schema{"entryId": identifier, "entrySeq": sequence, "revision": sequence, "kind": enum("user_message", "assistant_message", "reasoning", "tool_call", "interaction", "error", "compaction", "todo"), "role": optional(enum("user", "assistant")), "timestamp": optional(timestamp), "body": optional(func(v json.RawMessage) bool { _, e := DecodeTimeline(v); return e == nil }), "truncated": boolean, "contentRef": optional(ref), "resources": many(resource, 0, 20, "resourceId"), "resourcesTruncated": boolean}) {
		return false
	}
	var item MessageItem
	if json.Unmarshal(data, &item) != nil || item.Truncated != (item.ContentRef != nil) || item.Truncated != (string(item.Body) == "null") {
		return false
	}
	expectedRole := ""
	if item.Kind == "user_message" {
		expectedRole = "user"
	} else if item.Kind == "assistant_message" {
		expectedRole = "assistant"
	}
	if expectedRole == "" && item.Role != nil || expectedRole != "" && (item.Role == nil || *item.Role != expectedRole) {
		return false
	}
	if !item.Truncated {
		entry, err := DecodeTimeline(item.Body)
		return err == nil && entry.EntryID == item.EntryID && entry.EntrySeq == item.EntrySeq && entry.Revision == item.Revision && entry.Kind == item.Kind
	}
	return true
}
