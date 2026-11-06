package session

import (
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"

	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

func sessionSubprotocols(r *http.Request) []string {
	var values []string
	for _, header := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, value := range strings.Split(header, ",") {
			values = append(values, strings.TrimSpace(value))
		}
	}
	return values
}

// Selection is explicit. An absent selector preserves the strict v1 response.
func selectedSessionProtocol(r *http.Request) (string, error) {
	headers := r.Header.Values(v2.ProtocolHeader)
	if len(headers) > 1 {
		return "", terminalFault("unsupported_protocol", "Select one Session protocol.")
	}
	var header *string
	if len(headers) == 1 {
		header = &headers[0]
	}
	selected, err := v2.SelectProtocol(header)
	if err != nil {
		return "", terminalFault("unsupported_protocol", "Unsupported Session protocol.")
	}
	values := sessionSubprotocols(r)
	if len(values) == 0 {
		return selected, nil
	}
	socketProtocol := ""
	for _, value := range values {
		if value == v2.Protocol {
			socketProtocol = v2.Protocol
			break
		}
		if value == sp.Protocol {
			socketProtocol = sp.Protocol
		}
	}
	if socketProtocol == "" || header != nil && selected != socketProtocol {
		return "", terminalFault("unsupported_protocol", "Session protocol selectors disagree or are unsupported.")
	}
	return socketProtocol, nil
}
func terminalFault(code, message string) error { return &model.Fault{Code: code, Message: message} }
func (h *Routes) registerTerminalRoutes(mux *http.ServeMux) {
	for path, method := range map[string]string{
		sessionBase: "GET", sessionBase + "/{sessionId}/state": "GET",
		sessionBase + "/{sessionId}/worker-messages":                  "POST",
		sessionBase + "/{sessionId}/worker-channel":                   "GET",
		sessionBase + "/{sessionId}/archive/receipt":                  "GET",
		sessionBase + "/{sessionId}/archive/state":                    "GET",
		sessionBase + "/{sessionId}/recording-evidence/{evidenceId}":  "GET",
		sessionBase + "/{sessionId}/automation-recovery/{recoveryId}": "GET",
	} {
		mux.HandleFunc(method+" "+path, h.auth.Require(h.Parameters(func(w http.ResponseWriter, r *http.Request, _ model.Principal) {
			h.Failure(w, r, terminalFault("unsupported_protocol", "This endpoint requires daynight.session.v2."))
		})))
		if path != sessionBase {
			fallback := h.auth.Require(func(w http.ResponseWriter, r *http.Request, _ model.Principal) {
				httpx.MethodNotAllowed(h.logger, method)(w, r)
			})
			mux.HandleFunc(path, fallback)
			if path != sessionBase+"/{sessionId}/state" {
				mux.HandleFunc("HEAD "+path, fallback)
			}
		}
	}
}
func terminalEpoch(r *http.Request) (string, error) {
	values := r.Header.Values("Daynight-Connection-Epoch")
	if len(values) != 1 {
		return "", httpx.InvalidInput("A terminal connection epoch is required.")
	}
	n, err := strconv.ParseInt(values[0], 10, 64)
	if err != nil || n < 1 || strconv.FormatInt(n, 10) != values[0] {
		return "", httpx.InvalidInput("Invalid terminal connection epoch.")
	}
	return values[0], nil
}
func terminalBody(w http.ResponseWriter, r *http.Request) (v2.Message, error) {
	if _, err := httpx.QueryValues(r); err != nil {
		return v2.Message{}, err
	}
	media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" || params["charset"] != "" && !strings.EqualFold(params["charset"], "utf-8") {
		return v2.Message{}, httpx.InvalidInput("Content-Type must be application/json with UTF-8 encoding.")
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4*1024*1024))
	if err != nil {
		return v2.Message{}, terminalFault("invalid_payload", "Unable to read bounded terminal message.")
	}
	m, err := v2.DecodeMessage(raw)
	if err != nil {
		return v2.Message{}, terminalFault("invalid_payload", "Invalid terminal message.")
	}
	if id := r.PathValue("sessionId"); id != "" && id != m.SessionID {
		return v2.Message{}, terminalFault("stale_fence", "Session identity does not match the route.")
	}
	return m, nil
}
func (h *Routes) terminalRoute(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if r.Method == http.MethodHead {
		httpx.MethodNotAllowed(h.logger, "GET")(w, r)
		return
	}
	if r.PathValue("projectId") == "" {
		h.Failure(w, r, terminalFault("unsupported_protocol", "Terminal Sessions require a task."))
		return
	}
	project, task, id := r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId")
	path := r.URL.Path
	var result any
	var err error
	switch {
	case strings.HasSuffix(path, "/worker-channel"):
		h.terminalWorkerChannel(w, r, p)
		return
	case strings.HasSuffix(path, "/channel"):
		h.terminalBrowserChannel(w, r, p)
		return
	case r.Method == http.MethodGet:
		switch {
		case strings.HasSuffix(path, "/sessions"):
			values, e := httpx.QueryValues(r, "cursor", "limit")
			if e != nil {
				err = e
				break
			}
			limit := 50
			if values.Get("limit") != "" {
				limit, err = strconv.Atoi(values.Get("limit"))
				if err != nil {
					err = httpx.InvalidInput("Invalid history limit.")
					break
				}
			}
			result, err = h.service.TerminalHistory(r.Context(), p, project, task, values.Get("cursor"), limit)
		case strings.HasSuffix(path, "/current"):
			if _, err = httpx.QueryValues(r); err == nil {
				result, err = h.service.CurrentTerminal(r.Context(), p, project, task)
			}
		case r.PathValue("operationId") != "":
			if _, err = httpx.QueryValues(r); err == nil {
				result, err = h.service.TerminalOperation(r.Context(), p, project, task, id, r.PathValue("operationId"))
			}
		case r.PathValue("recoveryId") != "":
			if _, err = httpx.QueryValues(r); err == nil {
				result, err = h.service.TerminalAutomationRecovery(r.Context(), p, project, task, id, r.PathValue("recoveryId"))
			}
		case r.PathValue("evidenceId") != "":
			values, e := httpx.QueryValues(r, "generation")
			if e != nil {
				err = e
				break
			}
			result, err = h.service.TerminalRecordingEvidence(r.Context(), p, project, task, id, values.Get("generation"), r.PathValue("evidenceId"))
		case strings.HasSuffix(path, "/archive/content"):
			if _, err = httpx.QueryValues(r); err != nil {
				break
			}
			content, contentErr := h.service.TerminalArchiveContent(r.Context(), p, project, task, id)
			if contentErr != nil {
				err = contentErr
				break
			}
			// The immutable receipt hashes these exact bytes, including JSON whitespace.
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			if _, writeErr := w.Write(content); writeErr != nil {
				httpx.LogFailure(h.logger, r.Context(), "session", "response", writeErr)
			}
			return
		case strings.HasSuffix(path, "/archive/receipt"):
			if _, err = httpx.QueryValues(r); err == nil {
				result, err = h.service.TerminalReceipt(r.Context(), p, project, task, id)
			}
		case strings.HasSuffix(path, "/archive/state"):
			if _, err = httpx.QueryValues(r); err == nil {
				result, err = h.service.TerminalArchiveState(r.Context(), p, project, task, id)
			}
		case strings.HasSuffix(path, "/archive"):
			if _, err = httpx.QueryValues(r); err == nil {
				result, err = h.service.TerminalArchiveStatus(r.Context(), p, project, task, id)
			}
		case r.Pattern == "GET "+sessionBase+"/{sessionId}/state":
			if _, err = httpx.QueryValues(r); err == nil {
				result, err = h.service.TerminalState(r.Context(), p, project, task, id)
			}
		default:
			err = terminalFault("unsupported_content_kind", "This endpoint does not serve terminal content.")
		}
	case r.Method == http.MethodPut && strings.HasSuffix(path, "/archive"):
		var body []byte
		body, err = archiveBody(w, r)
		if err == nil {
			result, err = h.service.PutTerminalArchive(r.Context(), p, project, task, id, body)
		}
	case r.Method == http.MethodPost:
		var m v2.Message
		m, err = terminalBody(w, r)
		if err != nil {
			break
		}
		switch {
		case strings.HasSuffix(path, "/sessions"):
			result, err = h.service.RegisterTerminal(r.Context(), p, project, task, m)
		case strings.HasSuffix(path, "/commands"):
			browserID := r.Header.Get("Daynight-Browser-Client")
			if len(r.Header.Values("Daynight-Browser-Client")) != 1 {
				err = httpx.InvalidInput("A browser client identity is required.")
				break
			}
			if _, err = model.CanonicalID(browserID); err != nil {
				break
			}
			result, err = h.service.SubmitTerminal(r.Context(), p, project, task, id, browserID, m)
		case strings.HasSuffix(path, "/archive"):
			result, err = h.service.UpdateTerminalArchive(r.Context(), p, project, task, id, m)
		case strings.HasSuffix(path, "/worker-messages"):
			var epoch string
			epoch, err = terminalEpoch(r)
			if err == nil {
				result, err = h.terminalWorkerMessage(r.Context(), p, project, task, id, epoch, m)
			}
		default:
			err = terminalFault("unsupported_content_kind", "This endpoint does not accept terminal operations.")
		}
	default:
		err = terminalFault("unsupported_content_kind", "Unsupported terminal endpoint.")
	}
	status := http.StatusOK
	if r.Method == http.MethodPost && strings.HasSuffix(path, "/commands") {
		status = http.StatusAccepted
	}
	h.Result(w, r, status, result, err)
}
func (h *Routes) terminalWorkerMessage(ctx context.Context, p model.Principal, project, task, id, epoch string, m v2.Message) (v2.Message, error) {
	switch m.Type {
	case "automation_recovery_prepare", "automation_recovery":
		return h.service.UpdateTerminalRecovery(ctx, p, project, task, id, epoch, m)
	case "generation_ledger":
		return h.service.UpdateTerminalLedger(ctx, p, project, task, id, epoch, m)
	case "finalization":
		return h.service.FinalizeTerminal(ctx, p, project, task, id, epoch, m)
	case "recording_responsibility", "recording_evidence":
		return h.service.UpdateTerminalRecording(ctx, p, project, task, id, epoch, m)
	default:
		return h.service.HandleTerminalControl(ctx, p, project, task, id, epoch, m)
	}
}
func terminalChannelProtocol(r *http.Request) error {
	for _, p := range sessionSubprotocols(r) {
		if p == v2.Protocol {
			return nil
		}
	}
	return terminalFault("unsupported_protocol", "Terminal channels require the daynight.session.v2 WebSocket subprotocol.")
}
func readTerminal(ctx context.Context, c *websocket.Conn) (v2.Message, error) {
	read, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	kind, raw, err := c.Read(read)
	if err != nil {
		return v2.Message{}, err
	}
	if kind != websocket.MessageText {
		return v2.Message{}, errors.New("terminal messages must be text")
	}
	return v2.DecodeMessage(raw)
}
func (h *Routes) terminalWorkerChannel(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if p.Kind != model.PATCredential {
		h.Failure(w, r, terminalFault("permission_denied", "Worker channels require the original owner's credential."))
		return
	}
	if _, err := httpx.QueryValues(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	if err := terminalChannelProtocol(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	if err := h.origin(r, false); err != nil {
		h.Failure(w, r, err)
		return
	}
	conn, ctx, cleanup, err := h.accept(w, r)
	if err != nil {
		return
	}
	defer cleanup()
	conn.SetReadLimit(4 * 1024 * 1024)
	first, err := readTerminal(ctx, conn)
	project, task, id := r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId")
	if err != nil || first.Type != "registration" || first.SessionID != id {
		return
	}
	ack, err := h.service.RegisterTerminal(ctx, p, project, task, first)
	if err != nil {
		return
	}
	epoch := ack.Payload.(v2.RegistrationAck).ConnectionEpoch
	channelFence := first.Envelope
	if err = h.service.BindTerminalConnection(ctx, p, project, task, id, first.Envelope, epoch); err != nil {
		return
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), relayWriteTimeout)
		defer cancel()
		_ = h.service.DisconnectTerminal(ctx, p, project, task, id, channelFence, epoch)
	}()
	if err = relayWrite(ctx, conn, ack); err != nil {
		return
	}
	type incoming struct {
		m   v2.Message
		err error
	}
	input := make(chan incoming, 1)
	done := make(chan struct{})
	readCtx, cancel := context.WithCancel(ctx)
	go func() {
		defer close(done)
		for {
			m, e := readTerminal(readCtx, conn)
			select {
			case input <- incoming{m, e}:
			case <-readCtx.Done():
				return
			}
			if e != nil {
				return
			}
		}
	}()
	defer func() { cancel(); _ = conn.CloseNow(); <-done }()
	tick := time.NewTicker(sessioncore.PollInterval)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case in := <-input:
			if in.err != nil || in.m.SessionID != id || in.m.ClaimID != first.ClaimID || in.m.Type != "generation_ledger" && in.m.ExecutionGeneration != channelFence.ExecutionGeneration {
				return
			}
			result, e := h.terminalWorkerMessage(ctx, p, project, task, id, epoch, in.m)
			if e != nil {
				return
			}
			if in.m.Type == "generation_ledger" {
				// Only the transactional ledger grant can advance the channel fence.
				channelFence = result.Envelope
			}
			if e = relayWrite(ctx, conn, result); e != nil {
				return
			}
		case <-tick.C:
			offers, e := h.service.PollTerminal(ctx, p, project, task, id, channelFence, epoch)
			if e != nil {
				return
			}
			for _, offer := range offers {
				if e = relayWrite(ctx, conn, offer); e != nil {
					return
				}
			}
		}
	}
}
func (h *Routes) terminalBrowserChannel(w http.ResponseWriter, r *http.Request, p model.Principal) {
	if _, err := httpx.QueryValues(r, "browserClientId"); err != nil {
		h.Failure(w, r, err)
		return
	}
	if err := terminalChannelProtocol(r); err != nil {
		h.Failure(w, r, err)
		return
	}
	if err := h.origin(r, p.Kind == model.SessionCredential); err != nil {
		h.Failure(w, r, err)
		return
	}
	browserID := r.URL.Query().Get("browserClientId")
	if _, err := model.CanonicalID(browserID); err != nil {
		h.Failure(w, r, err)
		return
	}
	project, task, id := r.PathValue("projectId"), r.PathValue("taskId"), r.PathValue("sessionId")
	state, err := h.service.TerminalState(r.Context(), p, project, task, id)
	if err != nil {
		h.channelAdmissionFailure(w, r, err)
		return
	}
	claimID := state["claimId"].(string)
	connectionEpoch := state["connectionEpoch"].(string)
	conn, ctx, cleanup, err := h.accept(w, r)
	if err != nil {
		return
	}
	defer cleanup()
	key := id + ":" + p.UserID + ":" + browserID
	h.mutex.Lock()
	if h.terminalViewers == nil {
		h.terminalViewers = make(map[string]*websocket.Conn)
	}
	if h.terminalViewers[key] != nil {
		h.mutex.Unlock()
		return
	}
	h.terminalViewers[key] = conn
	h.mutex.Unlock()
	// Keep the identity reserved until release commits. A replacement socket may
	// connect after cleanup, but cannot have its lease revoked by this callback.
	defer func() {
		release, cancel := context.WithTimeout(context.Background(), relayWriteTimeout)
		defer cancel()
		_ = h.service.DisconnectTerminalViewer(release, p, project, task, id, browserID, claimID, connectionEpoch)
		h.mutex.Lock()
		if h.terminalViewers[key] == conn {
			delete(h.terminalViewers, key)
		}
		h.mutex.Unlock()
	}()

	closed := conn.CloseRead(ctx)
	if err = relayWrite(ctx, conn, state); err != nil {
		return
	}
	tick := time.NewTicker(sessioncore.PollInterval)
	defer tick.Stop()
	for {
		select {
		case <-closed.Done():
			return
		case <-tick.C:
			next, e := h.service.TerminalState(ctx, p, project, task, id)
			if e != nil {
				return
			}
			if next["claimId"] != claimID || next["connectionEpoch"] != connectionEpoch {
				return
			}
			if !reflect.DeepEqual(next, state) {
				if e = relayWrite(ctx, conn, next); e != nil {
					return
				}
				state = next
			}
		}
	}
}
