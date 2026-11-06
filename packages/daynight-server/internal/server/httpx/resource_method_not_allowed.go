package httpx

import (
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func ResourceMethodNotAllowed(logger *slog.Logger, allowed string) AuthenticatedHandler {
	return func(w http.ResponseWriter, request *http.Request, principal model.Principal) {
		w.Header().Set("Cache-Control", "no-store")
		MethodNotAllowed(logger.With("user_id", principal.UserID), allowed)(w, request)
	}
}
