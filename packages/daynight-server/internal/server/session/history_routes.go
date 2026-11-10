package session

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	ss "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
)

type HistoryReader interface {
	Current(context.Context, model.Principal, string, string) (sp.TaskSessionCurrent, error)
	List(context.Context, model.Principal, string, string, string, int) (sp.TaskSessionList, error)
	Read(context.Context, model.Principal, string, string, string, ss.ReadRequest) (*ss.ReadResult[sp.MessagePage], error)
	Entry(context.Context, model.Principal, string, string, string, ss.EntryRequest) (*ss.ReadResult[sp.EntryChunk], error)
}

func historyLimit(raw string) (int, error) {
	if raw == "" {
		return 20, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 1 || n > 200 || strconv.Itoa(n) != raw {
		return 0, httpx.InvalidInput("limit must be an integer from 1 to 200")
	}
	return n, nil
}

// RegisterHistoryRoutes exposes bounded original-content reads independently
// of the browser timeline projection. A retained archive stays owned until the
// response has finished writing, including cancellation and short writes.
func RegisterHistoryRoutes(mux *http.ServeMux, reader HistoryReader, auth inspectionAuthentication, logger *slog.Logger) {
	for _, operation := range []string{"messages", "message-content"} {
		path := sessionBase + "/{sessionId}/" + operation
		mux.HandleFunc("GET "+path, auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
			w.Header().Set("Cache-Control", "no-store")
			fail := func(err error) { httpx.WriteError(w, r, logger, "session", operation, err) }
			for _, key := range []string{"projectId", "taskId", "sessionId"} {
				id, err := model.CanonicalID(r.PathValue(key))
				if err != nil {
					fail(err)
					return
				}
				r.SetPathValue(key, id)
			}
			var value any
			var retained io.Closer
			var err error
			if operation == "messages" {
				q, e := httpx.QueryValues(r, "limit", "before", "conversation")
				if e != nil {
					fail(e)
					return
				}
				limit, e := historyLimit(q.Get("limit"))
				if e != nil {
					fail(e)
					return
				}
				if len(q.Get("before")) > sp.MaxHistoryCursorBytes || q.Get("conversation") != "" && q.Get("conversation") != "true" && q.Get("conversation") != "false" {
					fail(httpx.InvalidInput("Invalid history cursor or conversation filter."))
					return
				}
				result, e := reader.Read(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), ss.ReadRequest{Limit: limit, Before: q.Get("before"), Conversation: q.Get("conversation") == "true", ResponseOverhead: 1})
				err = e
				if result != nil {
					value, retained = result.Data, result
				}
			} else {
				q, e := httpx.QueryValues(r, "cursor")
				if e != nil {
					fail(e)
					return
				}
				if q.Get("cursor") == "" || len(q.Get("cursor")) > sp.MaxHistoryCursorBytes {
					fail(httpx.InvalidInput("A bounded entry cursor is required."))
					return
				}
				result, e := reader.Entry(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), ss.EntryRequest{Cursor: q.Get("cursor"), ResponseOverhead: 1})
				err = e
				if result != nil {
					value, retained = result.Data, result
				}
			}
			if retained != nil {
				defer func() {
					if e := retained.Close(); e != nil {
						httpx.LogFailure(logger, r.Context(), "session", "history release", e)
					}
				}()
			}
			if err != nil {
				fail(err)
				return
			}
			if retained == nil {
				fail(errors.New("history read returned no result"))
				return
			}
			httpx.WriteJSON(w, r, logger, http.StatusOK, value)
		}))
		mux.HandleFunc(path, auth.Require(func(w http.ResponseWriter, r *http.Request, _ model.Principal) {
			w.Header().Set("Cache-Control", "no-store")
			httpx.MethodNotAllowed(logger, "GET, HEAD")(w, r)
		}))
	}
}

func (h *Routes) inspectionDirectory(w http.ResponseWriter, r *http.Request, p model.Principal, current bool) {
	w.Header().Set("Cache-Control", "no-store")
	allowed := []string{"view"}
	if !current {
		allowed = append(allowed, "cursor", "limit")
	}
	q, err := httpx.QueryValues(r, allowed...)
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	if q.Get("view") != "inspection" {
		h.Failure(w, r, httpx.InvalidInput("view must be inspection"))
		return
	}
	if h.history == nil {
		h.Failure(w, r, terminalFault("unsupported_protocol", "Session inspection is unavailable."))
		return
	}
	var result any
	if current {
		result, err = h.history.Current(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"))
	} else {
		var limit int
		limit, err = historyLimit(q.Get("limit"))
		if err == nil {
			result, err = h.history.List(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), q.Get("cursor"), limit)
		}
	}
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	httpx.WriteJSON(w, r, h.logger, http.StatusOK, result)
}
