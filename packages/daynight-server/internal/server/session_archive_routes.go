package server

import (
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
)

func (h *sessionRoutes) registerArchiveRoutes(mux *http.ServeMux) {
	for _, base := range []string{sessionBase + "/{sessionId}/archive", "/api/v1/test-sessions/{sessionId}/archive"} {
		for method, handler := range map[string]AuthenticatedHandler{"GET": h.archiveStatus, "POST": h.updateArchive, "PUT": h.putArchive} {
			mux.HandleFunc(method+" "+base, h.auth.Require(h.parameters(handler)))
		}
		mux.HandleFunc("GET "+base+"/content", h.auth.Require(h.parameters(h.archiveContent)))
		for path, methods := range map[string]string{base: "GET, POST, PUT", base + "/content": "GET"} {
			fallback := h.auth.Require(func(w http.ResponseWriter, r *http.Request, _ core.Principal) {
				methodNotAllowed(h.logger, methods)(w, r)
			})
			mux.HandleFunc(path, fallback)
			mux.HandleFunc("HEAD "+path, fallback)
		}
	}
}
func (h *sessionRoutes) archiveStatus(w http.ResponseWriter, r *http.Request, p core.Principal) {
	if _, err := queryValues(r); err != nil {
		h.failure(w, r, err)
		return
	}
	out, err := h.service.ArchiveStatus(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"))
	h.result(w, r, http.StatusOK, map[string]any{"archive": out}, err)
}
func (h *sessionRoutes) archiveContent(w http.ResponseWriter, r *http.Request, p core.Principal) {
	if _, err := queryValues(r); err != nil {
		h.failure(w, r, err)
		return
	}
	out, err := h.service.ArchiveContent(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"))
	h.result(w, r, http.StatusOK, map[string]any{"archive": out}, err)
}
func (h *sessionRoutes) updateArchive(w http.ResponseWriter, r *http.Request, p core.Principal) {
	body, err := relayBody(w, r)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	in, err := sp.DecodeArchiveUpdate(body)
	if err != nil {
		h.failure(w, r, invalidInput("Invalid archive status request."))
		return
	}
	out, err := h.service.UpdateArchive(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), in)
	h.result(w, r, http.StatusOK, map[string]any{"archive": out}, err)
}
func archiveBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	if _, err := queryValues(r); err != nil {
		return nil, err
	}
	kind, parameters, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || kind != "application/json" || parameters["charset"] != "" && !strings.EqualFold(parameters["charset"], "utf-8") {
		return nil, invalidInput("Content-Type must be application/json with UTF-8 encoding.")
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, sp.MaxArchiveBytes))
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			return nil, &service.Fault{Code: "payload_too_large", Message: "Session archive exceeds the 64 MiB limit."}
		}
		return nil, invalidInput("Unable to read session archive.")
	}
	return body, nil
}
func (h *sessionRoutes) putArchive(w http.ResponseWriter, r *http.Request, p core.Principal) {
	body, err := archiveBody(w, r)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	out, err := h.service.PutArchive(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), body)
	h.result(w, r, http.StatusOK, map[string]any{"archive": out}, err)
}
