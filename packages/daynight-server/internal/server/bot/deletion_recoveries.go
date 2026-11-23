package bot

import (
	"context"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type deletionRecoveriesReader interface {
	DeletionRecoveries(context.Context, model.Principal, model.PageRequest) (botcore.DeletionRecoveryPage, error)
}

func (h *botsHandler) deletionRecoveries(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	page, err := httpx.PageRequest(request)
	var result botcore.DeletionRecoveryPage
	if err == nil {
		reader, ok := h.bots.(deletionRecoveriesReader)
		if !ok {
			err = &model.Fault{Code: "capability_error", Message: "Bot deletion recovery listing is unavailable."}
		} else {
			result, err = reader.DeletionRecoveries(request.Context(), principal, page)
		}
	}
	if err != nil {
		writeBotError(w, request, logger, "deletion-recoveries", err)
		return
	}
	response := api.BotDeletionRecoveryPage{Items: make([]api.BotDeletionRecovery, len(result.Items)), NextCursor: result.NextCursor}
	for i, item := range result.Items {
		response.Items[i] = deletionRecoveryResponse(item)
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}
