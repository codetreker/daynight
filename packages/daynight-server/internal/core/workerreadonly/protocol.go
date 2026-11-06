// Package workerreadonly owns bounded, connection-fenced Worker read operations.
package workerreadonly

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

const Protocol = "daynight.worker-readonly.v1"
const MaxWireBytes = 256 << 10
const MaxResultBytes = 64 << 10
const RequestTimeout = 10 * time.Second

type Hello struct {
	Type                 string   `json:"type"`
	Protocol             string   `json:"protocol"`
	CapabilityGeneration string   `json:"capabilityGeneration"`
	Operations           []string `json:"operations"`
}
type Fence struct {
	Protocol             string `json:"protocol"`
	OwnerUserID          string `json:"ownerUserId"`
	WorkerID             string `json:"workerId"`
	ConnectionID         string `json:"connectionId"`
	CapabilityGeneration string `json:"capabilityGeneration"`
}
type Request struct {
	RequestID string          `json:"requestId"`
	Operation string          `json:"operation"`
	Input     json.RawMessage `json:"input"`
}
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
type Message struct {
	Fence
	Type      string          `json:"type"`
	RequestID string          `json:"requestId,omitempty"`
	Operation string          `json:"operation,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	TimeoutMs int             `json:"timeoutMs,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *Error          `json:"error,omitempty"`
}
type DirectoryInput struct {
	Path       *string `json:"path,omitempty"`
	Filter     *string `json:"filter,omitempty"`
	ShowHidden *bool   `json:"showHidden,omitempty"`
	Limit      *int    `json:"limit,omitempty"`
	Cursor     *string `json:"cursor,omitempty"`
}
type DirectoryEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}
type DirectoryResult struct {
	Path       string           `json:"path"`
	ParentPath *string          `json:"parentPath"`
	Entries    []DirectoryEntry `json:"entries"`
	NextCursor *string          `json:"nextCursor"`
}

func fault(code, message string) error { return &model.Fault{Code: code, Message: message} }
func validID(s string) bool {
	v, e := uuid.Parse(s)
	return e == nil && v.String() == s && v != uuid.Nil
}
func Decode(raw []byte, out any) error {
	if len(raw) > MaxWireBytes {
		return fault("invalid_input", "Worker read-only message is too large.")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if e := d.Decode(out); e != nil {
		return fault("invalid_input", "Worker read-only message is invalid.")
	}
	if e := d.Decode(new(any)); e != io.EOF {
		return fault("invalid_input", "Worker read-only message must contain one JSON object.")
	}
	return nil
}
func ValidateHello(h Hello) error {
	if h.Type != "hello" || h.Protocol != Protocol || !validID(h.CapabilityGeneration) || len(h.Operations) < 1 || len(h.Operations) > 2 {
		return fault("unsupported", "Worker read-only protocol or operations are not supported.")
	}
	seen := map[string]bool{}
	for _, operation := range h.Operations {
		if operation != "directory.list" && operation != "model.list" || seen[operation] {
			return fault("unsupported", "Worker read-only operations are invalid.")
		}
		seen[operation] = true
	}
	return nil
}
func ValidateRequest(r Request) error {
	if !validID(r.RequestID) {
		return fault("invalid_input", "requestId must be a canonical UUID.")
	}
	if r.Operation == "model.list" {
		return validateModelInput(r.Input)
	}
	if r.Operation != "directory.list" {
		return fault("unsupported", "Worker read-only operation is not supported.")
	}
	var in DirectoryInput
	if len(r.Input) == 0 || bytes.Equal(bytes.TrimSpace(r.Input), []byte("null")) {
		return fault("invalid_input", "Directory input must be an object.")
	}
	if e := Decode(r.Input, &in); e != nil {
		return e
	}
	var fields map[string]json.RawMessage
	if e := json.Unmarshal(r.Input, &fields); e != nil || fields == nil {
		return fault("invalid_input", "Directory input must be an object.")
	}
	for _, raw := range fields {
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return fault("invalid_input", "Directory input fields cannot be null.")
		}
	}
	for _, field := range []struct {
		value *string
		limit int
	}{{in.Path, 4096}, {in.Filter, 256}, {in.Cursor, 4096}} {
		if field.value != nil && (len(*field.value) > field.limit || strings.ContainsRune(*field.value, 0)) {
			return fault("invalid_input", "Directory input string exceeds its limits.")
		}
	}

	if in.Limit != nil && (*in.Limit < 1 || *in.Limit > 100) {
		return fault("invalid_input", "Directory page limit must be between 1 and 100.")
	}
	return nil
}
func ValidateResult(m Message) error {
	return ValidateOperationResult(m, "directory.list")
}

// ValidateOperationResult binds the result shape to the admitted request operation.
func ValidateOperationResult(m Message, operation string) error {
	if operation != "directory.list" && operation != "model.list" {
		return fault("unsupported", "Worker read-only operation is not supported.")
	}
	if err := validateResultEnvelope(m); err != nil {
		return err
	}
	if m.Error != nil {
		return nil
	}
	if operation == "model.list" {
		return validateModelResult(m.Result)
	}
	var result DirectoryResult
	if e := Decode(m.Result, &result); e != nil {
		return e
	}
	var fields map[string]json.RawMessage
	if e := json.Unmarshal(m.Result, &fields); e != nil || len(fields) != 4 || result.Path == "" || len(result.Path) > 4096 || result.Entries == nil || len(result.Entries) > 100 {
		return fault("invalid_input", "Worker directory response is invalid.")
	}
	for _, key := range []string{"path", "parentPath", "entries", "nextCursor"} {
		if _, ok := fields[key]; !ok {
			return fault("invalid_input", "Worker directory response is incomplete.")
		}
	}
	for _, e := range result.Entries {
		if e.Name == "" || e.Path == "" || len(e.Name) > 1024 || len(e.Path) > 4096 {
			return fault("invalid_input", "Worker directory entry is invalid.")
		}
	}
	return nil
}

func validateResultEnvelope(m Message) error {
	if m.Type != "result" || !validID(m.RequestID) || len(m.Input) > 0 || m.Operation != "" || m.TimeoutMs != 0 {
		return fault("invalid_input", "Worker read-only response envelope is invalid.")
	}
	if (len(m.Result) > 0) == (m.Error != nil) {
		return fault("invalid_input", "Worker response requires exactly one result or error.")
	}
	if m.Error != nil {
		allowed := map[string]bool{"offline": true, "unsupported": true, "permission_denied": true, "not_found": true, "timeout": true, "cancelled": true, "invalid_path": true, "invalid_cursor": true, "io_error": true, "busy": true, "limit_exceeded": true, "invalid_input": true, "capability_error": true, "cleanup_unknown": true, "stale_configuration": true}
		if !allowed[m.Error.Code] || m.Error.Message == "" || len(m.Error.Message) > 1024 {
			return fault("invalid_input", "Worker response error is invalid.")
		}
		return nil
	}
	if len(m.Result) > MaxResultBytes {
		return fault("invalid_input", "Worker read-only response exceeds its byte limit.")
	}
	return nil
}
func ErrorCode(err error) string {
	var f *model.Fault
	if errors.As(err, &f) {
		return f.Code
	}
	return "io_error"
}
