package session

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func sessionSubprotocols(r *http.Request) []string {
	var values []string
	for _, header := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, value := range strings.Split(header, ",") {
			values = append(values, strings.TrimSpace(value))
		}
	}
	return values
}

// Selection is explicit. An absent selector preserves the strict v1 response.
func selectedSessionProtocol(r *http.Request) (string, error) {
	headers := r.Header.Values(v2.ProtocolHeader)
	if len(headers) > 1 {
		return "", terminalFault("unsupported_protocol", "Select one Session protocol.")
	}
	var header *string
	if len(headers) == 1 {
		header = &headers[0]
	}
	selected, err := v2.SelectProtocol(header)
	if err != nil {
		return "", terminalFault("unsupported_protocol", "Unsupported Session protocol.")
	}
	values := sessionSubprotocols(r)
	if len(values) == 0 {
		return selected, nil
	}
	socketProtocol := ""
	for _, value := range values {
		if value == v2.Protocol {
			socketProtocol = v2.Protocol
			break
		}
		if value == sp.Protocol {
			socketProtocol = sp.Protocol
		}
	}
	if socketProtocol == "" || header != nil && selected != socketProtocol {
		return "", terminalFault("unsupported_protocol", "Session protocol selectors disagree or are unsupported.")
	}
	return socketProtocol, nil
}
func terminalFault(code, message string) error { return &model.Fault{Code: code, Message: message} }
func (h *Routes) registerTerminalRoutes(mux httpx.RouteRegistrar) {
	mux.HandleFunc("GET "+sessionBase, httpx.MethodDispatch(h.auth.Require(h.Parameters(func(w http.ResponseWriter, r *http.Request, _ model.Principal) {
		h.Failure(w, r, terminalFault("unsupported_protocol", "This endpoint requires daynight.session.v2."))
	}, true)), http.MethodGet))
}

// terminalRoute retains only historical directory and archive reads. The
// archive preflight surrounding the content route owns its reservation.
func (h *Routes) terminalRoute(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if r.Method == http.MethodHead {
		httpx.MethodNotAllowed(h.logger, "GET")(w, r)
		return
	}
	if r.PathValue("projectId") == "" {
		h.Failure(w, r, terminalFault("unsupported_protocol", "Terminal Sessions require a task."))
		return
	}
	project, task, id := r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId")
	var result any
	var err error
	switch r.Pattern {
	case "GET " + sessionBase:
		values, queryErr := httpx.QueryValues(r, "cursor", "limit")
		if queryErr != nil {
			err = queryErr
			break
		}
		limit := 50
		if values.Get("limit") != "" {
			limit, err = strconv.Atoi(values.Get("limit"))
			if err != nil {
				err = httpx.InvalidInput("Invalid history limit.")
				break
			}
		}
		result, err = h.service.TerminalHistory(r.Context(), p, project, task, values.Get("cursor"), limit)
	case "GET " + sessionBase + "/{sessionId}/archive":
		if _, err = httpx.QueryValues(r); err == nil {
			result, err = h.service.TerminalArchiveStatus(r.Context(), p, project, task, id)
		}
	case "GET " + sessionBase + "/{sessionId}/archive/content":
		if _, err = httpx.QueryValues(r); err != nil {
			break
		}
		content, contentErr := h.service.TerminalArchiveContentReserved(r.Context(), p, project, task, id, archiveReservation(r))
		if contentErr != nil {
			err = contentErr
			break
		}
		// The immutable receipt hashes these exact bytes, including JSON whitespace.
		h.sendArchive(w, r, content.Data, 120*time.Second, content)
		return
	default:
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			httpx.CloseUnreadBody(w, r)
		}
		err = terminalFault("unsupported_content_kind", "This endpoint does not serve terminal content.")
	}
	h.Result(w, r, http.StatusOK, result, err)
}
