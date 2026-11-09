package session

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type inspectionReader interface {
	Inspect(context.Context, model.Principal, string, string, string) (sp.TaskSessionInspection, error)
}

type inspectionAuthentication interface {
	Require(httpx.AuthenticatedHandler) http.HandlerFunc
}

// RegisterInspectionRoutes exposes the read-only, explicit Session identity
// inspection shared by Task observation and future Session command clients.
func RegisterInspectionRoutes(mux *http.ServeMux, reader inspectionReader, auth inspectionAuthentication, logger *slog.Logger) {
	const path = sessionBase + "/{sessionId}/inspection"
	mux.HandleFunc("GET "+path, auth.Require(func(w http.ResponseWriter, r *http.Request, principal model.Principal) {
		w.Header().Set("Cache-Control", "no-store")
		for _, key := range []string{"projectId", "taskId", "sessionId"} {
			id, err := model.CanonicalID(r.PathValue(key))
			if err != nil {
				httpx.WriteError(w, r, logger, "session", "inspect", err)
				return
			}
			r.SetPathValue(key, id)
		}
		if _, err := httpx.QueryValues(r); err != nil {
			httpx.WriteError(w, r, logger, "session", "inspect", err)
			return
		}
		result, err := reader.Inspect(r.Context(), principal, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"))
		if err != nil {
			httpx.WriteError(w, r, logger, "session", "inspect", err)
			return
		}
		httpx.WriteJSON(w, r, logger, http.StatusOK, result)
	}))
	mux.HandleFunc(path, auth.Require(func(w http.ResponseWriter, r *http.Request, _ model.Principal) {
		w.Header().Set("Cache-Control", "no-store")
		httpx.MethodNotAllowed(logger, "GET, HEAD")(w, r)
	}))
}
