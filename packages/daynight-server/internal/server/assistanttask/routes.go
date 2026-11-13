package assistanttask

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/assistanttask"
)

type operations interface {
	Create(ctx context.Context, actor core.Actor, input core.CreateInput) (core.TaskResult, error)
	Get(ctx context.Context, actor core.Actor, taskID string) (core.TaskResult, error)
	List(ctx context.Context, actor core.Actor, input core.PageInput) (model.AssistantTaskPage[core.TaskResult], error)
	Update(ctx context.Context, actor core.Actor, input core.UpdateInput) (core.TaskResult, error)
	Claim(ctx context.Context, actor core.Actor, input core.ClaimInput) (model.AssistantTaskClaimResult, error)
	ClaimOperation(ctx context.Context, actor core.Actor, taskID, operationID string) (model.AssistantTaskClaimResult, error)
	GetManual(ctx context.Context, actor core.Actor, taskID string, version int64) (model.AssistantTaskManual, error)
	ListManuals(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskManual], error)
	ListAppendix(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskAppendix], error)
	AddAppendix(ctx context.Context, actor core.Actor, input core.AppendixInput) (model.AssistantTaskAppendix, error)
	UpdateAppendix(ctx context.Context, actor core.Actor, input core.AppendixInput) (model.AssistantTaskAppendix, error)
	ListProposals(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskProposal], error)
	Propose(ctx context.Context, actor core.Actor, input core.ProposalInput) (core.ProposalResult, error)
	Decide(ctx context.Context, actor core.Actor, input core.DecisionInput) (model.AssistantTaskProposal, error)
	Rollback(ctx context.Context, actor core.Actor, input core.RollbackInput) (model.AssistantTaskManual, error)
	ListItems(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskItem], error)
	GetItem(ctx context.Context, actor core.Actor, taskID, id string) (model.AssistantTaskItem, error)
	SaveItem(ctx context.Context, actor core.Actor, input core.ItemInput) (model.AssistantTaskItem, error)
	ListRecords(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskRecord], error)
	AddRecord(ctx context.Context, actor core.Actor, input core.RecordInput) (model.AssistantTaskRecord, error)
	ListEvents(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskEvent], error)
	AddEvent(ctx context.Context, actor core.Actor, input core.EventInput) (model.AssistantTaskEvent, error)
	AckEvent(ctx context.Context, actor core.Actor, input core.AckEventInput) (model.AssistantTaskEvent, error)
	ListInquiries(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskInquiry], error)
	Ask(ctx context.Context, actor core.Actor, input core.InquiryInput) (model.AssistantTaskInquiry, error)
	Answer(ctx context.Context, actor core.Actor, input core.AnswerInput) (model.AssistantTaskInquiry, error)
	ClearAttention(context.Context, core.Actor, string) error
}

type authentication interface {
	Require(httpx.AuthenticatedHandler) http.HandlerFunc
}
type handler struct {
	tasks  operations
	logger *slog.Logger
}
type requestOperation func(http.ResponseWriter, *http.Request, core.Actor, string, string) (any, error)

func RegisterRoutes(mux *http.ServeMux, tasks operations, auth authentication, logger *slog.Logger) {
	h := &handler{tasks: tasks, logger: logger}
	register := func(path, allowed string, methods map[string]requestOperation) {
		mux.HandleFunc(path, auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
			operation, ok := methods[r.Method]
			if !ok && r.Method == http.MethodHead {
				operation, ok = methods[http.MethodGet]
			}
			if !ok {
				httpx.ResourceMethodNotAllowed(logger, allowed)(w, r, p)
				return
			}
			botID, err := botIdentity(r)
			actor := core.Actor{Principal: p, BotID: botID}
			taskID, id := r.PathValue("taskId"), r.PathValue("id")
			if err == nil && taskID != "" {
				taskID, err = strictID(taskID)
			}
			if err == nil && id != "" {
				id, err = strictID(id)
			}
			var result any
			if err == nil {
				result, err = operation(w, r, actor, taskID, id)
			}
			if err != nil {
				h.failure(w, r, err)
				return
			}
			httpx.WriteJSON(w, r, logger, http.StatusOK, result)
		}))
	}
	const base = "/api/v1/assistant-tasks"
	const task = base + "/{taskId}"
	register(base, "GET, HEAD, POST", map[string]requestOperation{"GET": h.list, "POST": h.create})
	register(task, "GET, HEAD, PATCH, DELETE", map[string]requestOperation{"GET": h.get, "PATCH": h.update, "DELETE": h.remove})
	for _, kind := range []string{"claim", "renew", "release", "transfer"} {
		register(task+"/"+kind, "POST", map[string]requestOperation{"POST": h.claim(kind)})
	}
	register(task+"/claim/bind", "POST", map[string]requestOperation{"POST": h.claim("bind")})
	register(task+"/claim-operations/{id}", "GET, HEAD", map[string]requestOperation{"GET": h.claimOperation})
	register(task+"/manual", "GET, HEAD", map[string]requestOperation{"GET": h.manual})
	register(task+"/manual/versions", "GET, HEAD", map[string]requestOperation{"GET": h.manuals})
	register(task+"/manual/versions/{manualVersion}", "GET, HEAD", map[string]requestOperation{"GET": h.manual})
	register(task+"/manual/rollback", "POST", map[string]requestOperation{"POST": h.rollback})
	register(task+"/appendix", "GET, HEAD, POST", map[string]requestOperation{"GET": h.appendices, "POST": h.addAppendix})
	register(task+"/appendix/{id}", "PATCH, DELETE", map[string]requestOperation{"PATCH": h.updateAppendix, "DELETE": h.deleteAppendix})
	register(task+"/proposals", "GET, HEAD, POST", map[string]requestOperation{"GET": h.proposals, "POST": h.propose})
	register(task+"/proposals/{id}/decision", "POST", map[string]requestOperation{"POST": h.decide})
	register(task+"/items", "GET, HEAD, POST", map[string]requestOperation{"GET": h.items, "POST": h.addItem})
	register(task+"/items/{id}", "GET, HEAD, PATCH", map[string]requestOperation{"GET": h.item, "PATCH": h.updateItem})
	register(task+"/records", "GET, HEAD, POST", map[string]requestOperation{"GET": h.records, "POST": h.addRecord})
	register(task+"/events", "GET, HEAD, POST", map[string]requestOperation{"GET": h.events, "POST": h.addEvent})
	register(task+"/events/{id}/ack", "POST", map[string]requestOperation{"POST": h.ackEvent})
	register("/api/v1/assistant-task-events", "GET, HEAD", map[string]requestOperation{"GET": h.events})
	register("/api/v1/assistant-task-events/attention", "POST", map[string]requestOperation{"POST": h.clearAttention})
	register("/api/v1/bots/{id}/attention/seen", "POST", map[string]requestOperation{"POST": h.botAttentionSeen})
	register(task+"/inquiries", "GET, HEAD, POST", map[string]requestOperation{"GET": h.inquiries, "POST": h.ask})
	register(task+"/inquiries/{id}/answer", "POST", map[string]requestOperation{"POST": h.answer})
}

func (h *handler) failure(w http.ResponseWriter, r *http.Request, err error) {
	var completion *service.WriteError
	if errors.As(err, &completion) {
		httpx.CloseUnreadBody(w, r)
		httpx.LogFailure(h.logger, r.Context(), "assistant_task", "completion", err)
		code, message, status := "internal_error", "internal server error", http.StatusInternalServerError
		if completion.Outcome == store.TransactionUnknown {
			code, message, status = "write_outcome_unknown", "The transaction result is unknown; read the original operation before deciding another write.", http.StatusServiceUnavailable
			if completion.Operation == "Claim" {
				code = "claim_outcome_unknown"
			}
		}
		httpx.WriteJSON(w, r, h.logger, status, api.ErrorResponse{Error: api.Error{Code: code, Message: message, RequestID: httpx.RequestID(r.Context())}})
		return
	}
	if errors.Is(err, model.ErrNotFound) {
		if _, known := httpx.KnownFault(err); !known {
			missing := &model.Fault{Code: "not_found", Message: "The assistant task resource was not found.", Cause: err}
			if _, safe := httpx.KnownFault(missing); safe {
				err = missing
			}
		}
	}
	httpx.WriteError(w, r, h.logger, "assistant_task", "request", err)
}
