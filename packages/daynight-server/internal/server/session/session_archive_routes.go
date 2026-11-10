package session

import (
	"context"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func (h *Routes) registerArchiveRoutes(mux *http.ServeMux) {
	h.registerHistoryLedgerRoutes(mux)
	for _, base := range []string{sessionBase + "/{sessionId}/archive", "/api/v1/test-sessions/{sessionId}/archive"} {
		h.registerUnifiedArchiveRoutes(mux, base)
		for method, handler := range map[string]httpx.AuthenticatedHandler{"GET": h.archiveStatus, "POST": h.updateArchive, "PUT": h.putArchive} {
			route := h.auth.Require(h.Parameters(handler))
			if method == http.MethodPut {
				route = h.archivePreflight(route)
			}
			mux.HandleFunc(method+" "+base, route)
		}
		mux.HandleFunc("GET "+base+"/content", h.archivePreflight(h.auth.Require(h.Parameters(h.archiveContent))))
		for path, methods := range map[string]string{base: "GET, POST, PUT", base + "/content": "GET"} {
			fallback := h.auth.Require(func(w http.ResponseWriter, r *http.Request, _ model.Principal) {
				httpx.MethodNotAllowed(h.logger, methods)(w, r)
			})
			mux.HandleFunc(path, fallback)
			mux.HandleFunc("HEAD "+path, fallback)
		}
	}
}

type archiveReservationKey struct{}

func (h *Routes) archivePreflight(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Downloads do not consume request bodies. Prevent net/http from
		// draining an incomplete body before writing the response or after it.
		if r.Method == http.MethodGet {
			httpx.CloseUnreadBody(w, r)
		}
		reservation, err := h.service.TryReserveArchivePreflight()
		if err != nil {
			httpx.CloseUnreadBody(w, r)
			h.Failure(w, r, err)
			return
		}
		defer h.closeArchive(r, reservation)
		next(w, r.WithContext(context.WithValue(r.Context(), archiveReservationKey{}, reservation)))
	}
}

func archiveReservation(r *http.Request) io.Closer {
	reservation, _ := r.Context().Value(archiveReservationKey{}).(io.Closer)
	return reservation
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
	out, err := h.service.ArchiveContentReserved(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), archiveReservation(r))
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	// The archive is already validated JSON. Preserve its exact bytes inside
	// the v1 envelope instead of letting the JSON encoder rewrite them.
	data := make([]byte, 0, len(out.Data)+12)
	if _, err := sp.DecodeArchiveManifest(out.Data); err == nil {
		h.sendArchive(w, r, out.Data, 120*time.Second, out)
		return
	}
	data = append(data, `{"archive":`...)
	data = append(data, out.Data...)
	data = append(data, '}')
	h.sendArchive(w, r, data, 120*time.Second, out)
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
func validateArchiveBody(r *http.Request) error {
	if _, err := httpx.QueryValues(r); err != nil {
		return err
	}
	kind, parameters, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || kind != "application/json" || parameters["charset"] != "" && !strings.EqualFold(parameters["charset"], "utf-8") {
		return httpx.InvalidInput("Content-Type must be application/json with UTF-8 encoding.")
	}
	return nil
}
func archiveBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	return archiveBodyWithTimeout(w, r, transport.ArchiveBodyReadTimeout)
}
func archiveBodyWithTimeout(w http.ResponseWriter, r *http.Request, timeout time.Duration) ([]byte, error) {
	if err := validateArchiveBody(r); err != nil {
		httpx.CloseUnreadBody(w, r)
		return nil, err
	}
	nativeBody := httpx.NativeHTTP1RequestBody(r)
	stream := httpx.NewDeadlineBody(w, r, timeout)
	body, err := io.ReadAll(http.MaxBytesReader(w, stream, sp.MaxArchiveBytes))
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			err = &httpx.BodyReadError{Cause: err, Status: http.StatusRequestEntityTooLarge, Code: "payload_too_large", Message: "Session archive exceeds the 64 MiB limit."}
		}
	}
	if closeErr := stream.Close(); closeErr != nil {
		var readErr *httpx.BodyReadError
		// net/http's body Close may attempt a final drain after the same
		// expired socket deadline. Retain both causes in the timeout error.
		if nativeBody && errors.As(err, &readErr) && readErr.Status == http.StatusRequestTimeout && sameReadDeadline(readErr.Cause, closeErr) {
			readErr.Cause = errors.Join(readErr.Cause, closeErr)
		} else {
			err = archiveCleanupError(err, closeErr)
		}
	}
	return body, err
}

func sameReadDeadline(readErr, closeErr error) bool {
	var readOp, closeOp *net.OpError
	if !errors.As(readErr, &readOp) || !errors.As(closeErr, &closeOp) || readOp.Op != "read" || closeOp.Op != "read" || readOp.Net != closeOp.Net || readOp.Err != os.ErrDeadlineExceeded || closeOp.Err != os.ErrDeadlineExceeded {
		return false
	}
	readSource, sourceOK := readOp.Source.(*net.TCPAddr)
	closeSource, closeSourceOK := closeOp.Source.(*net.TCPAddr)
	readAddr, addrOK := readOp.Addr.(*net.TCPAddr)
	closeAddr, closeAddrOK := closeOp.Addr.(*net.TCPAddr)
	return sourceOK && closeSourceOK && addrOK && closeAddrOK && readSource != nil && readSource == closeSource && readAddr != nil && readAddr == closeAddr
}
func (h *Routes) putArchive(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if err := validateArchiveBody(r); err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	op, err := h.service.BeginArchiveReserved(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), sessioncore.ArchiveV1Upload, archiveReservation(r))
	if err != nil {
		httpx.CloseUnreadBody(w, r)
		h.Failure(w, r, err)
		return
	}
	defer func() {
		if op != nil {
			h.closeArchive(r, op)
		}
	}()
	body, err := archiveBody(w, r)
	if err != nil {
		err = archiveCleanupError(err, op.Close())
		op = nil
		httpx.WriteBodyError(w, r, h.logger, "session", "archive", err)
		return
	}
	out, err := op.PutArchive(r.Context(), body)
	if err != nil {
		err = archiveCleanupError(err, op.Close())
		op = nil
		h.Failure(w, r, err)
		return
	}
	lease := op
	op = nil
	h.archiveResult(w, r, map[string]any{"archive": out}, lease)
}

func (h *Routes) closeArchive(r *http.Request, lease io.Closer) {
	if err := lease.Close(); err != nil {
		httpx.LogFailure(h.logger, r.Context(), "session", "archive_close", err)
	}
}

func archiveCleanupError(cause, closeErr error) error {
	if closeErr == nil {
		return cause
	}
	return &model.Fault{Code: "cleanup_unknown", Message: "Archive cleanup failed.", Cause: errors.Join(cause, closeErr)}
}

// archiveResult retains the operation while encoding and sending the response.
func (h *Routes) archiveResult(w http.ResponseWriter, r *http.Request, value any, lease io.Closer) {
	handedOff := false
	defer func() {
		if !handedOff {
			h.closeArchive(r, lease)
		}
	}()
	if r.Context().Err() != nil {
		return
	}
	data, err := sp.MarshalWire(value)
	if err != nil {
		err = archiveCleanupError(err, lease.Close())
		handedOff = true
		h.Failure(w, r, err)
		return
	}
	handedOff = true
	h.sendArchive(w, r, data, 120*time.Second, lease)
}

func (h *Routes) sendArchive(w http.ResponseWriter, r *http.Request, data []byte, timeout time.Duration, lease io.Closer) {
	closed := false
	defer func() {
		if !closed {
			h.closeArchive(r, lease)
		}
	}()
	if r.Context().Err() != nil {
		return
	}
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Now().Add(timeout)); err != nil && !errors.Is(err, http.ErrNotSupported) {
		err = archiveCleanupError(err, lease.Close())
		closed = true
		h.Failure(w, r, err)
		return
	}
	done := make(chan struct{})
	stop := context.AfterFunc(r.Context(), func() { _ = controller.SetWriteDeadline(time.Now()); close(done) })
	stopped := false
	defer func() {
		if !stopped && !stop() {
			<-done
		}
	}()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	written, err := w.Write(data)
	if err == nil && written != len(data) {
		err = io.ErrShortWrite
	}
	if err == nil {
		err = controller.Flush()
		if errors.Is(err, http.ErrNotSupported) {
			err = nil
		}
	}
	if !stop() {
		<-done
	}
	stopped = true
	if err == nil {
		err = r.Context().Err()
	}
	if err != nil {
		err = errors.Join(err, lease.Close())
		closed = true
		httpx.LogFailure(h.logger, r.Context(), "session", "response", err)
		panic(http.ErrAbortHandler)
	}
	if err = controller.SetWriteDeadline(time.Time{}); err != nil && !errors.Is(err, http.ErrNotSupported) {
		err = errors.Join(err, lease.Close())
		closed = true
		httpx.LogFailure(h.logger, r.Context(), "session", "response", err)
		panic(http.ErrAbortHandler)
	}
}
