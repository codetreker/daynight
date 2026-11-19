package task

import (
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

type botDeclarationRefusal func(http.ResponseWriter, *http.Request, *slog.Logger, error)

// declaredBot parses the optional Bot declaration of a Task, Step or Thread
// write before the operation reads its body. The write transaction verifies
// that the Bot belongs to the authenticated user and is not deleted.
func declaredBot(base *slog.Logger, refuse botDeclarationRefusal, next httpx.AuthenticatedHandler) httpx.AuthenticatedHandler {
	return func(w http.ResponseWriter, request *http.Request, principal model.Principal) {
		botID, err := httpx.BotIdentity(request)
		if err != nil {
			w.Header().Set("Cache-Control", "no-store")
			_, _, logger, _ := TaskResource(request, principal, base)
			refuse(w, request, logger, err)
			return
		}
		if botID != nil {
			request = request.WithContext(service.WithDeclaredBot(request.Context(), *botID))
		}
		next(w, request, principal)
	}
}

func taskBotRefusal(component, phase string) botDeclarationRefusal {
	return func(w http.ResponseWriter, request *http.Request, logger *slog.Logger, err error) {
		httpx.WriteError(w, request, logger, component, phase, err)
	}
}

func stepBotRefusal(w http.ResponseWriter, request *http.Request, logger *slog.Logger, err error) {
	writeStepsError(w, request, logger.With("tx_outcome", store.TransactionNotCommitted), "prepare", err)
}

func threadBotRefusal(w http.ResponseWriter, request *http.Request, logger *slog.Logger, err error) {
	writeThreadError(w, request, logger, "admission", err)
}
