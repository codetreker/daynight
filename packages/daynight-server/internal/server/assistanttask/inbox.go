package assistanttask

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

// Inbox management is owner-only. A Bot identity is refused before decoding so
// an assistant cannot widen its own input channel, and the refusal never
// reaches the service.
func refuseBot(a core.Actor) error {
	if a.BotID != nil {
		return botRefusal
	}
	return nil
}

var botRefusal = &model.Fault{Code: "forbidden", Message: "Inbox management is not permitted with a Bot identity."}

func (h *handler) inbox(_ http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
	if err := noQuery(r); err != nil {
		return nil, err
	}
	value, err := h.tasks.GetInbox(r.Context(), a, taskID)
	return inboxResponse(value), err
}

func (h *handler) inboxOperation(_ http.ResponseWriter, r *http.Request, a core.Actor, taskID, id string) (any, error) {
	if err := refuseBot(a); err != nil {
		return nil, err
	}
	if err := noQuery(r); err != nil {
		return nil, err
	}
	value, err := h.tasks.InboxOperation(r.Context(), a, taskID, id)
	return inboxResultResponse(value), err
}

func (h *handler) manageInbox(kind string) requestOperation {
	return func(w http.ResponseWriter, r *http.Request, a core.Actor, taskID, _ string) (any, error) {
		if err := refuseBot(a); err != nil {
			return nil, err
		}
		allowed := []string{"operationId", "ifVersion"}
		if kind == "rotate" {
			allowed = append(allowed, "mode")
		}
		p := decode(w, r, allowed...)
		input := core.InboxInput{TaskID: taskID, OperationID: p.id("operationId", true), IfVersion: p.integer("ifVersion", true, false)}
		if kind == "rotate" {
			input.Mode = p.text("mode", true)
			if p.err == nil && input.Mode != core.InboxRotateOverlap && input.Mode != core.InboxRotateImmediate {
				p.err = httpx.InvalidInput("mode must be overlap or immediate")
			}
		}
		if p.err != nil {
			return nil, p.err
		}
		switch kind {
		case "enable":
			value, err := h.tasks.EnableInbox(r.Context(), a, input)
			return inboxTokenResponse(value), err
		case "rotate":
			value, err := h.tasks.RotateInbox(r.Context(), a, input)
			return inboxTokenResponse(value), err
		}
		value, err := h.tasks.DisableInbox(r.Context(), a, input)
		return inboxResultResponse(value), err
	}
}

func inboxResponse(value core.InboxView) api.AssistantTaskInbox {
	result := api.AssistantTaskInbox{Enabled: value.Enabled, CreatedAt: utc(value.CreatedAt), RotatedAt: utc(value.RotatedAt), OverlapUntil: utc(value.OverlapUntil), SuppressedCount: value.SuppressedCount}
	if value.InboxID != "" {
		result.InboxID = &value.InboxID
	}
	return result
}

func inboxResultResponse(value core.InboxResult) api.AssistantTaskInboxResult {
	op := value.Operation
	return api.AssistantTaskInboxResult{Operation: api.AssistantTaskInboxOperation{OperationID: op.OperationID, Kind: op.Kind, TaskID: op.TaskID,
		RequestFingerprint: op.RequestFingerprint, AdmittedAt: op.AdmittedAt.UTC(), ResultingVersion: op.ResultingVersion}, Inbox: inboxResponse(value.Inbox)}
}

func inboxTokenResponse(value core.InboxResult) api.AssistantTaskInboxTokenResult {
	result := api.AssistantTaskInboxTokenResult{AssistantTaskInboxResult: inboxResultResponse(value)}
	if value.Token != "" {
		result.Token = &value.Token
	}
	return result
}
