package session

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func (h *Routes) registerArchiveRoutes(mux *http.ServeMux) {
	for _, base := range []string{sessionBase + "/{sessionId}/archive", "/api/v1/test-sessions/{sessionId}/archive"} {
		for method, handler := range map[string]httpx.AuthenticatedHandler{"GET": h.archiveStatus, "POST": h.updateArchive, "PUT": h.putArchive} {
			mux.HandleFunc(method+" "+base, h.auth.Require(h.Parameters(handler)))
		}
		mux.HandleFunc("GET "+base+"/content", h.auth.Require(h.Parameters(h.archiveContent)))
		for path, methods := range map[string]string{base: "GET, POST, PUT", base + "/content": "GET"} {
			fallback := h.auth.Require(func(w http.ResponseWriter, r *http.Request, _ model.Principal) {
				httpx.MethodNotAllowed(h.logger, methods)(w, r)
			})
			mux.HandleFunc(path, fallback)
			mux.HandleFunc("HEAD "+path, fallback)
		}
	}
}
func (h *Routes) archiveStatus(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	out, err := h.service.ArchiveStatus(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"))
	h.Result(w, r, http.StatusOK, map[string]any{"archive": out}, err)
}
func (h *Routes) archiveContent(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	out, err := h.service.ArchiveContent(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"))
	h.Result(w, r, http.StatusOK, map[string]any{"archive": out}, err)
}
func (h *Routes) updateArchive(w http.ResponseWriter, r *http.Request, p model.Principal) {
	body, err := ReadBody(w, r)
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	in, err := sp.DecodeArchiveUpdate(body)
	if err != nil {
		h.Failure(w, r, httpx.InvalidInput("Invalid archive status request."))
		return
	}
	out, err := h.service.UpdateArchive(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), in)
	h.Result(w, r, http.StatusOK, map[string]any{"archive": out}, err)
}
func archiveBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	if _, err := httpx.QueryValues(r); err != nil {
		return nil, err
	}
	kind, parameters, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || kind != "application/json" || parameters["charset"] != "" && !strings.EqualFold(parameters["charset"], "utf-8") {
		return nil, httpx.InvalidInput("Content-Type must be application/json with UTF-8 encoding.")
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, sp.MaxArchiveBytes))
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			return nil, &model.Fault{Code: "payload_too_large", Message: "Session archive exceeds the 64 MiB limit."}
		}
		return nil, httpx.InvalidInput("Unable to read session archive.")
	}
	return body, nil
}
func (h *Routes) putArchive(w http.ResponseWriter, r *http.Request, p model.Principal) {
	body, err := archiveBody(w, r)
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	out, err := h.service.PutArchive(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), body)
	h.Result(w, r, http.StatusOK, map[string]any{"archive": out}, err)
}
