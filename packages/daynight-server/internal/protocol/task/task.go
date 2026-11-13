// Package task owns Task protocol projections shared by admission and responses.
package task

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"maps"
	"math"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/measure"
)

type REST struct {
	Progress          *model.GoalProgress        `json:"progress,omitempty"`
	Properties        map[string]json.RawMessage `json:"properties"`
	Tags              []RESTTagReference         `json:"tags"`
	ID                string                     `json:"id"`
	ProjectID         string                     `json:"projectId"`
	Type              model.TaskType             `json:"type"`
	ParentID          *string                    `json:"parentId"`
	Title             string                     `json:"title"`
	Description       string                     `json:"description"`
	Status            string                     `json:"status"`
	Version           int64                      `json:"version"`
	CreatedAt         time.Time                  `json:"createdAt"`
	UpdatedAt         time.Time                  `json:"updatedAt"`
	StartedAt         *time.Time                 `json:"startedAt"`
	CompletedAt       *time.Time                 `json:"completedAt"`
	CancelledAt       *time.Time                 `json:"cancelledAt"`
	DependsOn         []string                   `json:"dependsOn"`
	ExternalDependsOn []string                   `json:"externalDependsOn"`
	BlockedBy         []string                   `json:"blockedBy"`
	RequiredPlatform  *string                    `json:"requiredPlatform"`
	AssignedTo        *string                    `json:"assignedTo"`
	AllowAgents       bool                       `json:"allowAgents"`
	Ready             bool                       `json:"ready"`
}

type RESTTagReference struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// SyncRecord is the REST projection shared by sync accounting and output.
type SyncRecord struct {
	Properties        map[string]json.RawMessage `json:"properties"`
	Tags              []RESTTagReference         `json:"tags"`
	ID                string                     `json:"id"`
	Type              model.TaskType             `json:"type"`
	ParentID          *string                    `json:"parentId"`
	TitlePreview      string                     `json:"titlePreview"`
	TitleTruncated    bool                       `json:"titleTruncated"`
	Status            string                     `json:"status"`
	Version           string                     `json:"version"`
	DependsOn         []string                   `json:"dependsOn"`
	ExternalDependsOn []string                   `json:"externalDependsOn"`
	RequiredPlatform  *string                    `json:"requiredPlatform"`
	AssignedTo        *string                    `json:"assignedTo"`
	AllowAgents       bool                       `json:"allowAgents"`
	CreatedAt         time.Time                  `json:"createdAt"`
	UpdatedAt         time.Time                  `json:"updatedAt"`
	StartedAt         *time.Time                 `json:"startedAt"`
	CompletedAt       *time.Time                 `json:"completedAt"`
	CancelledAt       *time.Time                 `json:"cancelledAt"`
}

func RESTSyncRecord(t model.TaskViewRecord) SyncRecord {
	var platform *string
	if t.RequiredPlatform != nil {
		value := string(*t.RequiredPlatform)
		platform = &value
	}
	return SyncRecord{Properties: properties(t.Properties, false), Tags: RESTTags(t.Tags), ID: t.ID, Type: t.Type, ParentID: t.ParentID, TitlePreview: t.TitlePreview, TitleTruncated: t.TitleTruncated,
		Status: string(t.Status), Version: strconv.FormatInt(t.Version, 10), DependsOn: array(t.DependsOn, false), ExternalDependsOn: array(t.ExternalDependsOn, false),
		RequiredPlatform: platform, AssignedTo: t.AssignedTo, AllowAgents: t.AllowAgents, CreatedAt: t.CreatedAt.UTC(), UpdatedAt: t.UpdatedAt.UTC(),
		StartedAt: optionalTime(t.StartedAt), CompletedAt: optionalTime(t.CompletedAt), CancelledAt: optionalTime(t.CancelledAt)}
}

// LegacyWorkerCompatible identifies claims expressible by the older wire format.
func LegacyWorkerCompatible(worker *model.WorkerClaim) bool {
	return worker == nil || ((worker.AgentControlMode == "" || worker.AgentControlMode == model.AgentControlModeHerdr) && (worker.Agent == model.AgentCodex || worker.Agent == model.AgentCopilot))
}
func optionalTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	v := value.UTC()
	return &v
}
func RESTTask(t model.Task, extended bool) (REST, error) { return restTask(t, extended, true) }
func RESTTags(tags []model.TagReference) []RESTTagReference {
	result := make([]RESTTagReference, len(tags))
	for i, tag := range tags {
		result[i] = RESTTagReference{ID: tag.ID, Name: tag.Name}
	}
	return result
}
func restTask(t model.Task, extended, copyValues bool) (REST, error) {
	var platform *string
	if t.RequiredPlatform != nil {
		value := string(*t.RequiredPlatform)
		platform = &value
	}
	result := REST{Progress: t.Progress, ID: t.ID, ProjectID: t.ProjectID, Type: t.Type, ParentID: t.ParentID, Title: t.Title, Description: t.Description, Properties: properties(t.Properties, copyValues), Tags: RESTTags(t.Tags), Status: string(t.Status), Version: t.Version, CreatedAt: t.CreatedAt.UTC(), UpdatedAt: t.UpdatedAt.UTC(), StartedAt: optionalTime(t.StartedAt), CompletedAt: optionalTime(t.CompletedAt), CancelledAt: optionalTime(t.CancelledAt), DependsOn: array(t.DependsOn, copyValues), ExternalDependsOn: array(t.ExternalDependsOn, copyValues), BlockedBy: array(t.BlockedBy, copyValues), Ready: t.Ready, AllowAgents: t.AllowAgents, RequiredPlatform: platform, AssignedTo: t.AssignedTo}
	if extended {
		return result, nil
	}
	worker, err := taskproperty.Worker(t.Properties)
	if err != nil {
		return REST{}, err
	}
	if !LegacyWorkerCompatible(worker) {
		delete(result.Properties, "worker")
	} else if worker != nil {
		var fields map[string]json.RawMessage
		if err = json.Unmarshal(result.Properties["worker"], &fields); err != nil {
			return REST{}, err
		}
		delete(fields, "agentControlMode")
		value, err := json.Marshal(fields)
		if err != nil {
			return REST{}, err
		}
		result.Properties["worker"] = value
	}
	return result, nil
}

// EncodeREST uses the same default encoding and terminal newline as HTTP.
// ErrLegacyWorkerIndeterminate means legacy projection requires decoding more
// data than the provided budget and cannot yet determine the output size.
var ErrLegacyWorkerIndeterminate = errors.New("legacy worker projection exceeds measurement input budget")

type restWire REST

// MarshalJSON makes the production response use the same encoder as admission.
func (v REST) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	_, err := measure.JSON(&b, "task", math.MaxInt64, restWire(v), false)
	return b.Bytes(), err
}

func EncodeREST(w io.Writer, t model.Task, extended bool, max int64) (int64, error) {
	if !extended && int64(len(t.Properties["worker"])) > max {
		return 0, ErrLegacyWorkerIndeterminate
	}
	v, err := restTask(t, extended, false)
	if err != nil {
		return 0, err
	}
	return measure.JSON(w, "task", max, restWire(v), true)
}

type MCPFull struct {
	Progress          *model.GoalProgress        `json:"progress,omitempty"`
	Tags              []RESTTagReference         `json:"tags"`
	Projection        string                     `json:"projection"`
	ID                string                     `json:"id"`
	ProjectID         string                     `json:"projectId"`
	Type              model.TaskType             `json:"type"`
	ParentID          *string                    `json:"parentId"`
	Title             string                     `json:"title"`
	Description       string                     `json:"description"`
	Properties        map[string]json.RawMessage `json:"properties"`
	Status            model.TaskStatus           `json:"status"`
	Version           string                     `json:"version"`
	CreatedAt         time.Time                  `json:"createdAt"`
	UpdatedAt         time.Time                  `json:"updatedAt"`
	StartedAt         *time.Time                 `json:"startedAt"`
	CompletedAt       *time.Time                 `json:"completedAt"`
	CancelledAt       *time.Time                 `json:"cancelledAt"`
	DependsOn         []string                   `json:"dependsOn"`
	ExternalDependsOn []string                   `json:"externalDependsOn"`
	BlockedBy         []string                   `json:"blockedBy"`
	RequiredPlatform  *model.TaskPlatform        `json:"requiredPlatform"`
	AssignedTo        *string                    `json:"assignedTo"`
	AllowAgents       bool                       `json:"allowAgents"`
	Ready             bool                       `json:"ready"`
}

// MapTaskFull copies each raw property value without rewriting arbitrary JSON numbers.
func MCPTask(t model.Task) MCPFull { return mcpTask(t, true) }

type MCPSummary struct {
	Tags             []RESTTagReference  `json:"tags"`
	Projection       string              `json:"projection"`
	ID               string              `json:"id"`
	ProjectID        string              `json:"projectId"`
	Type             model.TaskType      `json:"type"`
	ParentID         *string             `json:"parentId"`
	TitlePreview     string              `json:"titlePreview"`
	TitleTruncated   bool                `json:"titleTruncated"`
	Status           model.TaskStatus    `json:"status"`
	Version          string              `json:"version"`
	Ready            bool                `json:"ready"`
	BlockedByCount   int                 `json:"blockedByCount"`
	RequiredPlatform *model.TaskPlatform `json:"requiredPlatform"`
	AssignedTo       *string             `json:"assignedTo"`
	AllowAgents      bool                `json:"allowAgents"`
}

const MCPTitlePreviewBytes = 512

func MCPTaskSummary(t model.Task) MCPSummary {
	title := t.Title
	truncated := len(title) > MCPTitlePreviewBytes
	if truncated {
		end := MCPTitlePreviewBytes
		for end > 0 && !utf8.RuneStart(title[end]) {
			end--
		}
		title = title[:end]
	}
	return MCPSummary{Tags: RESTTags(t.Tags), Projection: "summary", ID: t.ID, ProjectID: t.ProjectID, Type: t.Type, ParentID: t.ParentID, TitlePreview: title, TitleTruncated: truncated, Status: t.Status, Version: strconv.FormatInt(t.Version, 10), Ready: t.Ready, BlockedByCount: len(t.BlockedBy), RequiredPlatform: t.RequiredPlatform, AssignedTo: t.AssignedTo, AllowAgents: t.AllowAgents}
}
func mcpTask(t model.Task, copyValues bool) MCPFull {
	properties := properties(t.Properties, copyValues)
	return MCPFull{Progress: t.Progress, Tags: RESTTags(t.Tags), Projection: "full", ID: t.ID, ProjectID: t.ProjectID, Type: t.Type, ParentID: t.ParentID, Title: t.Title, Description: t.Description, Properties: properties,
		Status: t.Status, Version: strconv.FormatInt(t.Version, 10), CreatedAt: t.CreatedAt.UTC(), UpdatedAt: t.UpdatedAt.UTC(),
		StartedAt: optionalTime(t.StartedAt), CompletedAt: optionalTime(t.CompletedAt), CancelledAt: optionalTime(t.CancelledAt), DependsOn: array(t.DependsOn, copyValues),
		ExternalDependsOn: array(t.ExternalDependsOn, copyValues), BlockedBy: array(t.BlockedBy, copyValues),
		RequiredPlatform: t.RequiredPlatform, AssignedTo: t.AssignedTo, AllowAgents: t.AllowAgents, Ready: t.Ready}
}

// MCPEnvelope is the structured-content success envelope emitted by MCP tools.
type MCPEnvelope struct {
	Data any      `json:"data,omitempty"`
	Meta *MCPMeta `json:"meta,omitempty"`
}
type MCPMeta struct {
	RequestID string `json:"requestId"`
	Outcome   string `json:"outcome,omitempty"`
}

func EncodeMCP(w io.Writer, t model.Task, requestID, outcome string, max int64) (int64, error) {
	return EncodeMCPProjection(w, mcpTask(t, false), requestID, outcome, max)
}

// EncodeMCPProjection encodes the structured content for an already projected Task.
func EncodeMCPProjection(w io.Writer, task MCPFull, requestID, outcome string, max int64) (int64, error) {
	return measure.JSON(w, "task", max, MCPEnvelope{Data: task, Meta: &MCPMeta{RequestID: requestID, Outcome: outcome}}, false)
}

// EncodeMCPResponse measures the JSON-RPC success object emitted by the SDK.
// HTML escaping of the RPC ID is conservative: the SDK disables it for the
// outer envelope, while the structured result uses the default JSON encoding.
func EncodeMCPResponse(w io.Writer, t model.Task, requestID, outcome string, rpcID any, modern, full bool, max int64) (int64, error) {
	var data any = MCPTaskSummary(t)
	if full {
		data = mcpTask(t, false)
	}
	return EncodeMCPDataResponse(w, data, requestID, outcome, rpcID, modern, max)
}

// EncodeMCPDataResponse measures the SDK's complete success response for a
// protocol data value, including the JSON-RPC ID and version-specific fields.
func EncodeMCPDataResponse(w io.Writer, data any, requestID, outcome string, rpcID any, modern bool, max int64) (int64, error) {
	type content struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	type result struct {
		Meta              map[string]any `json:"_meta,omitempty"`
		Content           []content      `json:"content"`
		StructuredContent MCPEnvelope    `json:"structuredContent"`
		ResultType        string         `json:"resultType,omitempty"`
	}
	type response struct {
		JSONRPC string `json:"jsonrpc"`
		ID      any    `json:"id,omitempty"`
		Result  result `json:"result"`
	}
	r := result{Content: []content{{Type: "text", Text: "Completed."}}, StructuredContent: MCPEnvelope{Data: data, Meta: &MCPMeta{RequestID: requestID, Outcome: outcome}}}
	if modern {
		r.Meta = map[string]any{"io.modelcontextprotocol/serverInfo": map[string]any{"name": "daynight", "version": "1"}}
		r.ResultType = "complete"
	}
	return measure.JSON(w, "task", max, response{JSONRPC: "2.0", ID: rpcID, Result: r}, false)
}

// Admission borrows immutable values. Public response projections retain
// independent copies.
func properties(value model.TaskProperties, copyValues bool) map[string]json.RawMessage {
	if copyValues {
		return taskproperty.Clone(value)
	}
	if value == nil {
		return map[string]json.RawMessage{}
	}
	return maps.Clone(value)
}
func array(value []string, copyValues bool) []string {
	if value == nil {
		return []string{}
	}
	if copyValues {
		return append([]string{}, value...)
	}
	return value
}
