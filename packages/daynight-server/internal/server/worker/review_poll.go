package worker

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"net/http"
)

func (h *workersHandler) reviewPullRequests(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	id, logger, err := h.resource(request, principal)
	var page model.PageRequest
	if err == nil {
		page, err = httpx.PageRequest(request)
		if err == nil && !request.URL.Query().Has("limit") {
			page.Limit = 20
		}
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_review_pull_requests", "validate", err)
		return
	}
	result, err := h.workers.ReviewPullRequests(request.Context(), principal, id, page)
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_review_pull_requests", "read", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, result)
}
