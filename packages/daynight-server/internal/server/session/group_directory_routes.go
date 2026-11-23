package session

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type groupDirectoryReader interface {
	Read(context.Context, model.Principal, string, core.HistoryDirectoryRequest) (core.HistoryDirectoryPage, error)
}

// RegisterGroupDirectoryRoutes keeps grouped history and expiry metadata off the
// original directory response, whose consumers reject unknown fields.
func RegisterGroupDirectoryRoutes(mux httpx.RouteRegistrar, reader groupDirectoryReader, auth inspectionAuthentication, logger *slog.Logger) {
	const base = "/api/v1/projects/{projectId}/history-directory"
	for _, route := range []struct{ path, kind, target string }{
		{base, "groups", ""},
		{base + "/{groupId}/members", "members", "groupId"},
		{base + "/tasks/{taskId}/sessions", "sessions", "taskId"},
	} {
		mux.HandleFunc("GET "+route.path, auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Daynight-Task-History-Directory-Version", "1")
			fail := func(err error) { httpx.WriteError(w, r, logger, "session", "history directory", err) }
			project, err := model.CanonicalID(r.PathValue("projectId"))
			if err != nil {
				fail(err)
				return
			}
			target := ""
			if route.target != "" {
				target, err = model.CanonicalID(r.PathValue(route.target))
				if err != nil {
					fail(err)
					return
				}
			}
			q, err := httpx.QueryValues(r, "cursor", "limit")
			if err != nil {
				fail(err)
				return
			}
			limit, err := historyLimit(q.Get("limit"))
			if err != nil {
				fail(err)
				return
			}
			if len(q.Get("cursor")) > 4096 {
				fail(httpx.InvalidInput("History directory cursor is too long."))
				return
			}
			out, err := reader.Read(r.Context(), p, project, core.HistoryDirectoryRequest{Kind: route.kind, Target: target, Cursor: q.Get("cursor"), Limit: limit})
			if err != nil {
				fail(err)
				return
			}
			httpx.WriteJSON(w, r, logger, http.StatusOK, out)
		}))
		mux.HandleFunc(route.path, auth.Require(func(w http.ResponseWriter, r *http.Request, _ model.Principal) {
			w.Header().Set("Cache-Control", "no-store")
			httpx.MethodNotAllowed(logger, "GET, HEAD")(w, r)
		}))
	}
}
