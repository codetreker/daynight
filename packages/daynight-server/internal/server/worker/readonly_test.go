package worker

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	workerservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
	"github.com/google/uuid"
)

type readOnlyFixture struct {
	server  *httptest.Server
	token   string
	cookie  *http.Cookie
	worker  string
	owner   model.Principal
	harness *testsupport.AuthHarness[*authhttp.Authentication]
	routes  *ReadOnlyRoutes
}

func newReadOnlyFixture(t *testing.T, configure ...func(*ReadOnlyRoutes)) *readOnlyFixture {
	t.Helper()
	h := testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
		return authhttp.NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	})
	cookie := h.Login(t, "readonly-owner")
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(cookie)
	owner, err := h.Auth.AuthenticateRequest(r)
	if err != nil {
		t.Fatal(err)
	}
	pat, err := h.Identity.CreatePAT(context.Background(), owner, identitycore.CreatePAT{Name: "Worker read-only fixture"})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, workerservice.NewWorkers(h.Database), h.Auth, slog.Default())
	broker := workerservice.NewReadOnly(h.Database)
	routes := NewReadOnlyRoutes(broker, h.Auth, slog.Default())
	for _, configureRoute := range configure {
		configureRoute(routes)
	}
	routes.RegisterRoutes(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := routes.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	f := &readOnlyFixture{server: server, token: pat.Secret, cookie: cookie, worker: uuid.NewString(), owner: owner, harness: h, routes: routes}
	f.report(t, f.worker, f.token)
	return f
}
func (f *readOnlyFixture) report(t *testing.T, worker, token string) {
	t.Helper()
	raw, _ := json.Marshal(workerSnapshotReportBody())
	r, _ := http.NewRequest("POST", f.server.URL+"/api/v1/me/workers/"+worker+"/report", strings.NewReader(string(raw)))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+token)
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("report: %d", response.StatusCode)
	}
}
func (f *readOnlyFixture) connect(t *testing.T, worker, token string, operations ...string) (*websocket.Conn, ro.Message) {
	return f.connectWithPing(t, worker, token, nil, operations...)
}
func (f *readOnlyFixture) connectWithPing(t *testing.T, worker, token string, onPing func(context.Context, []byte) bool, operations ...string) (*websocket.Conn, ro.Message) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, strings.Replace(f.server.URL, "http:", "ws:", 1)+"/api/v1/me/workers/"+worker+"/readonly/channel", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + token}}, OnPingReceived: onPing})
	if err != nil {
		t.Fatal(err)
	}
	if response.Header.Get("Daynight-User-ID") == "" {
		t.Fatal("missing authenticated owner")
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	if len(operations) == 0 {
		operations = []string{"directory.list"}
	}
	hello, _ := json.Marshal(ro.Hello{Type: "hello", Protocol: ro.Protocol, CapabilityGeneration: uuid.NewString(), Operations: operations})
	if err = conn.Write(ctx, websocket.MessageText, hello); err != nil {
		t.Fatal(err)
	}
	return conn, readOnlyRead(t, conn)
}
func readOnlyRead(t *testing.T, c *websocket.Conn) ro.Message {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, raw, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var m ro.Message
	if err = ro.Decode(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}
func readOnlySend(t *testing.T, c *websocket.Conn, m ro.Message) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := readOnlyWrite(ctx, c, m); err != nil {
		t.Fatal(err)
	}
}
func (f *readOnlyFixture) request(ctx context.Context, worker, token string, input ro.Request) (*http.Response, error) {
	raw, _ := json.Marshal(input)
	r, _ := http.NewRequestWithContext(ctx, "POST", f.server.URL+"/api/v1/me/workers/"+worker+"/readonly/requests", strings.NewReader(string(raw)))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+token)
	return http.DefaultClient.Do(r)
}
func TestReadOnlyHTTPRoutesTargetAndCancellation(t *testing.T) {
	f := newReadOnlyFixture(t)
	c, ready := f.connect(t, f.worker, f.token)
	if ready.Type != "ready" || ready.OwnerUserID != f.owner.UserID || ready.WorkerID != f.worker {
		t.Fatal("ready identity mismatch")
	}
	request := ro.Request{RequestID: uuid.NewString(), Operation: "directory.list", Input: json.RawMessage(`{}`)}
	type response struct {
		r *http.Response
		e error
	}
	answers := make(chan response, 1)
	go func() { r, e := f.request(context.Background(), f.worker, f.token, request); answers <- response{r, e} }()
	m := readOnlyRead(t, c)
	if m.Type != "request" || m.RequestID != request.RequestID || m.Fence != ready.Fence {
		t.Fatalf("wrong request: %+v", m)
	}
	readOnlySend(t, c, ro.Message{Fence: m.Fence, Type: "result", RequestID: m.RequestID, Result: json.RawMessage(`{"path":"/target","parentPath":"/","entries":[],"nextCursor":null}`)})
	answer := <-answers
	if answer.e != nil {
		t.Fatal(answer.e)
	}
	defer answer.r.Body.Close()
	var got ro.Message
	if err := json.NewDecoder(answer.r.Body).Decode(&got); err != nil || answer.r.StatusCode != 200 || got.RequestID != request.RequestID {
		t.Fatalf("response %d %+v %v", answer.r.StatusCode, got, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	request.RequestID = uuid.NewString()
	go func() { r, e := f.request(ctx, f.worker, f.token, request); answers <- response{r, e} }()
	pending := readOnlyRead(t, c)
	cancel()
	cancelled := readOnlyRead(t, c)
	if cancelled.Type != "cancel" || cancelled.RequestID != pending.RequestID {
		t.Fatal("missing cancellation")
	}
	if answer = <-answers; answer.e == nil {
		answer.r.Body.Close()
		t.Fatal("cancelled HTTP request succeeded")
	}
	// Late results are discarded without affecting this connection's next request.
	readOnlySend(t, c, ro.Message{Fence: pending.Fence, Type: "result", RequestID: pending.RequestID, Error: &ro.Error{Code: "cancelled", Message: "cancelled"}})
	request.RequestID = uuid.NewString()
	go func() { r, e := f.request(context.Background(), f.worker, f.token, request); answers <- response{r, e} }()
	next := readOnlyRead(t, c)
	readOnlySend(t, c, ro.Message{Fence: next.Fence, Type: "result", RequestID: next.RequestID, Error: &ro.Error{Code: "not_found", Message: "Directory was not found."}})
	answer = <-answers
	if answer.e != nil {
		t.Fatal(answer.e)
	}
	answer.r.Body.Close()
	if answer.r.StatusCode != 200 {
		t.Fatal(answer.r.StatusCode)
	}
}
func TestReadOnlyHTTPRefusesUnsupportedAndUnauthorisedTargets(t *testing.T) {
	f := newReadOnlyFixture(t)
	input := ro.Request{RequestID: uuid.NewString(), Operation: "directory.list", Input: json.RawMessage(`{}`)}
	response, err := f.request(context.Background(), f.worker, f.token, input)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(response.Body)
	response.Body.Close()
	var failure api.ErrorResponse
	_ = json.Unmarshal(raw, &failure)
	if response.StatusCode != 501 || failure.Error.Code != "unsupported" {
		t.Fatalf("legacy worker: %d %s", response.StatusCode, raw)
	}
	other := f.harness.Login(t, "readonly-other")
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(other)
	p, err := f.harness.Auth.AuthenticateRequest(r)
	if err != nil {
		t.Fatal(err)
	}
	token, err := f.harness.Identity.CreatePAT(context.Background(), p, identitycore.CreatePAT{Name: "other"})
	if err != nil {
		t.Fatal(err)
	}
	response, err = f.request(context.Background(), f.worker, token.Secret, input)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 404 {
		t.Fatal("cross-owner target allowed", response.StatusCode)
	}
}

func TestReadOnlyHTTPBodyReadHasDeadline(t *testing.T) {
	f := newReadOnlyFixture(t)
	f.routes.bodyTimeout = 50 * time.Millisecond
	conn, err := net.Dial("tcp", strings.TrimPrefix(f.server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err = conn.SetDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	_, err = fmt.Fprintf(conn, "POST /api/v1/me/workers/%s/readonly/requests HTTP/1.1\r\nHost: fixture\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{", f.worker, f.token)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal("stalled body was not terminated", err)
	}
	defer response.Body.Close()
	if response.StatusCode != 408 || !response.Close {
		t.Fatal("stalled body status", response.StatusCode)
	}
}

func TestReadOnlyHTTPEarlyRefusalsBoundUnreadBodies(t *testing.T) {
	for _, mode := range []string{"invalid_query", "capacity"} {
		t.Run(mode, func(t *testing.T) {
			f := newReadOnlyFixture(t)
			f.routes.bodyTimeout = 50 * time.Millisecond
			suffix := "?invalid=true"
			want := 400
			if mode == "capacity" {
				suffix = ""
				want = 429
				f.routes.mu.Lock()
				f.routes.requests = 1024
				f.routes.mu.Unlock()
				defer func() { f.routes.mu.Lock(); f.routes.requests = 0; f.routes.mu.Unlock() }()
			}
			conn, err := net.Dial("tcp", strings.TrimPrefix(f.server.URL, "http://"))
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
			_, err = fmt.Fprintf(conn, "POST /api/v1/me/workers/%s/readonly/requests%s HTTP/1.1\r\nHost: fixture\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{", f.worker, suffix, f.token)
			if err != nil {
				t.Fatal(err)
			}
			response, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatal("early refusal retained unread body", err)
			}
			defer response.Body.Close()
			if response.StatusCode != want {
				t.Fatal("refusal status", response.StatusCode)
			}
		})
	}
}

func TestReadOnlyChannelRefusalsBoundUnreadBodies(t *testing.T) {
	f := newReadOnlyFixture(t)
	for _, test := range []struct {
		name, suffix   string
		capacity, body bool
		status         int
	}{
		{"invalid_query", "?invalid=true", false, true, 400},
		{"body", "", false, true, 400},
		{"capacity_with_body", "", true, true, 400},
		{"capacity", "", true, false, 429},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.capacity {
				f.routes.mu.Lock()
				f.routes.reserved = 1024
				f.routes.mu.Unlock()
				defer func() { f.routes.mu.Lock(); f.routes.reserved = 0; f.routes.mu.Unlock() }()
			}
			conn, err := net.Dial("tcp", strings.TrimPrefix(f.server.URL, "http://"))
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
			body := ""
			if test.body {
				body = "Content-Length: 100\r\n"
			}
			_, err = fmt.Fprintf(conn, "GET /api/v1/me/workers/%s/readonly/channel%s HTTP/1.1\r\nHost: fixture\r\nAuthorization: Bearer %s\r\n%s\r\n{", f.worker, test.suffix, f.token, body)
			if err != nil {
				t.Fatal(err)
			}
			response, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatal("channel refusal retained unread body", err)
			}
			defer response.Body.Close()
			if response.StatusCode != test.status || !response.Close {
				t.Fatalf("channel refusal status=%d close=%v", response.StatusCode, response.Close)
			}
		})
	}
}

func TestReadOnlyChannelRejectsInvalidHandshakeAndFrames(t *testing.T) {
	f := newReadOnlyFixture(t)
	for _, mode := range []string{"binary_hello", "malformed_hello", "unsupported_hello", "unknown_worker", "malformed_result", "wrong_fence"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			worker := f.worker
			if mode == "unknown_worker" {
				worker = uuid.NewString()
			}
			c, _, err := websocket.Dial(ctx, strings.Replace(f.server.URL, "http:", "ws:", 1)+"/api/v1/me/workers/"+worker+"/readonly/channel", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": {"Bearer " + f.token}}})
			if err != nil {
				t.Fatal(err)
			}
			defer c.CloseNow()
			hello := ro.Hello{Type: "hello", Protocol: ro.Protocol, CapabilityGeneration: uuid.NewString(), Operations: []string{"directory.list"}}
			if mode == "unsupported_hello" {
				hello.Protocol = "unsupported"
			}
			raw, _ := json.Marshal(hello)
			kind := websocket.MessageText
			if mode == "binary_hello" {
				kind = websocket.MessageBinary
			}
			if mode == "malformed_hello" {
				raw = []byte(`{"unexpected":true}`)
			}
			if err = c.Write(ctx, kind, raw); err != nil {
				t.Fatal(err)
			}
			if mode == "malformed_result" || mode == "wrong_fence" {
				ready := readOnlyRead(t, c)
				frame := []byte(`{"unexpected":true}`)
				if mode == "wrong_fence" {
					ready.ConnectionID = uuid.NewString()
					frame, _ = json.Marshal(ro.Message{Fence: ready.Fence, Type: "result", RequestID: uuid.NewString(), Error: &ro.Error{Code: "not_found", Message: "not found"}})
				}
				if err = c.Write(ctx, websocket.MessageText, frame); err != nil {
					t.Fatal(err)
				}
			}
			if _, _, err = c.Read(ctx); err == nil {
				t.Fatal("invalid channel remained usable")
			}
		})
	}
	// A cookie can invoke reads but cannot stand in for a Worker channel.
	r, _ := http.NewRequest("GET", f.server.URL+"/api/v1/me/workers/"+f.worker+"/readonly/channel", nil)
	r.AddCookie(f.cookie)
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("cookie channel accepted", response.StatusCode)
	}
}
func TestReadOnlyChannelHeartbeatAndShutdownCancelReader(t *testing.T) {
	f := newReadOnlyFixture(t, func(routes *ReadOnlyRoutes) { routes.heartbeatInterval = 100 * time.Millisecond })
	pings := make(chan struct{}, 2)
	c, _ := f.connectWithPing(t, f.worker, f.token, func(context.Context, []byte) bool {
		select {
		case pings <- struct{}{}:
		default:
		}
		return true
	})
	closed := make(chan error, 1)
	go func() { _, _, err := c.Read(context.Background()); closed <- err }()
	// The next ping proves the server received the pong to the preceding ping.
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for i := 0; i < 2; i++ {
		select {
		case err := <-closed:
			t.Fatal("healthy channel closed", err)
		case <-pings:
		case <-deadline.C:
			t.Fatal("heartbeat did not complete")
		}
	}
	f.routes.BeginShutdown()
	select {
	case err := <-closed:
		if err == nil {
			t.Fatal("shutdown yielded data")
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown retained channel")
	}
}

func TestReadOnlyRouteTimingDefaults(t *testing.T) {
	routes := NewReadOnlyRoutes(nil, nil, slog.Default())
	if routes.heartbeatInterval != 5*time.Second || routes.operationTimeout("directory.list") != ro.RequestTimeout || routes.operationTimeout("model.list") != ro.ModelRequestTimeout {
		t.Fatal("read-only route timing defaults changed")
	}
}

func TestReadOnlyConfiguredOperationDeadlineIncludesBodyReading(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var observed time.Time
		broker := ro.New(func(ctx context.Context, _ model.Principal, _ string) error {
			observed, _ = ctx.Deadline()
			return &model.Fault{Code: "permission_denied", Message: "Denied"}
		})
		defer broker.Close()
		routes := NewReadOnlyRoutes(broker, nil, slog.Default())
		routes.operationTimeout = func(string) time.Duration { return 3 * time.Second }
		raw, _ := json.Marshal(ro.Request{RequestID: uuid.NewString(), Operation: "directory.list", Input: json.RawMessage(`{}`)})
		request := httptest.NewRequest("POST", "/", &delayedModelBody{Reader: strings.NewReader(string(raw))})
		request.SetPathValue("workerId", uuid.NewString())
		writer := &deadlineResponseRecorder{ResponseRecorder: httptest.NewRecorder()}
		started := time.Now()
		routes.request(writer, request, model.Principal{UserID: uuid.NewString(), CredentialID: uuid.NewString(), Kind: model.PATCredential})
		if !observed.Equal(started.Add(3 * time.Second)) {
			t.Fatalf("operation deadline %s, want %s after body reading", observed, started.Add(3*time.Second))
		}
		if len(writer.writes) != 2 || !writer.writes[1].Equal(started.Add(8*time.Second)) {
			t.Fatalf("write deadlines: %v", writer.writes)
		}
	})
}

func TestReadOnlyShutdownDeadlineIsObservable(t *testing.T) {
	b := ro.New(func(context.Context, model.Principal, string) error { return nil })
	h := NewReadOnlyRoutes(b, nil, slog.Default())
	h.active.Add(1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := h.Shutdown(ctx); err != context.Canceled {
		t.Fatal("shutdown deadline hidden", err)
	}
	h.active.Done()
	if err := h.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}
func TestReadOnlyHTTPErrorStatusesRemainDistinct(t *testing.T) {
	h := NewReadOnlyRoutes(nil, nil, slog.Default())
	for _, item := range []struct {
		code   string
		status int
	}{{"offline", 503}, {"unsupported", 501}, {"busy", 429}, {"timeout", 504}, {"cancelled", 409}, {"invalid_input", 400}} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest("POST", "/", nil)
		h.failure(w, r, &model.Fault{Code: item.code, Message: "read-only request unavailable"})
		if w.Code != item.status {
			t.Fatalf("%s status %d", item.code, w.Code)
		}
	}
}

func TestReadOnlyHTTPForwardingDeadlineReturnsTimeoutJSON(t *testing.T) {
	const operationTimeout = 500 * time.Millisecond
	f := newReadOnlyFixture(t, func(routes *ReadOnlyRoutes) {
		routes.operationTimeout = func(string) time.Duration { return operationTimeout }
	})
	c, ready := f.connect(t, f.worker, f.token)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type answer struct {
		response *http.Response
		err      error
	}
	answers := make(chan answer, 1)
	started := time.Now()
	requestID := uuid.NewString()
	go func() {
		response, err := f.request(ctx, f.worker, f.token, ro.Request{RequestID: requestID, Operation: "directory.list", Input: json.RawMessage(`{}`)})
		answers <- answer{response, err}
	}()
	request := readOnlyRead(t, c)
	if request.Type != "request" || request.RequestID != requestID || request.Fence != ready.Fence {
		t.Fatalf("wrong request: %+v", request)
	}
	// A real reader answers the channel's heartbeats while this Worker withholds its result.
	cancellation := make(chan ro.Message, 1)
	readErrors := make(chan error, 1)
	go func() {
		_, raw, err := c.Read(ctx)
		if err != nil {
			readErrors <- err
			return
		}
		var m ro.Message
		if err = ro.Decode(raw, &m); err != nil {
			readErrors <- err
			return
		}
		cancellation <- m
	}()
	var result answer
	select {
	case result = <-answers:
	case <-ctx.Done():
		t.Fatal("forwarding response exceeded its deadline")
	}
	if result.err != nil {
		t.Fatal(result.err)
	}
	raw, err := io.ReadAll(result.response.Body)
	result.response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	var failure api.ErrorResponse
	if err = json.Unmarshal(raw, &failure); err != nil || result.response.StatusCode != 504 || failure.Error.Code != "timeout" {
		t.Fatalf("forwarding timeout after %s: status=%d body=%q decode=%v", time.Since(started), result.response.StatusCode, raw, err)
	}
	if time.Since(started) < operationTimeout-100*time.Millisecond {
		t.Fatal("body deadline interrupted the forwarding window")
	}
	select {
	case m := <-cancellation:
		if m.Type != "cancel" || m.RequestID != request.RequestID || m.Fence != request.Fence {
			t.Fatal("timeout cancelled another request")
		}
	case err := <-readErrors:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal("timed-out request was not cancelled")
	}
}
