package session

import (
	"context"
	"net/http"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type historyLedgerOperation interface {
	ArchiveOperation
	PutHistoryLedger(context.Context, sessioncore.ActiveHistoryWriter, string, int64, int64, string, string, []byte) (sp.ArchiveFileReceipt, error)
	HistoryLedgerStatus(context.Context, sessioncore.ActiveHistoryWriter, string) (sp.ArchiveFileReceipt, error)
}

func (h *Routes) registerHistoryLedgerRoutes(mux *http.ServeMux) {
	for _, base := range []string{sessionBase + "/{sessionId}", "/api/v1/test-sessions/{sessionId}"} {
		mux.HandleFunc("PUT "+base+"/image-history-ledger/{fileId}", h.archivePreflight(h.historyLedger))
		mux.HandleFunc("GET "+base+"/image-history-ledger/{fileId}/status", h.archivePreflight(h.historyLedger))
	}
}
func (h *Routes) historyLedger(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	protocol, err := selectedSessionProtocol(r)
	if err != nil || protocol != sp.Protocol {
		h.Failure(w, r, httpx.InvalidInput("History ledgers require the Session v1 protocol."))
		return
	}
	if err = h.origin(r, false); err != nil {
		h.Failure(w, r, err)
		return
	}
	if len(r.Header.Values("Content-Encoding")) != 0 {
		h.Failure(w, r, httpx.InvalidInput("Encoded history ledger bodies are not accepted."))
		return
	}
	token, err := controllerToken(r)
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	for _, name := range []string{"projectId", "taskId", "sessionId", "fileId"} {
		raw := r.PathValue(name)
		if raw != "" {
			id, e := model.CanonicalID(raw)
			if e != nil || id != raw {
				if e == nil {
					e = httpx.InvalidInput("A canonical history ledger identity is required.")
				}
				h.Failure(w, r, e)
				return
			}
			r.SetPathValue(name, id)
		}
	}
	if len(r.Header.Values("Daynight-Controller-Fence")) != 1 {
		h.Failure(w, r, httpx.InvalidInput("A controller fence is required."))
		return
	}
	fence, err := sp.DecodeHistoryControllerFence([]byte(r.Header.Get("Daynight-Controller-Fence")))
	if err != nil {
		h.Failure(w, r, httpx.InvalidInput("Invalid history controller fence."))
		return
	}
	writer := sessioncore.ActiveHistoryWriter{Fence: fence, Credential: token}
	var offset, length int64
	if r.Method == http.MethodGet {
		_, err = httpx.QueryValues(r)
	} else {
		values, queryErr := httpx.QueryValues(r, "offset")
		err = queryErr
		if err == nil {
			var e1, e2 error
			offset, e1 = strconv.ParseInt(values.Get("offset"), 10, 64)
			length, e2 = strconv.ParseInt(r.Header.Get("Daynight-File-Byte-Length"), 10, 64)
			if e1 != nil || e2 != nil || offset < 0 || length < 1 || strconv.FormatInt(offset, 10) != values.Get("offset") || strconv.FormatInt(length, 10) != r.Header.Get("Daynight-File-Byte-Length") || len(r.Header.Values("Daynight-File-Byte-Length")) != 1 || len(r.Header.Values("Daynight-File-SHA256")) != 1 || len(r.Header.Values("Daynight-Chunk-SHA256")) != 1 {
				err = httpx.InvalidInput("Invalid history file range.")
			}
		}
	}
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	raw, err := h.service.BeginHistoryLedgerReserved(r.Context(), r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), writer, archiveReservation(r))
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	op, ok := raw.(historyLedgerOperation)
	if !ok {
		h.Failure(w, r, archiveCleanupError(httpx.InvalidInput("History ledger is unavailable."), raw.Close()))
		return
	}
	var out sp.ArchiveFileReceipt
	if r.Method == http.MethodGet {
		out, err = op.HistoryLedgerStatus(r.Context(), writer, r.PathValue("fileId"))
	} else {
		var data []byte
		data, err = readUnifiedArchiveBody(w, r, "application/octet-stream", 1048576, false)
		if err == nil {
			out, err = op.PutHistoryLedger(r.Context(), writer, r.PathValue("fileId"), offset, length, r.Header.Get("Daynight-File-SHA256"), r.Header.Get("Daynight-Chunk-SHA256"), data)
		}
	}
	if err != nil {
		h.Failure(w, r, archiveCleanupError(err, op.Close()))
		return
	}
	h.archiveResult(w, r, historyFileResponse(out), op)
}
