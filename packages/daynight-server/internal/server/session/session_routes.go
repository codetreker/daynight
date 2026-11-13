package session

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"

	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/google/uuid"
)

const sessionBase = "/api/v1/projects/{projectId}/tasks/{taskId}/sessions"
const relayWriteTimeout = 5 * time.Second
const relayMaxConnections = 1024

type Routes struct {
	history         HistoryReader
	service         serviceCalls
	auth            *authhttp.RequestAuthentication
	logger          *slog.Logger
	instance        string
	pingInterval    time.Duration
	mutex           sync.Mutex
	closing         bool
	reserved        int
	connections     map[*websocket.Conn]context.CancelFunc
	terminalViewers map[string]*websocket.Conn
	active          sync.WaitGroup
	drained         chan struct{}
	drainErr        error
}

func NewRoutes(s *sessionservice.Service, auth *authhttp.Authentication, logger *slog.Logger, history ...HistoryReader) *Routes {
	if s != nil && auth != nil {
		s.SetOrigin(auth.Origin())
	}
	var requestAuth *authhttp.RequestAuthentication
	if auth != nil {
		requestAuth = auth.RequestAuthentication
	}
	routes := newRoutes(callsFromService(s), requestAuth, logger)
	if len(history) > 0 {
		routes.history = history[0]
	}
	return routes
}

func newRoutes(service serviceCalls, auth *authhttp.RequestAuthentication, logger *slog.Logger) *Routes {
	return &Routes{service: service, auth: auth, logger: logger, instance: uuid.NewString(), pingInterval: 10 * time.Second, connections: make(map[*websocket.Conn]context.CancelFunc)}
}
func (h *Routes) RegisterRoutes(mux *http.ServeMux) {
	h.registerTerminalRoutes(mux)
	h.registerTestRoutes(mux)
	h.registerArchiveRoutes(mux)
	h.registerImageRoutes(mux)
	mux.HandleFunc("GET /api/v1/session-capabilities", h.auth.Require(func(w http.ResponseWriter, r *http.Request, _ model.Principal) {
		if _, err := httpx.QueryValues(r); err != nil {
			h.Failure(w, r, err)
			return
		}
		protocol, err := selectedSessionProtocol(r)
		if err != nil {
			h.Failure(w, r, err)
			return
		}
		if protocol == v2.Protocol {
			httpx.WriteJSON(w, r, h.logger, http.StatusOK, map[string]any{"protocol": v2.Protocol, "schemaVersion": 2, "projectionVersion": 1, "providers": []string{"codex", "claude", "copilot"}, "backends": []string{"herdr"}, "recordingResponsibilityVersion": 1, "controlDispatchVersion": 1, "workerCapabilitiesRequired": true})
			return
		}
		httpx.WriteJSON(w, r, h.logger, http.StatusOK, map[string]any{"protocol": sp.Protocol, "schemaVersion": 1, "projectionVersion": 1, "providers": []string{"codex", "claude", "copilot"}, "startupReportVersion": 1})
	}))
	capabilityMethod := h.auth.Require(func(w http.ResponseWriter, r *http.Request, _ model.Principal) {
		httpx.MethodNotAllowed(h.logger, "GET")(w, r)
	})
	mux.HandleFunc("HEAD /api/v1/session-capabilities", capabilityMethod)
	mux.HandleFunc("/api/v1/session-capabilities", capabilityMethod)
	handlers := map[string]httpx.AuthenticatedHandler{
		"POST " + sessionBase:                                                h.registerSession,
		"GET " + sessionBase + "/current":                                    h.current,
		"POST " + sessionBase + "/{sessionId}/controller-grant":              h.grant,
		"GET " + sessionBase + "/{sessionId}/timeline":                       h.timeline,
		"POST " + sessionBase + "/{sessionId}/commands":                      h.submit,
		"GET " + sessionBase + "/{sessionId}/operations/{operationId}":       h.operation,
		"GET " + sessionBase + "/{sessionId}/resources/{resourceId}/content": h.resource,
		"GET " + sessionBase + "/{sessionId}/channel":                        h.browserChannel,
	}
	for route, handler := range handlers {
		if route == "GET "+sessionBase+"/{sessionId}/channel" {
			mux.HandleFunc(route, h.requireUserChannel(h.Parameters(handler), false))
		} else {
			mux.HandleFunc(route, h.auth.Require(h.Parameters(handler)))
		}
	}
	for path, methods := range map[string]string{sessionBase: "GET, POST", sessionBase + "/current": "GET", sessionBase + "/{sessionId}/controller-grant": "POST", sessionBase + "/{sessionId}/timeline": "GET", sessionBase + "/{sessionId}/commands": "POST", sessionBase + "/{sessionId}/operations/{operationId}": "GET", sessionBase + "/{sessionId}/resources/{resourceId}/content": "GET", sessionBase + "/{sessionId}/channel": "GET"} {
		fallback := httpx.MethodNotAllowed(h.logger, methods)
		mux.HandleFunc(path, h.auth.Require(func(w http.ResponseWriter, r *http.Request, _ model.Principal) { fallback(w, r) }))
		if methods == "GET" {
			mux.HandleFunc("HEAD "+path, h.auth.Require(func(w http.ResponseWriter, r *http.Request, _ model.Principal) { fallback(w, r) }))
		}
	}
	mux.HandleFunc("GET /api/v1/controller-channel", h.controllerChannel)
	mux.HandleFunc("HEAD /api/v1/controller-channel", httpx.MethodNotAllowed(h.logger, "GET"))
	mux.HandleFunc("/api/v1/controller-channel", httpx.MethodNotAllowed(h.logger, "GET"))
	mux.HandleFunc("PUT /api/v1/controller-resources/{resourceId}", h.putResource)
	mux.HandleFunc("/api/v1/controller-resources/{resourceId}", httpx.MethodNotAllowed(h.logger, "PUT"))
}
func (h *Routes) Parameters(next httpx.AuthenticatedHandler) httpx.AuthenticatedHandler {
	return func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		for _, name := range []string{"projectId", "taskId", "sessionId", "operationId", "resourceId", "uploadId", "imageId", "evidenceId", "workerId", "botId"} {
			if raw := r.PathValue(name); raw != "" {
				id, err := model.CanonicalID(raw)
				if err != nil {
					h.Failure(w, r, err)
					return
				}
				r.SetPathValue(name, id)
			}
		}
		if r.Method == http.MethodGet && r.PathValue("sessionId") == "" && r.URL.Query().Has("view") && (strings.HasSuffix(r.URL.Path, "/sessions") || strings.HasSuffix(r.URL.Path, "/sessions/current")) {
			h.inspectionDirectory(w, r, p, strings.HasSuffix(r.URL.Path, "/current"))
			return
		}
		protocol, err := selectedSessionProtocol(r)
		if err != nil {
			h.Failure(w, r, err)
			return
		}
		if protocol == v2.Protocol {
			h.terminalRoute(w, r, p)
			return
		}
		next(w, r, p)
	}
}
func (h *Routes) Failure(w http.ResponseWriter, r *http.Request, err error) {
	httpx.WriteError(w, r, h.logger, "session", "relay", err)
}
func (h *Routes) channelAdmissionFailure(w http.ResponseWriter, r *http.Request, err error) {
	var fault *model.Fault
	if errors.As(err, &fault) && fault.Code == "service_unavailable" {
		h.mutex.Lock()
		closing := h.closing
		h.mutex.Unlock()
		if closing {
			err = &model.Fault{Code: "rate_limited", Message: "Session channel capacity is unavailable."}
		}
	}
	h.Failure(w, r, err)
}

func (h *Routes) Result(w http.ResponseWriter, r *http.Request, status int, value any, err error) {
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	if r.Context().Err() != nil {
		return
	}
	data, encodeErr := sp.MarshalWire(value)
	if encodeErr != nil {
		h.Failure(w, r, encodeErr)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, writeErr := w.Write(data); writeErr != nil {
		httpx.LogFailure(h.logger, r.Context(), "session", "response", writeErr)
	}
}
func ReadBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	return readBody(w, r, sp.MaxFrameBytes, "Session request exceeds the 2 MiB limit.")
}
func readBody(w http.ResponseWriter, r *http.Request, maxBytes int64, limitMessage string) ([]byte, error) {
	if _, err := httpx.QueryValues(r); err != nil {
		return nil, err
	}
	kind, parameters, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || kind != "application/json" || parameters["charset"] != "" && !strings.EqualFold(parameters["charset"], "utf-8") {
		return nil, httpx.InvalidInput("Content-Type must be application/json with UTF-8 encoding.")
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBytes))
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			return nil, &model.Fault{Code: "payload_too_large", Message: limitMessage}
		}
		return nil, httpx.InvalidInput("Unable to read session request.")
	}
	return body, nil
}
func (h *Routes) registerSession(w http.ResponseWriter, r *http.Request, p model.Principal) {
	body, err := ReadBody(w, r)
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	input, err := sp.DecodeRegistration(body)
	if err != nil {
		h.Failure(w, r, httpx.InvalidInput("Invalid session registration."))
		return
	}
	snapshot, err := h.service.Register(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), input)
	h.Result(w, r, http.StatusOK, map[string]any{"session": snapshot}, err)
}
func (h *Routes) current(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	read := h.service.Current
	if r.Header.Get("X-Daynight-Startup-Version") == "1" {
		read = h.service.CurrentWithStartup
	}
	result, err := read(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"))
	h.Result(w, r, http.StatusOK, result, err)
}
func (h *Routes) grant(w http.ResponseWriter, r *http.Request, p model.Principal) {
	body, err := ReadBody(w, r)
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	input, err := sp.DecodeGrant(body)
	if r.PathValue("projectId") == "" {
		input, err = sp.DecodeTestGrant(body)
	}
	if err != nil {
		h.Failure(w, r, httpx.InvalidInput("Invalid controller grant request."))
		return
	}
	result, err := h.service.Grant(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), input)
	h.Result(w, r, http.StatusOK, result, err)
}
func (h *Routes) timeline(w http.ResponseWriter, r *http.Request, p model.Principal) {
	values, err := httpx.QueryValues(r, "direction", "cursor", "limit")
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	direction := values.Get("direction")
	if direction == "" {
		direction = "tail"
	}
	limit := 100
	if raw := values.Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
	}
	if err != nil || limit < 1 || limit > 200 || (direction != "tail" && direction != "before" && direction != "after") || (direction != "tail" && values.Get("cursor") == "") || (direction == "tail" && values.Get("cursor") != "") {
		h.Failure(w, r, httpx.InvalidInput("Invalid session timeline direction, cursor, or limit."))
		return
	}
	result, err := h.service.Timeline(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), direction, values.Get("cursor"), limit)
	h.Result(w, r, http.StatusOK, result, err)
}
func (h *Routes) submit(w http.ResponseWriter, r *http.Request, p model.Principal) {
	body, err := ReadBody(w, r)
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	command, err := sp.DecodeCommand(body)
	if err != nil {
		h.Failure(w, r, httpx.InvalidInput("Invalid session command."))
		return
	}
	operation, err := h.service.Submit(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), command)
	location := "/api/v1/projects/" + r.PathValue("projectId") + "/tasks/" + r.PathValue("taskId") + "/sessions/" + r.PathValue("sessionId") + "/operations/" + command.OperationID
	if r.PathValue("projectId") == "" {
		location = "/api/v1/test-sessions/" + r.PathValue("sessionId") + "/operations/" + command.OperationID
	}
	if err == nil {
		w.Header().Set("Location", location)
	}
	h.Result(w, r, http.StatusAccepted, map[string]any{"operation": operation, "operationUrl": location}, err)
}
func (h *Routes) operation(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	if r.PathValue("projectId") != "" {
		result, err := h.service.TaskOperation(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), r.PathValue("operationId"))
		h.Result(w, r, http.StatusOK, result, err)
		return
	}
	result, err := h.service.Operation(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), r.PathValue("operationId"))
	h.Result(w, r, http.StatusOK, map[string]any{"operation": result}, err)
}
func (h *Routes) resource(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if r.URL.RawQuery != "" {
		h.imageResource(w, r, p)
		return
	}
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	data, resource, err := h.service.Resource(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), r.PathValue("resourceId"))
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	kind := "application/octet-stream"
	if resource.MediaType != nil {
		kind = *resource.MediaType
	}
	w.Header().Set("Content-Type", kind)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": resource.Name}))
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	if _, err = w.Write(data); err != nil {
		httpx.LogFailure(h.logger, r.Context(), "session", "resource", err)
	}
}
func controllerToken(r *http.Request) (string, error) {
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return "", authhttp.Failure()
	}
	parts := strings.Fields(values[0])
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || !strings.HasPrefix(parts[1], "dncontroller_") {
		return "", authhttp.Failure()
	}
	return parts[1], nil
}
func (h *Routes) putResource(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	// This endpoint cannot accept uploads, so even rejected requests must not
	// drain an untrusted body for connection reuse.
	httpx.CloseUnreadBody(w, r)
	_, err := controllerToken(r)
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	protocol, protocolErr := selectedSessionProtocol(r)
	if protocolErr != nil {
		h.Failure(w, r, protocolErr)
		return
	}
	if protocol != sp.Protocol {
		h.Failure(w, r, terminalFault("unsupported_protocol", "Web controller endpoints require daynight.session.v1."))
		return
	}

	if _, err = httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	_, err = model.CanonicalID(r.PathValue("resourceId"))
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	epochs := r.Header.Values("Daynight-Connection-Epoch")
	if len(epochs) != 1 {
		h.Failure(w, r, httpx.InvalidInput("A controller connection epoch is required."))
		return
	}
	epoch, err := strconv.ParseInt(epochs[0], 10, 64)
	if err != nil || epoch < 1 || strconv.FormatInt(epoch, 10) != epochs[0] {
		h.Failure(w, r, httpx.InvalidInput("Invalid controller connection epoch."))
		return
	}
	h.Failure(w, r, &model.Fault{Code: "not_found", Message: "Session resources are read from the online controller; server uploads are not supported."})
}
func (h *Routes) origin(r *http.Request, cookie bool) error {
	origins := r.Header.Values("Origin")
	if cookie || len(origins) > 0 {
		if len(origins) != 1 || origins[0] != h.auth.Origin() {
			return &model.Fault{Code: "forbidden", Message: "Session channels require the exact main-site Origin."}
		}
	}
	return nil
}
func (h *Routes) accept(w http.ResponseWriter, r *http.Request) (*websocket.Conn, context.Context, func(), error) {
	h.mutex.Lock()
	if h.closing || h.reserved >= relayMaxConnections {
		h.mutex.Unlock()
		return nil, nil, nil, &model.Fault{Code: "rate_limited", Message: "Session channel capacity is unavailable."}
	}
	h.reserved++
	h.active.Add(1)
	h.mutex.Unlock()
	// Exact Origin was already checked; library host matching is intentionally bypassed.
	protocol, protocolErr := selectedSessionProtocol(r)
	if protocolErr != nil {
		h.mutex.Lock()
		h.reserved--
		h.mutex.Unlock()
		h.active.Done()
		return nil, nil, nil, protocolErr
	}
	if protocol == sp.Protocol {
		w.Header().Set("Daynight-Session-Direct-Upload-Version", "1")
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{protocol}, InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		h.mutex.Lock()
		h.reserved--
		h.mutex.Unlock()
		h.active.Done()
		return nil, nil, nil, err
	}
	conn.SetReadLimit(sp.MaxFrameBytes)
	ctx, cancel := connectionContext(r)
	h.mutex.Lock()
	h.connections[conn] = cancel
	closing := h.closing
	h.mutex.Unlock()
	if closing {
		cancel()
		_ = conn.CloseNow()
	}
	cleanup := func() {
		cancel()
		_ = conn.CloseNow()
		h.mutex.Lock()
		delete(h.connections, conn)
		h.reserved--
		h.mutex.Unlock()
		h.active.Done()
	}
	return conn, ctx, cleanup, nil
}

// ActiveConnections reports WebSockets that have completed their upgrade.
func (h *Routes) ActiveConnections() int {
	h.mutex.Lock()
	defer h.mutex.Unlock()
	return len(h.connections)
}

// completedDrainError retains disconnect failures after all relay work has exited.
type completedDrainError struct{ cause error }

func (e completedDrainError) Error() string { return e.cause.Error() }
func (e completedDrainError) Unwrap() error { return e.cause }
func (e completedDrainError) Drained() bool { return true }

func (h *Routes) Shutdown(ctx context.Context) error {
	h.mutex.Lock()
	var connections []*websocket.Conn
	if !h.closing {
		h.closing = true
		h.drained = make(chan struct{})
		// Admission and Add share this mutex, so no work can be added after
		// the wait starts, including upgrades already holding a reservation.
		go func() { h.active.Wait(); close(h.drained) }()
		connections = make([]*websocket.Conn, 0, len(h.connections))
		for conn, cancel := range h.connections {
			cancel()
			connections = append(connections, conn)
		}
	}
	done := h.drained
	h.mutex.Unlock()
	for _, conn := range connections {
		_ = conn.CloseNow()
	}
	select {
	case <-done:
		h.mutex.Lock()
		err := h.drainErr
		h.mutex.Unlock()
		if err != nil {
			return completedDrainError{cause: err}
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (h *Routes) recordDrainError(err error) {
	if err == nil {
		return
	}
	h.mutex.Lock()
	defer h.mutex.Unlock()
	if h.closing {
		h.drainErr = errors.Join(h.drainErr, err)
	}
}
func relayWrite(ctx context.Context, conn *websocket.Conn, value any) error {
	data, err := sp.MarshalWire(value)
	if err != nil {
		return err
	}
	limit := sp.MaxFrameBytes
	if conn != nil && conn.Subprotocol() == v2.Protocol {
		limit = 4 * 1024 * 1024
	}
	if len(data) > limit {
		return &model.Fault{Code: "payload_too_large", Message: "Session frame exceeds the negotiated protocol limit."}
	}
	write, cancel := context.WithTimeout(ctx, relayWriteTimeout)
	defer cancel()
	return conn.Write(write, websocket.MessageText, data)
}
func relayRead(ctx context.Context, conn *websocket.Conn, timeout time.Duration) (sp.ControllerMessage, error) {
	read, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	kind, data, err := conn.Read(read)
	if err != nil {
		return sp.ControllerMessage{}, err
	}
	if kind != websocket.MessageText {
		return sp.ControllerMessage{}, httpx.InvalidInput("Controller messages must be JSON text.")
	}
	value, err := sp.DecodeController(data)
	if err != nil {
		return sp.ControllerMessage{}, httpx.InvalidInput("Invalid controller message.")
	}
	return value, nil
}
func (h *Routes) channelFailure(ctx context.Context, conn *websocket.Conn, fence sp.ControllerFence, err error) {
	if ctx.Err() != nil {
		return
	}
	httpx.LogFailure(h.logger, ctx, "session", "channel", err)
	code, message := "internal_error", "Session channel failed."
	if fault, ok := httpx.KnownFault(err); ok {
		code, message = fault.Code, fault.Message
	}
	_ = relayWrite(ctx, conn, sp.BindingFields(fence.Fence, map[string]any{"type": "error", "protocol": sp.Protocol, "sessionId": fence.SessionID, "claimId": fence.ClaimID, "executionGeneration": fence.ExecutionGeneration, "connectionEpoch": fence.ConnectionEpoch, "code": code, "message": message}))
}
func (h *Routes) controllerChannel(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	token, err := controllerToken(r)
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	protocol, protocolErr := selectedSessionProtocol(r)
	if protocolErr != nil {
		h.Failure(w, r, protocolErr)
		return
	}
	if protocol != sp.Protocol {
		h.Failure(w, r, terminalFault("unsupported_protocol", "Web controller endpoints require daynight.session.v1."))
		return
	}

	if _, err = httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	readVersion, err := contentReadVersion(r)
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	if err = h.origin(r, false); err != nil {
		h.Failure(w, r, err)
		return
	}
	if err = h.service.AuthenticateController(r.Context(), token); err != nil {
		h.channelAdmissionFailure(w, r, err)
		return
	}
	conn, ctx, cleanup, err := h.accept(w, r)
	if err != nil {
		if fault, ok := httpx.KnownFault(err); ok {
			h.Failure(w, r, fault)
		}
		return
	}
	defer cleanup()
	hello, err := relayRead(ctx, conn, 10*time.Second)
	if err != nil || hello.Type != "hello" {
		return
	}
	snapshot, err := h.service.Connect(ctx, token, hello, h.instance, readVersion)
	if err != nil {
		return
	}
	fence := snapshot.ControllerFence
	defer func() {
		closeContext, cancel := context.WithTimeout(context.Background(), relayWriteTimeout)
		defer cancel()
		h.recordDrainError(h.service.Disconnect(closeContext, fence))
	}()
	seq, err := h.service.SourceSeq(ctx, fence)
	if err != nil {
		h.channelFailure(ctx, conn, fence, err)
		return
	}
	if err = relayWrite(ctx, conn, map[string]any{"type": "welcome", "requiresLiveSync": true, "protocol": sp.Protocol, "connectionEpoch": fence.ConnectionEpoch, "session": snapshot, "lastAckedSourceSeq": strconv.FormatInt(seq, 10), "limits": map[string]any{"maxFrameBytes": sp.MaxFrameBytes, "maxBatchEvents": sp.MaxBatchEvents, "maxResourceBytes": sp.MaxResourceBytes, "pollIntervalMs": 250}}); err != nil {
		return
	}
	type incoming struct {
		message sp.ControllerMessage
		err     error
	}
	messages := make(chan incoming, 1)
	readerDone := make(chan struct{})
	readCtx, cancelRead := context.WithCancel(ctx)
	go func() {
		defer close(readerDone)
		for {
			message, err := relayRead(readCtx, conn, 30*time.Second)
			select {
			case messages <- incoming{message, err}:
			case <-readCtx.Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	defer func() { cancelRead(); _ = conn.CloseNow(); <-readerDone }()
	ticker := time.NewTicker(sessioncore.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case input := <-messages:
			if input.err != nil {
				return
			}
			if input.message.Type == "hello" || input.message.ControllerFence != fence {
				h.channelFailure(ctx, conn, fence, &model.Fault{Code: "session_conflict", Message: "Controller connection fence changed."})
				return
			}
			response, err := h.service.Handle(ctx, input.message)
			if err != nil {
				var refusal *sessioncore.CaptureRequestError
				if input.message.Type == "image_capture" && errors.As(err, &refusal) {
					response := sp.BindingFields(fence.Fence, map[string]any{"type": "image_capture_result", "protocol": sp.Protocol, "sessionId": fence.SessionID, "claimId": fence.ClaimID, "executionGeneration": fence.ExecutionGeneration, "connectionEpoch": fence.ConnectionEpoch, "requestId": input.message.RequestID, "action": input.message.Action, "result": nil, "error": sp.ImageError{Code: refusal.Code, Message: refusal.Message}})
					if err = relayWrite(ctx, conn, response); err != nil {
						return
					}
					continue
				}
				h.channelFailure(ctx, conn, fence, err)
				return
			}
			if response != nil {
				if err = relayWrite(ctx, conn, response); err != nil {
					return
				}
			}
		case <-ticker.C:
			offers, err := h.service.Poll(ctx, fence)
			if err != nil {
				h.channelFailure(ctx, conn, fence, err)
				return
			}
			for _, offer := range offers {
				if err = relayWrite(ctx, conn, offer); err != nil {
					return
				}
			}
		}
	}
}
func (h *Routes) browserChannel(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if err := h.userChannelOrigin(r, p); err != nil {
		h.Failure(w, r, err)
		return
	}
	values, err := httpx.QueryValues(r, "after")
	if err != nil {
		h.Failure(w, r, err)
		return
	}
	project, task, id := r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId")
	snapshot, events, cursor, err := h.service.BrowserPoll(r.Context(), p, project, task, id, values.Get("after"))
	reset := false
	if err != nil {
		var fault *model.Fault
		if errors.As(err, &fault) && fault.Code == "reset_required" {
			reset = true
			err = nil
		} else {
			h.channelAdmissionFailure(w, r, err)
			return
		}
	}
	conn, ctx, cleanup, err := h.accept(w, r)
	if err != nil {
		if fault, ok := httpx.KnownFault(err); ok {
			h.Failure(w, r, fault)
		}
		return
	}
	defer cleanup()
	closed := conn.CloseRead(ctx)
	defer func() { h.closeUserChannel(ctx, conn, err) }()
	if reset {
		_ = relayWrite(ctx, conn, map[string]any{"type": "reset_required", "protocol": sp.Protocol, "reason": "Session cursor is no longer available."})
		return
	}
	initialCursor := cursor
	if values.Get("after") != "" {
		initialCursor = values.Get("after")
	}
	sendSnapshot := func(value sp.Snapshot, position string) error {
		return relayWrite(ctx, conn, map[string]any{"type": "snapshot", "protocol": sp.Protocol, "userId": p.UserID, "snapshot": value, "cursor": position})
	}
	sendEvents := func(value sp.Snapshot, batch []map[string]any) error {
		for _, event := range batch {
			seq, ok := event["eventSeq"].(string)
			if !ok {
				return errors.New("invalid persisted session sequence")
			}
			if err := relayWrite(ctx, conn, map[string]any{"type": "event", "protocol": sp.Protocol, "event": event, "cursor": sessioncore.EventCursor(value, seq)}); err != nil {
				return err
			}
		}
		return nil
	}
	if err = sendSnapshot(snapshot, initialCursor); err != nil {
		return
	}
	if err = sendEvents(snapshot, events); err != nil {
		return
	}
	ticker := time.NewTicker(sessioncore.PollInterval)
	defer ticker.Stop()
	ping := time.NewTicker(h.pingInterval)
	defer ping.Stop()
	for {
		select {
		case <-closed.Done():
			return
		case <-ping.C:
			pingCtx, cancel := context.WithTimeout(ctx, relayWriteTimeout)
			err = conn.Ping(pingCtx)
			cancel()
			if err != nil {
				return
			}
		case <-ticker.C:
			next, batch, position, pollErr := h.service.BrowserPoll(ctx, p, project, task, id, cursor)
			if pollErr != nil {
				var fault *model.Fault
				if errors.As(pollErr, &fault) && fault.Code == "reset_required" {
					_ = relayWrite(ctx, conn, map[string]any{"type": "reset_required", "protocol": sp.Protocol, "reason": fault.Message})
				} else {
					h.closeUserChannel(ctx, conn, pollErr)
				}
				return
			}
			if err = sendEvents(next, batch); err != nil {
				return
			}
			if !reflect.DeepEqual(next, snapshot) {
				if err = sendSnapshot(next, position); err != nil {
					return
				}
			}
			snapshot, cursor = next, position
		}
	}
}
