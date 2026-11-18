package worker

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

const workerAliasHeader = "Daynight-Worker-Alias"

func aliasProtocol(header http.Header) (bool, error) {
	values := header.Values(workerAliasHeader)
	if len(values) == 0 {
		return false, nil
	}
	if len(values) != 1 || values[0] != "1" {
		return false, httpx.InvalidInput("Worker alias protocol must be exactly 1.")
	}
	return true, nil
}

func (h *workersHandler) alias(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	id, logger, err := h.resource(request, principal)
	if err == nil && (request.URL.RawQuery != "" || request.URL.ForceQuery) {
		err = httpx.InvalidInput("worker alias does not accept query parameters")
	}
	if err == nil {
		_, err = aliasProtocol(request.Header)
	}
	var result model.WorkerAlias
	if err == nil && request.Method == http.MethodPut {
		var fields map[string]json.RawMessage
		fields, err = httpx.DecodeObject(w, request, "value", "expectedVersion")
		var version string
		var value *string
		if err == nil {
			version, err = httpx.RequiredString(fields, "expectedVersion")
		}
		if err == nil {
			raw, exists := fields["value"]
			if !exists {
				err = httpx.InvalidInput("value is required")
			} else if !jsonunicode.Valid(raw) {
				err = httpx.InvalidInput("Worker alias must be valid Unicode.")
			} else if !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
				var text string
				text, err = httpx.RequiredString(fields, "value")
				value = &text
			}
		}
		if err == nil {
			result, err = h.workers.PutAlias(request.Context(), principal, id, version, value)
		}
	} else if err == nil {
		result, err = h.workers.Alias(request.Context(), principal, id)
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "worker_alias", "exchange", err)
		return
	}
	w.Header().Set(workerAliasHeader, "1")
	httpx.WriteJSON(w, request, logger, http.StatusOK, workerprotocol.AliasResource{WorkerID: id, Alias: *workerprotocol.ProjectAlias(result)})
}
