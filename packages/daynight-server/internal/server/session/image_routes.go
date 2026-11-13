package session

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func (h *Routes) registerImageRoutes(mux *http.ServeMux) {
	for _, base := range []string{sessionBase + "/{sessionId}", "/api/v1/test-sessions/{sessionId}"} {
		for method, handler := range map[string]func(http.ResponseWriter, *http.Request, model.Principal){"PUT " + base + "/image-uploads/{uploadId}": h.prepareImage, "PUT " + base + "/image-uploads/{uploadId}/content": h.directImageUpload, "GET " + base + "/image-uploads/{uploadId}": h.getImageUpload, "DELETE " + base + "/image-uploads/{uploadId}": h.releaseImageUpload, "PUT " + base + "/image-uploads/{uploadId}/chunks": h.writeImageChunk, "POST " + base + "/image-uploads/{uploadId}/complete": h.completeImageUpload, "GET " + base + "/image-capabilities": h.imageCapabilities, "GET " + base + "/image-occurrences/{imageId}": h.imageOccurrence, "POST " + base + "/image-occurrences/{imageId}/retry": h.retryImageOccurrence} {
			mux.HandleFunc(method, h.auth.Require(h.imageParameters(handler)))
		}
	}
}
func (h *Routes) directImageUpload(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if !h.imageRequest(w, r) {
		return
	}
	data, e := readBody(w, r, 1<<20, "Image upload request exceeds the 1 MiB limit.")
	if e != nil {
		h.Failure(w, r, e)
		return
	}
	input, e := sp.DecodeDirectImageContent(data)
	if e != nil || input.Spec.UploadID != r.PathValue("uploadId") {
		h.Failure(w, r, httpx.InvalidInput("Invalid direct image upload."))
		return
	}
	receipt, created, e := h.service.DirectUpload(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), input)
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	h.Result(w, r, status, receipt, e)
}

// Image media is an extension of the existing v1 Session protocol. Its route
// selection must not dispatch the request to the independent terminal protocol.
func (h *Routes) imageParameters(next httpx.AuthenticatedHandler) httpx.AuthenticatedHandler {
	return func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		protocol, err := selectedSessionProtocol(r)
		if err != nil || protocol != sp.Protocol {
			h.Failure(w, r, httpx.InvalidInput("Image operations require the Session v1 protocol."))
			return
		}
		for _, name := range []string{"uploadId", "imageId"} {
			if raw := r.PathValue(name); raw != "" {
				id, err := model.CanonicalID(raw)
				if err != nil || raw != id {
					h.Failure(w, r, httpx.InvalidInput("A canonical image upload identity is required."))
					return
				}
			}
		}
		h.Parameters(next)(w, r, p)
	}
}
func imageRevision(r *http.Request) error {
	v := r.Header.Values("Daynight-Session-Content-Revision")
	if len(v) != 1 || v[0] != "2" {
		return httpx.InvalidInput("Image operations require content revision 2.")
	}
	if len(r.Header.Values("Content-Encoding")) != 0 {
		return httpx.InvalidInput("Encoded image request bodies are not accepted.")
	}
	return nil
}
func (h *Routes) imageRequest(w http.ResponseWriter, r *http.Request) bool {
	if e := imageRevision(r); e != nil {
		h.Failure(w, r, e)
		return false
	}
	if _, e := httpx.QueryValues(r); e != nil {
		h.Failure(w, r, e)
		return false
	}
	return true
}
func (h *Routes) prepareImage(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if !h.imageRequest(w, r) {
		return
	}
	data, e := ReadBody(w, r)
	if e != nil {
		h.Failure(w, r, e)
		return
	}
	input, e := sp.DecodeImageUploadSpec(data)
	if e != nil || input.UploadID != r.PathValue("uploadId") {
		h.Failure(w, r, httpx.InvalidInput("Invalid image upload specification."))
		return
	}
	receipt, created, e := h.service.PrepareUpload(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), input)
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	h.Result(w, r, status, receipt, e)
}
func (h *Routes) getImageUpload(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if !h.imageRequest(w, r) {
		return
	}
	out, e := h.service.GetUpload(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), r.PathValue("uploadId"))
	h.Result(w, r, http.StatusOK, out, e)
}
func (h *Routes) releaseImageUpload(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if !h.imageRequest(w, r) {
		return
	}
	out, e := h.service.ReleaseUpload(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), r.PathValue("uploadId"))
	h.Result(w, r, http.StatusOK, out, e)
}
func (h *Routes) completeImageUpload(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if !h.imageRequest(w, r) {
		return
	}
	data, e := ReadBody(w, r)
	if e != nil {
		h.Failure(w, r, e)
		return
	}
	input, e := sp.DecodeImageUploadComplete(data)
	if e != nil {
		h.Failure(w, r, httpx.InvalidInput("Invalid image upload completion."))
		return
	}
	out, e := h.service.CompleteUpload(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), r.PathValue("uploadId"), input)
	h.Result(w, r, http.StatusOK, out, e)
}
func (h *Routes) writeImageChunk(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if e := imageRevision(r); e != nil {
		h.Failure(w, r, e)
		return
	}
	values, e := httpx.QueryValues(r, "offset")
	if e != nil {
		h.Failure(w, r, e)
		return
	}
	offset, e := strconv.ParseInt(values.Get("offset"), 10, 64)
	if e != nil || offset < 0 || strconv.FormatInt(offset, 10) != values.Get("offset") {
		h.Failure(w, r, httpx.InvalidInput("A canonical image chunk offset is required."))
		return
	}
	types := r.Header.Values("Content-Type")
	kind, parameters, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	hashes := r.Header.Values("Daynight-Chunk-SHA256")
	if len(types) != 1 || err != nil || kind != "application/octet-stream" || len(parameters) != 0 || len(hashes) != 1 || len(hashes[0]) != 64 || strings.IndexFunc(hashes[0], func(c rune) bool { return !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') }) >= 0 {
		h.Failure(w, r, httpx.InvalidInput("Image chunks require octet-stream and one SHA-256 header."))
		return
	}
	body, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 524288))
	if e != nil || len(body) == 0 {
		h.Failure(w, r, httpx.InvalidInput("Image chunks must contain 1 to 524288 bytes."))
		return
	}
	out, e := h.service.WriteUploadChunk(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), r.PathValue("uploadId"), sp.ImageChunkWrite{UploadID: r.PathValue("uploadId"), Offset: values.Get("offset"), SHA256: hashes[0], Data: base64.StdEncoding.EncodeToString(body)})
	h.Result(w, r, http.StatusOK, out, e)
}
func (h *Routes) imageCapabilities(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if !h.imageRequest(w, r) {
		return
	}
	out, e := h.service.ImageCapabilities(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"))
	if e == nil {
		w.Header().Set("Daynight-Session-Direct-Upload-Version", "1")
	}
	h.Result(w, r, http.StatusOK, out, e)
}
func (h *Routes) imageResource(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if e := imageRevision(r); e != nil {
		h.Failure(w, r, e)
		return
	}
	values, e := httpx.QueryValues(r, "offset", "limit")
	if e != nil {
		h.Failure(w, r, e)
		return
	}
	limit, e := strconv.Atoi(values.Get("limit"))
	if e != nil || strconv.Itoa(limit) != values.Get("limit") {
		h.Failure(w, r, httpx.InvalidInput("Invalid image resource chunk limit."))
		return
	}
	input := sp.ImageReadRequest{ResourceID: r.PathValue("resourceId"), Offset: values.Get("offset"), Limit: limit}
	if _, e = sp.DecodeImageReadRequest(imageJSON(input)); e != nil {
		h.Failure(w, r, httpx.InvalidInput("Invalid image resource read range."))
		return
	}
	out, e := h.service.ReadResource(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), input)
	h.Result(w, r, http.StatusOK, out, e)
}

func imageJSON(v any) []byte { b, _ := json.Marshal(v); return b }

func (h *Routes) imageOccurrence(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if !h.imageRequest(w, r) {
		return
	}
	out, e := h.service.GetImageOccurrence(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), r.PathValue("imageId"))
	h.Result(w, r, http.StatusOK, out, e)
}
func (h *Routes) retryImageOccurrence(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if !h.imageRequest(w, r) {
		return
	}
	raw, e := ReadBody(w, r)
	if e != nil {
		h.Failure(w, r, e)
		return
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil || len(fields) != 0 {
		h.Failure(w, r, httpx.InvalidInput("An empty image retry request is required."))
		return
	}
	out, e := h.service.RetryImageOccurrence(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), r.PathValue("imageId"))
	h.Result(w, r, http.StatusOK, out, e)
}
