package mcp

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	ss "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

type sessionHistoryReader interface {
	Current(context.Context, model.Principal, string, string) (sp.TaskSessionCurrent, error)
	List(context.Context, model.Principal, string, string, string, int) (sp.TaskSessionList, error)
	Read(context.Context, model.Principal, string, string, string, ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error)
	Entry(context.Context, model.Principal, string, string, string, ss.EntryRequest) (*ss.ReadResult[sp.EntryChunk], error)
}
type sessionInspector interface {
	Inspect(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error)
}
type sessionReadInput struct {
	ProjectID    string `json:"projectId"`
	TaskID       string `json:"taskId"`
	SessionID    string `json:"sessionId"`
	Cursor       string `json:"cursor"`
	Before       string `json:"before"`
	Limit        *int   `json:"limit"`
	Conversation bool   `json:"conversation"`
}

// RegisterSessionReadTools exposes Task-authorized identity and content reads.
// History uses Large admission because an archive can require materialization.
func RegisterSessionReadTools(entry *Entry, history sessionHistoryReader, inspection sessionInspector) error {
	if entry == nil || history == nil || inspection == nil {
		return fmt.Errorf("MCP Session reads require an entry, history and inspection services")
	}
	for _, name := range []string{"current", "list", "show", "read", "entry"} {
		class := BudgetControl
		if name == "read" || name == "entry" {
			class = BudgetLarge
		}
		err := registerTypedReadTool(entry, sessionReadToolDefinition(name), class, func(ctx context.Context, actor RequestActor, in sessionReadInput) (ToolResult, error) {
			refs := map[string]any{"projectId": in.ProjectID, "taskId": in.TaskID}
			if in.SessionID != "" {
				refs["sessionId"] = in.SessionID
			}
			result := ToolResult{Refs: refs}
			limit := 20
			if in.Limit != nil {
				limit = *in.Limit
			}
			var err error
			switch name {
			case "current":
				var value sp.TaskSessionCurrent
				value, err = history.Current(ctx, actor.Principal, in.ProjectID, in.TaskID)
				result.Data = value
				if err == nil && value.Session != nil {
					result.Observation = sessionReadObservation(*value.Session)
				}
			case "list":
				result.Data, err = history.List(ctx, actor.Principal, in.ProjectID, in.TaskID, in.Cursor, limit)
			case "show":
				var value sp.TaskSessionInspection
				value, err = inspection.Inspect(ctx, actor.Principal, in.ProjectID, in.TaskID, in.SessionID)
				result.Data = value
				if err == nil {
					result.Observation = sessionReadObservation(value)
				}
			default:
				overhead, e := workResponseOverhead(actor, refs)
				if e != nil {
					return result, e
				}
				if overhead >= sp.MaxHistoryResponseBytes {
					return result, &model.Fault{Code: "resource_limit_exceeded", Message: "The Session history response envelope exceeds its limit."}
				}
				if name == "read" {
					read, e := history.Read(ctx, actor.Principal, in.ProjectID, in.TaskID, in.SessionID, ss.ReadRequest{Limit: limit, Before: in.Before, Conversation: in.Conversation, ResponseOverhead: overhead})
					if read != nil {
						retainSessionRead(ctx, entry, read)
					}
					if e != nil {
						return result, e
					}
					if read == nil {
						return result, fmt.Errorf("Session history service returned no page")
					}
					result.Data = read.Data
					result.Observation = &ReadObservation{ObservedAt: read.Data.ObservedAt, Partial: read.Data.Coverage.State == "partial"}
				} else {
					read, e := history.Entry(ctx, actor.Principal, in.ProjectID, in.TaskID, in.SessionID, ss.EntryRequest{Cursor: in.Cursor, ResponseOverhead: overhead})
					if read != nil {
						retainSessionRead(ctx, entry, read)
					}
					if e != nil {
						return result, e
					}
					if read == nil {
						return result, fmt.Errorf("Session history service returned no entry")
					}
					result.Data = read.Data
					result.Observation = &ReadObservation{ObservedAt: read.Data.ObservedAt}
				}
			}
			if err == nil && result.Observation == nil {
				result.Observation = &ReadObservation{ObservedAt: time.Now().UTC()}
			}
			return result, err
		}, "projectId", "taskId", "sessionId", "cursor", "before")
		if err != nil {
			return err
		}
	}
	return nil
}

func sessionReadObservation(value sp.TaskSessionInspection) *ReadObservation {
	stamp := time.Now().UTC()
	if value.Session.ObservedAt != nil {
		stamp = *value.Session.ObservedAt
	}
	return &ReadObservation{ObservedAt: stamp, Partial: value.Session.Observation == "unavailable"}
}

func retainSessionRead(ctx context.Context, entry *Entry, lease io.Closer) {
	release := func() {
		if err := lease.Close(); err != nil {
			httpx.LogFailure(entry.logger, ctx, "mcp", "session_read_cleanup", err)
		}
	}
	if scope, ok := ctx.Value(scopeKey{}).(*requestScope); ok {
		scope.hold(release)
	} else {
		release()
	}
}
