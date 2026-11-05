package server

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	bothttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func (h *sessionRoutes) registerBotRuntimeRoutes(mux *http.ServeMux) {
	const base = "/api/v1/me/workers/{workerId}/bots/{botId}/"
	for action, handler := range map[string]httpx.AuthenticatedHandler{
		"register": h.registerBot, "grant": h.grantBot, "report": h.reportBot,
		"deletion-complete": h.completeBotDeletion,
	} {
		mux.HandleFunc("POST "+base+action, h.auth.Require(h.parameters(handler)))
		mux.HandleFunc(base+action, h.auth.Require(httpx.ResourceMethodNotAllowed(h.logger, "POST")))
	}
}

func (h *sessionRoutes) completeBotDeletion(w http.ResponseWriter, r *http.Request, p model.Principal) {
	body, err := relayBody(w, r)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	input, err := botDeletionReceiptInput(body)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	result, err := h.service.CompleteBotDeletion(r.Context(), p, r.PathValue("workerId"), r.PathValue("botId"), input)
	h.result(w, r, http.StatusOK, bothttp.Response(result), err)
}

func (h *sessionRoutes) registerBot(w http.ResponseWriter, r *http.Request, p model.Principal) {
	body, err := relayBody(w, r)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	input, err := botRegisterInput(body)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	result, err := h.service.RegisterBot(r.Context(), p, r.PathValue("workerId"), r.PathValue("botId"), input)
	h.result(w, r, http.StatusOK, map[string]any{"bot": bothttp.Response(result.Bot), "session": result.Session}, err)
}

func (h *sessionRoutes) grantBot(w http.ResponseWriter, r *http.Request, p model.Principal) {
	body, err := relayBody(w, r)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	input, err := botGrantInput(body)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	result, err := h.service.GrantBot(r.Context(), p, r.PathValue("workerId"), r.PathValue("botId"), input)
	h.result(w, r, http.StatusOK, result, err)
}

func (h *sessionRoutes) reportBot(w http.ResponseWriter, r *http.Request, p model.Principal) {
	body, err := relayBody(w, r)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	input, err := botReportInput(body)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	result, err := h.service.ReportBot(r.Context(), p, r.PathValue("workerId"), r.PathValue("botId"), input)
	h.result(w, r, http.StatusOK, bothttp.Response(result), err)
}
