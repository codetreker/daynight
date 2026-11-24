package session

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

const botHistoryWindowPath = "/api/v1/test-sessions/{sessionId}/bot-history-window"

func (h *Routes) registerBotHistoryWindowRoutes(mux httpx.RouteRegistrar, observe func(ProducerRoute)) {
	mux.HandleFunc("GET "+botHistoryWindowPath, h.auth.Require(h.Parameters(h.botHistoryWindow, true)))
	fallback := h.auth.Require(func(w http.ResponseWriter, r *http.Request, _ model.Principal) {
		httpx.MethodNotAllowed(h.logger, "GET")(w, r)
	})
	mux.HandleFunc("HEAD "+botHistoryWindowPath, fallback)
	mux.HandleFunc(botHistoryWindowPath, fallback)
	checkpoint := botHistoryWindowPath + "/checkpoint"
	registerProducerRoute(mux, "PUT "+checkpoint, h.botHistoryCheckpoint, producerIndependent, observe)
	registerProducerRoute(mux, checkpoint, httpx.MethodNotAllowed(h.logger, "PUT"), producerFallback, observe)
}

func (h *Routes) botHistoryWindow(w http.ResponseWriter, r *http.Request, p model.Principal) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Daynight-Bot-History-Window-Version", "1")
	values, err := httpx.QueryValues(r, "mode", "cursor", "limit")
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	mode := values.Get("mode")
	if mode == "" {
		mode = "tail"
	}
	limit := 50
	if raw := values.Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err == nil && strconv.Itoa(limit) != raw {
			err = httpx.InvalidInput("Invalid Bot history window limit.")
		}
	}
	cursor := values.Get("cursor")
	if err != nil || limit < 1 || limit > 200 || len(cursor) > sp.MaxHistoryCursorBytes || (mode != "tail" && mode != "before" && mode != "changes") || (mode == "tail") != (cursor == "") {
		h.Failure(w, r, httpx.InvalidInput("Invalid Bot history window mode, cursor, or limit."))
		return
	}
	page, err := h.service.ReadBotHistoryWindow(r.Context(), p, "", "", r.PathValue("sessionId"), sessioncore.BotHistoryWindowRequest{Mode: mode, Cursor: cursor, Limit: limit})
	var reset *sessioncore.BotHistoryWindowResetError
	if errors.As(err, &reset) {
		if r.Context().Err() != nil {
			return
		}
		httpx.LogFailure(h.logger, r.Context(), "session", "bot history window", err)
		h.Result(w, r, http.StatusConflict, map[string]any{"error": map[string]any{"code": "reset_required", "message": "Restart from the current Bot history window.", "requestId": httpx.RequestID(r.Context())}, "boundary": reset.Boundary}, nil)
		return
	}
	h.Result(w, r, http.StatusOK, page, err)
}

func (h *Routes) botHistoryCheckpoint(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Daynight-Bot-History-Window-Version", "1")
	protocol, err := selectedSessionProtocol(r)
	if err != nil || protocol != sp.Protocol {
		h.Failure(w, r, httpx.InvalidInput("Bot history checkpoints require the Session v1 protocol."))
		return
	}
	if err = h.origin(r, false); err != nil {
		h.Failure(w, r, err)
		return
	}
	token, err := controllerToken(r)
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	id, err := model.CanonicalID(r.PathValue("sessionId"))
	if err != nil || id != r.PathValue("sessionId") || len(r.Header.Values("Content-Encoding")) != 0 {
		h.Failure(w, r, httpx.InvalidInput("A canonical Session identity and unencoded checkpoint are required."))
		return
	}
	if _, err = httpx.QueryValues(r); err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	body, err := httpx.ReadJSONBodyLimit(w, r, sp.MaxFrameBytes, transport.JSONBodyReadTimeout)
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	checkpoint, err := sp.DecodeBotHistoryCheckpoint(body)
	if err != nil || checkpoint.SessionID != id {
		h.Failure(w, r, httpx.InvalidInput("Invalid Bot history checkpoint or Session identity."))
		return
	}
	receipt, err := h.service.CommitBotHistoryCheckpoint(r.Context(), token, checkpoint)
	h.Result(w, r, http.StatusOK, receipt, err)
}
