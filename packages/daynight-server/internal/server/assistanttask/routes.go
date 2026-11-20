package assistanttask

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/assistanttask"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/assistanttask"
)

type operations interface {
	EnableWatchdog(context.Context, core.Actor, string, string) (core.TaskResult, error)
	Create(ctx context.Context, actor core.Actor, input core.CreateInput) (core.TaskResult, error)
	Get(ctx context.Context, actor core.Actor, taskID string) (core.TaskResult, error)
	Metrics(ctx context.Context, actor core.Actor, taskID string) (model.AssistantTaskMetrics, error)
	List(ctx context.Context, actor core.Actor, input core.PageInput) (model.AssistantTaskPage[core.TaskResult], error)
	Update(ctx context.Context, actor core.Actor, input core.UpdateInput) (core.TaskResult, error)
	Claim(ctx context.Context, actor core.Actor, input core.ClaimInput) (model.AssistantTaskClaimResult, error)
	ClaimOperation(ctx context.Context, actor core.Actor, taskID, operationID string) (model.AssistantTaskClaimResult, error)
	GetManual(ctx context.Context, actor core.Actor, taskID string, version int64) (model.AssistantTaskManual, error)
	ListManuals(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskManual], error)
	ListAppendix(ctx context.Context, actor core.Actor, taskID string, input core.PageInput) (model.AssistantTaskPage[model.AssistantTaskAppendix], error)
	RelatedAppendix(ctx context.Context, actor core.Actor, taskID string, input core.RelatedAppendixInput) (model.AssistantTaskRelatedAppendices, error)
	AddAppendix(ctx context.Context, actor core.Actor, input core.AppendixInput) (model.AssistantTaskAppendix, error)
	UpdateAppendix(ctx context.Context, actor core.Actor, input core.AppendixInput) (model.AssistantTaskAppendix, error)
	ValidateAppendix(ctx context.Context, actor core.Actor, input core.AppendixValidationInput) (model.AssistantTaskAppendix, error)
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
	GetInbox(ctx context.Context, actor core.Actor, taskID string) (core.InboxView, error)
	EnableInbox(ctx context.Context, actor core.Actor, input core.InboxInput) (core.InboxResult, error)
	RotateInbox(ctx context.Context, actor core.Actor, input core.InboxInput) (core.InboxResult, error)
	DisableInbox(ctx context.Context, actor core.Actor, input core.InboxInput) (core.InboxResult, error)
	InboxOperation(ctx context.Context, actor core.Actor, taskID, operationID string) (core.InboxResult, error)
}

type authentication interface {
	Require(httpx.AuthenticatedHandler) http.HandlerFunc
}
type handler struct {
	tasks  operations
	logger *slog.Logger
}
type requestOperation func(http.ResponseWriter, *http.Request, core.Actor, string, string) (any, error)

type classifiedOperation struct {
	run   requestOperation
	owner string
}

func operation(owner string, run requestOperation) classifiedOperation {
	return classifiedOperation{run: run, owner: owner}
}

// RouteClassification records the actual registered pattern and method. The
// named domain operation owns dynamic scope selection from parsed input.
type RouteClassification struct {
	Host, Pattern, Method, Owner, Profile string
	Contract                              *core.ScopeContract
	Branches                              []string
}

func RegisterRoutes(mux httpx.RouteRegistrar, tasks operations, auth authentication, logger *slog.Logger) {
	_ = registerRoutes(mux, tasks, auth, logger, nil, nil)
}

// AuthorizationResolver supplies the authenticated request's explicit profile.
// The business module separately reads current authorization in its transaction.
type AuthorizationResolver func(context.Context, model.Principal) (model.CredentialAuthorization, error)

// RegisterScopedRoutes installs the scoped admission path without changing the
// existing assembly. The resolver must return an explicit, matching profile.
func RegisterScopedRoutes(mux httpx.RouteRegistrar, tasks operations, auth authentication, logger *slog.Logger, resolve AuthorizationResolver, record func(RouteClassification)) error {
	if resolve == nil || record == nil {
		return errors.New("assistant task authorization resolver and route recorder are required")
	}
	return registerRoutes(mux, tasks, auth, logger, resolve, record)
}

func registerRoutes(mux httpx.RouteRegistrar, tasks operations, auth authentication, logger *slog.Logger, resolve AuthorizationResolver, record func(RouteClassification)) error {
	h := &handler{tasks: tasks, logger: logger}
	var registrationErr error
	register := func(path, allowed string, methods map[string]classifiedOperation) {
		if registrationErr != nil {
			return
		}
		if record != nil {
			for method, op := range methods {
				contract, ok := core.ScopeContractFor(op.owner)
				if !ok || len(contract.Branches) == 0 || len(contract.Profiles) == 0 || contract.Admission == "" {
					registrationErr = errors.New("assistant task route has no scope contract: " + op.owner)
					return
				}
				branches := make([]string, 0, len(contract.Branches))
				for _, branch := range contract.Branches {
					branches = append(branches, branch.Name)
				}
				if op.owner == "core.Module.Update" && method == http.MethodDelete {
					branches = []string{"response", "delete"}
				}
				if op.owner == "core.Module.UpdateAppendix" {
					if method == http.MethodDelete {
						branches = []string{"delete"}
					} else {
						branches = []string{"edit"}
					}
				}
				entry := RouteClassification{Pattern: path, Method: method, Owner: op.owner, Profile: "credential", Contract: &contract, Branches: branches}
				record(entry)
				if method == http.MethodGet {
					entry.Method = http.MethodHead
					record(entry)
				}
			}
			record(RouteClassification{Pattern: path, Method: "*", Owner: "method-fallback", Profile: "authenticated-fallback"})
		}
		mux.HandleFunc(path, auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
			operation, ok := methods[r.Method]
			if !ok && r.Method == http.MethodHead {
				operation, ok = methods[http.MethodGet]
			}
			if !ok {
				httpx.ResourceMethodNotAllowed(logger, allowed)(w, r, p)
				return
			}
			botID, err := httpx.BotIdentity(r)
			actor := core.Actor{Principal: p, BotID: botID}
			if err == nil && resolve != nil {
				var authorization model.CredentialAuthorization
				authorization, err = resolve(r.Context(), p)
				// Only the domain operation can establish resource visibility.
				// A resolver failure must not advertise scope denial.
				if errors.Is(err, scopepolicy.ErrInsufficientScope) {
					err = errors.New("assistant task authorization resolution failed")
				}
				if err == nil && authorization.Principal != p {
					err = errors.New("assistant task authorization identity mismatch")
				}
				if err == nil {
					err = authorization.Validate()
				}
				if err == nil {
					actor.Authorization = &authorization
				}
			}
			taskID, id := r.PathValue("taskId"), r.PathValue("id")
			if err == nil && taskID != "" {
				taskID, err = strictID(taskID)
			}
			if err == nil && id != "" {
				id, err = strictID(id)
			}
			var result any
			if err == nil {
				result, err = operation.run(w, r, actor, taskID, id)
			}
			if err != nil {
				h.failure(w, r, err)
				return
			}
			httpx.WriteJSON(w, r, logger, http.StatusOK, result)
		}))
	}
	register("/api/v1/assistant-task-presets/watchdog", "POST", map[string]classifiedOperation{"POST": operation("core.Module.EnablePreset", h.enableWatchdog)})
	const base = "/api/v1/assistant-tasks"
	const task = base + "/{taskId}"
	register(base, "GET, HEAD, POST", map[string]classifiedOperation{"GET": operation("core.Module.List", h.list), "POST": operation("core.Module.Create", h.create)})
	register(task, "GET, HEAD, PATCH, DELETE", map[string]classifiedOperation{"GET": operation("core.Module.Get", h.get), "PATCH": operation("core.Module.Update", h.update), "DELETE": operation("core.Module.Update", h.remove)})
	for _, kind := range []string{"claim", "renew", "release", "transfer"} {
		register(task+"/"+kind, "POST", map[string]classifiedOperation{"POST": operation("core.Module.Claim", h.claim(kind))})
	}
	register(task+"/claim/bind", "POST", map[string]classifiedOperation{"POST": operation("core.Module.Claim", h.claim("bind"))})
	register(task+"/claim-operations/{id}", "GET, HEAD", map[string]classifiedOperation{"GET": operation("core.Module.ClaimOperation", h.claimOperation)})
	register(task+"/manual", "GET, HEAD", map[string]classifiedOperation{"GET": operation("core.Module.GetManual", h.manual)})
	register(task+"/manual/versions", "GET, HEAD", map[string]classifiedOperation{"GET": operation("core.Module.ListManuals", h.manuals)})
	register(task+"/manual/versions/{manualVersion}", "GET, HEAD", map[string]classifiedOperation{"GET": operation("core.Module.GetManual", h.manual)})
	register(task+"/manual/rollback", "POST", map[string]classifiedOperation{"POST": operation("core.Module.Rollback", h.rollback)})
	register(task+"/appendix", "GET, HEAD, POST", map[string]classifiedOperation{"GET": operation("core.Module.ListAppendix", h.appendices), "POST": operation("core.Module.AddAppendix", h.addAppendix)})
	register(task+"/appendix/related", "GET, HEAD", map[string]classifiedOperation{"GET": operation("core.Module.RelatedAppendix", h.relatedAppendices)})
	register(task+"/appendix/{id}", "PATCH, DELETE", map[string]classifiedOperation{"PATCH": operation("core.Module.UpdateAppendix", h.updateAppendix), "DELETE": operation("core.Module.UpdateAppendix", h.deleteAppendix)})
	register(task+"/appendix/{id}/validations", "POST", map[string]classifiedOperation{"POST": operation("core.Module.ValidateAppendix", h.validateAppendix)})
	register(task+"/proposals", "GET, HEAD, POST", map[string]classifiedOperation{"GET": operation("core.Module.ListProposals", h.proposals), "POST": operation("core.Module.Propose", h.propose)})
	register(task+"/proposals/{id}/decision", "POST", map[string]classifiedOperation{"POST": operation("core.Module.Decide", h.decide)})
	register(task+"/items", "GET, HEAD, POST", map[string]classifiedOperation{"GET": operation("core.Module.ListItems", h.items), "POST": operation("core.Module.SaveItem", h.addItem)})
	register(task+"/items/{id}", "GET, HEAD, PATCH", map[string]classifiedOperation{"GET": operation("core.Module.GetItem", h.item), "PATCH": operation("core.Module.SaveItem", h.updateItem)})
	register(task+"/metrics", "GET, HEAD", map[string]classifiedOperation{"GET": operation("core.Module.Metrics", h.metrics)})
	register(task+"/records", "GET, HEAD, POST", map[string]classifiedOperation{"GET": operation("core.Module.ListRecords", h.records), "POST": operation("core.Module.AddRecord", h.addRecord)})
	register(task+"/events", "GET, HEAD, POST", map[string]classifiedOperation{"GET": operation("core.Module.ListEvents", h.events), "POST": operation("core.Module.AddEvent", h.addEvent)})
	register(task+"/events/{id}/ack", "POST", map[string]classifiedOperation{"POST": operation("core.Module.AckEvent", h.ackEvent)})
	register("/api/v1/assistant-task-events", "GET, HEAD", map[string]classifiedOperation{"GET": operation("core.Module.ListEvents", h.events)})
	register("/api/v1/assistant-task-events/attention", "POST", map[string]classifiedOperation{"POST": operation("core.Module.ClearAttention", h.clearAttention)})
	register("/api/v1/bots/{id}/attention/seen", "POST", map[string]classifiedOperation{"POST": operation("core.Module.ClearAttention", h.botAttentionSeen)})
	register(task+"/inquiries", "GET, HEAD, POST", map[string]classifiedOperation{"GET": operation("core.Module.ListInquiries", h.inquiries), "POST": operation("core.Module.Ask", h.ask)})
	register(task+"/inbox", "GET, HEAD", map[string]classifiedOperation{"GET": operation("core.Module.GetInbox", h.inbox)})
	for _, kind := range []string{"enable", "rotate", "disable"} {
		owner := map[string]string{"enable": "core.Module.EnableInbox", "rotate": "core.Module.RotateInbox", "disable": "core.Module.DisableInbox"}[kind]
		register(task+"/inbox/"+kind, "POST", map[string]classifiedOperation{"POST": operation(owner, h.manageInbox(kind))})
	}
	register(task+"/inbox-operations/{id}", "GET, HEAD", map[string]classifiedOperation{"GET": operation("core.Module.InboxOperation", h.inboxOperation)})
	register(task+"/inquiries/{id}/answer", "POST", map[string]classifiedOperation{"POST": operation("core.Module.Answer", h.answer)})
	return registrationErr
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
	if errors.Is(err, scopepolicy.ErrInsufficientScope) {
		w.Header().Set("Daynight-Scope-Status", "insufficient_scope")
		err = &model.Fault{Code: "forbidden", Message: "The credential has insufficient scope for this operation."}
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
