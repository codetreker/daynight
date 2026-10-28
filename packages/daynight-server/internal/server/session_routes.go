package server

import (
	"context"
	"encoding/json"
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

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/sessionrelay"
	"github.com/google/uuid"
)

const sessionBase = "/api/v1/projects/{projectId}/tasks/{taskId}/sessions"
const relayWriteTimeout = 5 * time.Second
const relayMaxConnections = 1024

type sessionRoutes struct {
	service     *sessionrelay.Service
	auth        *Authentication
	logger      *slog.Logger
	instance    string
	mutex       sync.Mutex
	closing     bool
	reserved    int
	connections map[*websocket.Conn]context.CancelFunc
	active      sync.WaitGroup
}
type sessionApplication struct {
	http.Handler
	relay *sessionRoutes
}

func (a *sessionApplication) Shutdown(ctx context.Context) error { return a.relay.shutdown(ctx) }

func newSessionRoutes(s *sessionrelay.Service, auth *Authentication, logger *slog.Logger) *sessionRoutes {
	return &sessionRoutes{service: s, auth: auth, logger: logger, instance: uuid.NewString(), connections: make(map[*websocket.Conn]context.CancelFunc)}
}
func (h *sessionRoutes) register(mux *http.ServeMux) {
	h.registerTestRoutes(mux)
	mux.HandleFunc("GET /api/v1/session-capabilities", h.auth.Require(func(w http.ResponseWriter, r *http.Request, _ core.Principal) {
		if _, err := queryValues(r); err != nil {
			h.failure(w, r, err)
			return
		}
		writeJSON(w, r, h.logger, http.StatusOK, map[string]any{"protocol": sp.Protocol, "schemaVersion": 1, "projectionVersion": 1, "providers": []string{"codex", "claude", "copilot"}})
	}))
	capabilityMethod := h.auth.Require(func(w http.ResponseWriter, r *http.Request, _ core.Principal) {
		methodNotAllowed(h.logger, "GET")(w, r)
	})
	mux.HandleFunc("HEAD /api/v1/session-capabilities", capabilityMethod)
	mux.HandleFunc("/api/v1/session-capabilities", capabilityMethod)
	handlers := map[string]AuthenticatedHandler{
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
		mux.HandleFunc(route, h.auth.Require(h.parameters(handler)))
	}
	for path, methods := range map[string]string{sessionBase: "POST", sessionBase + "/current": "GET", sessionBase + "/{sessionId}/controller-grant": "POST", sessionBase + "/{sessionId}/timeline": "GET", sessionBase + "/{sessionId}/commands": "POST", sessionBase + "/{sessionId}/operations/{operationId}": "GET", sessionBase + "/{sessionId}/resources/{resourceId}/content": "GET", sessionBase + "/{sessionId}/channel": "GET"} {
		fallback := methodNotAllowed(h.logger, methods)
		mux.HandleFunc(path, h.auth.Require(func(w http.ResponseWriter, r *http.Request, _ core.Principal) { fallback(w, r) }))
		if methods == "GET" {
			mux.HandleFunc("HEAD "+path, h.auth.Require(func(w http.ResponseWriter, r *http.Request, _ core.Principal) { fallback(w, r) }))
		}
	}
	mux.HandleFunc("GET /api/v1/controller-channel", h.controllerChannel)
	mux.HandleFunc("HEAD /api/v1/controller-channel", methodNotAllowed(h.logger, "GET"))
	mux.HandleFunc("/api/v1/controller-channel", methodNotAllowed(h.logger, "GET"))
	mux.HandleFunc("PUT /api/v1/controller-resources/{resourceId}", h.putResource)
	mux.HandleFunc("/api/v1/controller-resources/{resourceId}", methodNotAllowed(h.logger, "PUT"))
}
func (h *sessionRoutes) parameters(next AuthenticatedHandler) AuthenticatedHandler {
	return func(w http.ResponseWriter, r *http.Request, p core.Principal) {
		for _, name := range []string{"projectId", "taskId", "sessionId", "operationId", "resourceId"} {
			if raw := r.PathValue(name); raw != "" {
				id, err := service.CanonicalID(raw)
				if err != nil {
					h.failure(w, r, err)
					return
				}
				r.SetPathValue(name, id)
			}
		}
		next(w, r, p)
	}
}
func (h *sessionRoutes) failure(w http.ResponseWriter, r *http.Request, err error) {
	writeError(w, r, h.logger, "session", "relay", err)
}
func (h *sessionRoutes) result(w http.ResponseWriter, r *http.Request, status int, value any, err error) {
	if err != nil {
		h.failure(w, r, err)
		return
	}
	writeJSON(w, r, h.logger, status, value)
}
func relayBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	if _, err := queryValues(r); err != nil {
		return nil, err
	}
	kind, parameters, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || kind != "application/json" || parameters["charset"] != "" && !strings.EqualFold(parameters["charset"], "utf-8") {
		return nil, invalidInput("Content-Type must be application/json with UTF-8 encoding.")
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, sp.MaxFrameBytes))
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			return nil, &service.Fault{Code: "payload_too_large", Message: "Session request exceeds the 2 MiB limit."}
		}
		return nil, invalidInput("Unable to read session request.")
	}
	return body, nil
}
func (h *sessionRoutes) registerSession(w http.ResponseWriter, r *http.Request, p core.Principal) {
	body, err := relayBody(w, r)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	input, err := sp.DecodeRegistration(body)
	if err != nil {
		h.failure(w, r, invalidInput("Invalid session registration."))
		return
	}
	snapshot, err := h.service.Register(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), input)
	h.result(w, r, http.StatusOK, map[string]any{"session": snapshot}, err)
}
func (h *sessionRoutes) current(w http.ResponseWriter, r *http.Request, p core.Principal) {
	if _, err := queryValues(r); err != nil {
		h.failure(w, r, err)
		return
	}
	result, err := h.service.Current(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"))
	h.result(w, r, http.StatusOK, result, err)
}
func (h *sessionRoutes) grant(w http.ResponseWriter, r *http.Request, p core.Principal) {
	body, err := relayBody(w, r)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	input, err := sp.DecodeGrant(body)
	if r.PathValue("projectId") == "" {
		input, err = sp.DecodeTestGrant(body)
	}
	if err != nil {
		h.failure(w, r, invalidInput("Invalid controller grant request."))
		return
	}
	result, err := h.service.Grant(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), input)
	h.result(w, r, http.StatusOK, result, err)
}
func (h *sessionRoutes) timeline(w http.ResponseWriter, r *http.Request, p core.Principal) {
	values, err := queryValues(r, "direction", "cursor", "limit")
	if err != nil {
		h.failure(w, r, err)
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
		h.failure(w, r, invalidInput("Invalid session timeline direction, cursor, or limit."))
		return
	}
	result, err := h.service.Timeline(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), direction, values.Get("cursor"), limit)
	h.result(w, r, http.StatusOK, result, err)
}
func (h *sessionRoutes) submit(w http.ResponseWriter, r *http.Request, p core.Principal) {
	body, err := relayBody(w, r)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	command, err := sp.DecodeCommand(body)
	if err != nil {
		h.failure(w, r, invalidInput("Invalid session command."))
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
	h.result(w, r, http.StatusAccepted, map[string]any{"operation": operation, "operationUrl": location}, err)
}
func (h *sessionRoutes) operation(w http.ResponseWriter, r *http.Request, p core.Principal) {
	if _, err := queryValues(r); err != nil {
		h.failure(w, r, err)
		return
	}
	result, err := h.service.Operation(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), r.PathValue("operationId"))
	h.result(w, r, http.StatusOK, map[string]any{"operation": result}, err)
}
func (h *sessionRoutes) resource(w http.ResponseWriter, r *http.Request, p core.Principal) {
	if _, err := queryValues(r); err != nil {
		h.failure(w, r, err)
		return
	}
	data, resource, err := h.service.Resource(r.Context(), p, r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId"), r.PathValue("resourceId"))
	if err != nil {
		h.failure(w, r, err)
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
		LogFailure(h.logger, r.Context(), "session", "resource", err)
	}
}
func controllerToken(r *http.Request) (string, error) {
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return "", authFailure()
	}
	parts := strings.Fields(values[0])
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || !strings.HasPrefix(parts[1], "dncontroller_") {
		return "", authFailure()
	}
	return parts[1], nil
}
func (h *sessionRoutes) putResource(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	token, err := controllerToken(r)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	if _, err = queryValues(r); err != nil {
		h.failure(w, r, err)
		return
	}
	id, err := service.CanonicalID(r.PathValue("resourceId"))
	if err != nil {
		h.failure(w, r, err)
		return
	}
	epochs := r.Header.Values("Daynight-Connection-Epoch")
	if len(epochs) != 1 {
		h.failure(w, r, invalidInput("A controller connection epoch is required."))
		return
	}
	epoch, err := strconv.ParseInt(epochs[0], 10, 64)
	if err != nil || epoch < 1 || strconv.FormatInt(epoch, 10) != epochs[0] {
		h.failure(w, r, invalidInput("Invalid controller connection epoch."))
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, sp.MaxResourceBytes))
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			h.failure(w, r, &service.Fault{Code: "payload_too_large", Message: "Session resources are limited to 8 MiB."})
		} else {
			h.failure(w, r, invalidInput("Unable to read session resource."))
		}
		return
	}
	result, err := h.service.PutResource(r.Context(), token, epochs[0], id, data)
	h.result(w, r, http.StatusOK, map[string]any{"resource": result}, err)
}
func (h *sessionRoutes) origin(r *http.Request, cookie bool) error {
	origins := r.Header.Values("Origin")
	if cookie || len(origins) > 0 {
		if len(origins) != 1 || origins[0] != h.auth.origin {
			return &service.Fault{Code: "forbidden", Message: "Session channels require the exact main-site Origin."}
		}
	}
	return nil
}
func (h *sessionRoutes) accept(w http.ResponseWriter, r *http.Request) (*websocket.Conn, context.Context, func(), error) {
	h.mutex.Lock()
	if h.closing || h.reserved >= relayMaxConnections {
		h.mutex.Unlock()
		return nil, nil, nil, &service.Fault{Code: "rate_limited", Message: "Session channel capacity is unavailable."}
	}
	h.reserved++
	h.active.Add(1)
	h.mutex.Unlock()
	// Exact Origin was already checked; library host matching is intentionally bypassed.
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		h.mutex.Lock()
		h.reserved--
		h.mutex.Unlock()
		h.active.Done()
		return nil, nil, nil, err
	}
	conn.SetReadLimit(sp.MaxFrameBytes)
	ctx, cancel := context.WithCancel(r.Context())
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
func (h *sessionRoutes) shutdown(ctx context.Context) error {
	h.mutex.Lock()
	h.closing = true
	connections := make([]*websocket.Conn, 0, len(h.connections))
	for conn, cancel := range h.connections {
		cancel()
		connections = append(connections, conn)
	}
	h.mutex.Unlock()
	for _, conn := range connections {
		_ = conn.CloseNow()
	}
	done := make(chan struct{})
	go func() { h.active.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func relayWrite(ctx context.Context, conn *websocket.Conn, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) > sp.MaxFrameBytes {
		return &service.Fault{Code: "payload_too_large", Message: "Session frame exceeds the 2 MiB limit."}
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
		return sp.ControllerMessage{}, invalidInput("Controller messages must be JSON text.")
	}
	value, err := sp.DecodeController(data)
	if err != nil {
		return sp.ControllerMessage{}, invalidInput("Invalid controller message.")
	}
	return value, nil
}
func (h *sessionRoutes) channelFailure(ctx context.Context, conn *websocket.Conn, fence sp.ControllerFence, err error) {
	if ctx.Err() != nil {
		return
	}
	LogFailure(h.logger, ctx, "session", "channel", err)
	code, message := "internal_error", "Session channel failed."
	if fault, ok := knownFault(err); ok {
		code, message = fault.Code, fault.Message
	}
	_ = relayWrite(ctx, conn, sp.BindingFields(fence.Fence, map[string]any{"type": "error", "protocol": sp.Protocol, "sessionId": fence.SessionID, "claimId": fence.ClaimID, "executionGeneration": fence.ExecutionGeneration, "connectionEpoch": fence.ConnectionEpoch, "code": code, "message": message}))
}
func (h *sessionRoutes) controllerChannel(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	token, err := controllerToken(r)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	if _, err = queryValues(r); err != nil {
		h.failure(w, r, err)
		return
	}
	if err = h.origin(r, false); err != nil {
		h.failure(w, r, err)
		return
	}
	if err = h.service.AuthenticateController(r.Context(), token); err != nil {
		h.failure(w, r, err)
		return
	}
	conn, ctx, cleanup, err := h.accept(w, r)
	if err != nil {
		if fault, ok := knownFault(err); ok {
			h.failure(w, r, fault)
		}
		return
	}
	defer cleanup()
	hello, err := relayRead(ctx, conn, 10*time.Second)
	if err != nil || hello.Type != "hello" {
		return
	}
	snapshot, err := h.service.Connect(ctx, token, hello, h.instance)
	if err != nil {
		return
	}
	fence := snapshot.ControllerFence
	defer func() {
		closeContext, cancel := context.WithTimeout(context.Background(), relayWriteTimeout)
		defer cancel()
		_ = h.service.Disconnect(closeContext, fence)
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
	ticker := time.NewTicker(sessionrelay.PollInterval)
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
				h.channelFailure(ctx, conn, fence, &service.Fault{Code: "session_conflict", Message: "Controller connection fence changed."})
				return
			}
			response, err := h.service.Handle(ctx, input.message)
			if err != nil {
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
func (h *sessionRoutes) browserChannel(w http.ResponseWriter, r *http.Request, p core.Principal) {
	if err := h.origin(r, p.Kind == core.SessionCredential); err != nil {
		h.failure(w, r, err)
		return
	}
	values, err := queryValues(r, "after")
	if err != nil {
		h.failure(w, r, err)
		return
	}
	project, task, id := r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId")
	snapshot, events, cursor, err := h.service.BrowserPoll(r.Context(), p, project, task, id, values.Get("after"))
	reset := false
	if err != nil {
		var fault *service.Fault
		if errors.As(err, &fault) && fault.Code == "reset_required" {
			reset = true
		} else {
			h.failure(w, r, err)
			return
		}
	}
	conn, ctx, cleanup, err := h.accept(w, r)
	if err != nil {
		if fault, ok := knownFault(err); ok {
			h.failure(w, r, fault)
		}
		return
	}
	defer cleanup()
	closed := conn.CloseRead(ctx)
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
			if err := relayWrite(ctx, conn, map[string]any{"type": "event", "protocol": sp.Protocol, "event": event, "cursor": sessionrelay.EventCursor(value, seq)}); err != nil {
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
	ticker := time.NewTicker(sessionrelay.PollInterval)
	defer ticker.Stop()
	ping := time.NewTicker(10 * time.Second)
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
			next, batch, position, err := h.service.BrowserPoll(ctx, p, project, task, id, cursor)
			if err != nil {
				var fault *service.Fault
				if errors.As(err, &fault) && fault.Code == "reset_required" {
					_ = relayWrite(ctx, conn, map[string]any{"type": "reset_required", "protocol": sp.Protocol, "reason": fault.Message})
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
