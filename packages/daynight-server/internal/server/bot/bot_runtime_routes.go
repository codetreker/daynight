package bot

import (
	"context"
	"log/slog"
	"net/http"

	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type runtimeService interface {
	RegisterBot(context.Context, model.Principal, string, string, sessioncore.BotRegistration) (sessioncore.BotRegistrationResult, error)
	GrantBot(context.Context, model.Principal, string, string, sessioncore.BotGrant) (sessioncore.GrantResult, error)
	ReportBot(context.Context, model.Principal, string, string, sessioncore.BotReport) (model.Bot, error)
}

type runtimeDeletion interface {
	CompleteBotDeletion(context.Context, model.Principal, string, string, botservice.BotDeletionReceipt) (model.Bot, error)
}

type runtimeRoutes struct {
	service   runtimeService
	deletion  runtimeDeletion
	auth      *authhttp.Authentication
	responses *sessionhttp.Routes
	logger    *slog.Logger
}

func RegisterRuntimeRoutes(mux *http.ServeMux, service runtimeService, deletion runtimeDeletion, auth *authhttp.Authentication, responses *sessionhttp.Routes, logger *slog.Logger) {
	h := &runtimeRoutes{service: service, deletion: deletion, auth: auth, responses: responses, logger: logger}
	const base = "/api/v1/me/workers/{workerId}/bots/{botId}/"
	for action, handler := range map[string]httpx.AuthenticatedHandler{
		"register": h.registerBot, "grant": h.grantBot, "report": h.reportBot,
		"deletion-complete": h.completeBotDeletion,
	} {
		mux.HandleFunc("POST "+base+action, h.auth.Require(h.responses.Parameters(handler)))
		mux.HandleFunc(base+action, h.auth.Require(httpx.ResourceMethodNotAllowed(h.logger, "POST")))
	}
}

func (h *runtimeRoutes) completeBotDeletion(w http.ResponseWriter, r *http.Request, p model.Principal) {
	body, err := sessionhttp.ReadBody(w, r)
	if err != nil {
		h.responses.Failure(w, r, err)
		return
	}
	input, err := botDeletionReceiptInput(body)
	if err != nil {
		h.responses.Failure(w, r, err)
		return
	}
	result, err := h.deletion.CompleteBotDeletion(r.Context(), p, r.PathValue("workerId"), r.PathValue("botId"), input)
	h.responses.Result(w, r, http.StatusOK, Response(result), err)
}

func (h *runtimeRoutes) registerBot(w http.ResponseWriter, r *http.Request, p model.Principal) {
	body, err := sessionhttp.ReadBody(w, r)
	if err != nil {
		h.responses.Failure(w, r, err)
		return
	}
	input, err := botRegisterInput(body)
	if err != nil {
		h.responses.Failure(w, r, err)
		return
	}
	result, err := h.service.RegisterBot(r.Context(), p, r.PathValue("workerId"), r.PathValue("botId"), input)
	h.responses.Result(w, r, http.StatusOK, map[string]any{"bot": Response(result.Bot), "session": result.Session}, err)
}

func (h *runtimeRoutes) grantBot(w http.ResponseWriter, r *http.Request, p model.Principal) {
	body, err := sessionhttp.ReadBody(w, r)
	if err != nil {
		h.responses.Failure(w, r, err)
		return
	}
	input, err := botGrantInput(body)
	if err != nil {
		h.responses.Failure(w, r, err)
		return
	}
	result, err := h.service.GrantBot(r.Context(), p, r.PathValue("workerId"), r.PathValue("botId"), input)
	h.responses.Result(w, r, http.StatusOK, result, err)
}

func (h *runtimeRoutes) reportBot(w http.ResponseWriter, r *http.Request, p model.Principal) {
	body, err := sessionhttp.ReadBody(w, r)
	if err != nil {
		h.responses.Failure(w, r, err)
		return
	}
	input, err := botReportInput(body)
	if err != nil {
		h.responses.Failure(w, r, err)
		return
	}
	result, err := h.service.ReportBot(r.Context(), p, r.PathValue("workerId"), r.PathValue("botId"), input)
	h.responses.Result(w, r, http.StatusOK, Response(result), err)
}
