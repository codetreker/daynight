package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type ReadOnlyRoutes struct {
	broker         *ro.Broker
	auth           *authhttp.Authentication
	logger         *slog.Logger
	mu             sync.Mutex
	closing        bool
	reserved       int
	requests       int
	requestTargets map[string]int
	bodyTimeout    time.Duration
	active         sync.WaitGroup
	connections    map[*websocket.Conn]context.CancelFunc
	drained        chan struct{}
	once           sync.Once
}

func NewReadOnlyRoutes(broker *ro.Broker, auth *authhttp.Authentication, logger *slog.Logger) *ReadOnlyRoutes {
	return &ReadOnlyRoutes{broker: broker, auth: auth, logger: logger, connections: map[*websocket.Conn]context.CancelFunc{}, drained: make(chan struct{}), requestTargets: map[string]int{}, bodyTimeout: 5 * time.Second}
}
func (h *ReadOnlyRoutes) RegisterRoutes(mux *http.ServeMux) {
	const base = "/api/v1/me/workers/{workerId}/readonly"
	mux.HandleFunc("POST "+base+"/requests", h.auth.Require(h.request))
	mux.HandleFunc(base+"/requests", h.auth.Require(httpx.ResourceMethodNotAllowed(h.logger, "POST")))
	mux.HandleFunc("GET "+base+"/channel", h.auth.Require(h.channel))
	mux.HandleFunc("HEAD "+base+"/channel", h.auth.Require(httpx.ResourceMethodNotAllowed(h.logger, "GET")))
	mux.HandleFunc(base+"/channel", h.auth.Require(httpx.ResourceMethodNotAllowed(h.logger, "GET")))
}
func (h *ReadOnlyRoutes) failure(w http.ResponseWriter, r *http.Request, err error) {
	status := 0
	switch ro.ErrorCode(err) {
	case "offline":
		status = http.StatusServiceUnavailable
	case "unsupported":
		status = http.StatusNotImplemented
	case "busy":
		status = http.StatusTooManyRequests
	case "timeout":
		status = http.StatusGatewayTimeout
	case "cancelled":
		status = http.StatusConflict
	}
	if status == 0 {
		httpx.WriteError(w, r, h.logger, "worker_readonly", "request", err)
		return
	}
	var f *model.Fault
	if !errors.As(err, &f) {
		httpx.WriteError(w, r, h.logger, "worker_readonly", "request", err)
		return
	}
	httpx.WriteJSON(w, r, h.logger, status, api.ErrorResponse{Error: api.Error{Code: f.Code, Message: f.Message, RequestID: httpx.RequestID(r.Context())}})
}
func readOnlyWorker(r *http.Request) (string, error) {
	if r.URL.RawQuery != "" || r.URL.ForceQuery {
		return "", httpx.InvalidInput("Worker read-only requests do not accept query parameters.")
	}
	return model.CanonicalID(r.PathValue("workerId"))
}
func (h *ReadOnlyRoutes) request(w http.ResponseWriter, r *http.Request, p model.Principal) {
	started := time.Now()
	ctx, cancel := context.WithDeadline(r.Context(), started.Add(ro.ModelRequestTimeout))
	defer cancel()
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(started.Add(h.bodyTimeout))
	_ = controller.SetWriteDeadline(started.Add(ro.ModelRequestTimeout + 5*time.Second))
	defer func() {
		_ = controller.Flush()
		_ = controller.SetReadDeadline(time.Time{})
		_ = controller.SetWriteDeadline(time.Time{})
	}()
	id, err := readOnlyWorker(r)
	if err != nil {
		h.failure(w, r, err)
		return
	}
	target := p.UserID + "/" + id
	h.mu.Lock()
	if h.closing || h.requests >= 1024 || h.requestTargets[target] >= 16 {
		h.mu.Unlock()
		h.failure(w, r, &model.Fault{Code: "busy", Message: "Worker read-only HTTP request capacity is exhausted."})
		return
	}
	h.requests++
	h.requestTargets[target]++
	h.active.Add(1)
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.requests--
		h.requestTargets[target]--
		if h.requestTargets[target] == 0 {
			delete(h.requestTargets, target)
		}
		h.mu.Unlock()
		h.active.Done()
	}()

	var input ro.Request
	if err == nil {
		var raw []byte
		raw, err = io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
		if err != nil {
			r.Close = true
			w.Header().Set("Connection", "close")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(api.ErrorResponse{Error: api.Error{Code: "invalid_input", Message: "Worker read-only request is too large or unreadable."}})
			return
		} else {
			err = ro.Decode(raw, &input)
		}
	}
	var result ro.Message
	if err == nil {
		// The operation budget starts at HTTP admission, including time spent reading its body.
		timeout := ro.OperationTimeout(input.Operation)
		operationCtx, stop := context.WithDeadline(ctx, started.Add(timeout))
		defer stop()
		_ = controller.SetWriteDeadline(started.Add(timeout + 5*time.Second))
		result, err = h.broker.Request(operationCtx, p, id, input)
	}
	if err != nil {
		h.failure(w, r, err)
		return
	}
	if r.Context().Err() == nil {
		raw, err := readOnlyResultJSON(result, input.Operation)
		if err != nil {
			h.failure(w, r, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		if _, err = w.Write(raw); err != nil {
			httpx.LogFailure(h.logger, r.Context(), "worker_readonly", "response", err)
		}
	}
}

func readOnlyResultJSON(result ro.Message, operation string) ([]byte, error) {
	if err := ro.ValidateOperationResult(result, operation); err != nil {
		return nil, err
	}
	var raw bytes.Buffer
	encoder := json.NewEncoder(&raw)
	// HTML escaping can expand an admitted directory beyond the HTTP wire budget.
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(result); err != nil {
		return nil, err
	}
	if raw.Len() > ro.MaxWireBytes {
		return nil, httpx.InvalidInput("Worker read-only response exceeds its wire byte limit.")
	}
	return raw.Bytes(), nil
}

func readOnlyWrite(ctx context.Context, c *websocket.Conn, m ro.Message) error {
	raw, err := json.Marshal(m)
	if err != nil {
		return err
	}
	write, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return c.Write(write, websocket.MessageText, raw)
}

// Refused upgrades must not drain a caller-controlled HTTP body before closing.
func (h *ReadOnlyRoutes) refuseChannel(w http.ResponseWriter, r *http.Request, err error) {
	r.Close = true
	w.Header().Set("Connection", "close")
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(time.Now().Add(5 * time.Second))
	defer func() { _ = controller.Flush(); _ = controller.SetWriteDeadline(time.Time{}) }()
	h.failure(w, r, err)
}
func (h *ReadOnlyRoutes) channel(w http.ResponseWriter, r *http.Request, p model.Principal) {
	id, err := readOnlyWorker(r)
	if err == nil && (r.ContentLength != 0 || len(r.TransferEncoding) != 0) {
		err = httpx.InvalidInput("Worker read-only channels do not accept request bodies.")
	}
	if err == nil && p.Kind != model.PATCredential {
		err = &model.Fault{Code: "permission_denied", Message: "Worker channels require a personal access token."}
	}
	if err != nil {
		h.refuseChannel(w, r, err)
		return
	}
	h.mu.Lock()
	if h.closing || h.reserved >= 1024 {
		h.mu.Unlock()
		h.refuseChannel(w, r, &model.Fault{Code: "busy", Message: "Worker read-only channels are unavailable."})
		return
	}
	h.active.Add(1)
	h.reserved++
	h.mu.Unlock()
	defer func() { h.mu.Lock(); h.reserved--; h.mu.Unlock(); h.active.Done() }()
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	defer c.CloseNow()
	c.SetReadLimit(ro.MaxWireBytes)
	h.mu.Lock()
	if h.closing {
		h.mu.Unlock()
		return
	}
	h.connections[c] = cancel
	h.mu.Unlock()
	defer func() { h.mu.Lock(); delete(h.connections, c); h.mu.Unlock() }()
	helloCtx, helloCancel := context.WithTimeout(ctx, 10*time.Second)
	kind, raw, err := c.Read(helloCtx)
	helloCancel()
	var hello ro.Hello
	if err != nil || kind != websocket.MessageText {
		return
	}
	if err = ro.Decode(raw, &hello); err != nil {
		return
	}
	connection, err := h.broker.Connect(ctx, p, id, hello)
	if err != nil {
		return
	}
	defer h.broker.Disconnect(connection)
	if err = readOnlyWrite(ctx, c, ro.Message{Fence: connection.Fence, Type: "ready"}); err != nil {
		return
	}
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		defer cancel()
		for {
			kind, raw, err := c.Read(ctx)
			if err != nil || kind != websocket.MessageText {
				return
			}
			var m ro.Message
			if err = ro.Decode(raw, &m); err != nil {
				return
			}
			if err = h.broker.Deliver(ctx, connection, m); err != nil && ro.ErrorCode(err) != "cancelled" {
				return
			}
		}
	}()
	defer func() { cancel(); _ = c.CloseNow(); <-readDone }()
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-connection.Done:
			return
		case m := <-connection.Messages:
			if err = readOnlyWrite(ctx, c, m); err != nil {
				return
			}
		case <-tick.C:
			check, stop := context.WithTimeout(ctx, 5*time.Second)
			err = h.broker.Check(check, connection)
			if err == nil {
				err = c.Ping(check)
			}
			stop()
			if err != nil {
				return
			}
		}
	}
}
func (h *ReadOnlyRoutes) BeginShutdown() {
	h.mu.Lock()
	h.closing = true
	for _, cancel := range h.connections {
		cancel()
	}
	h.mu.Unlock()
	h.broker.Close()
	h.once.Do(func() { go func() { h.active.Wait(); close(h.drained) }() })
}
func (h *ReadOnlyRoutes) Shutdown(ctx context.Context) error {
	h.BeginShutdown()
	select {
	case <-h.drained:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
