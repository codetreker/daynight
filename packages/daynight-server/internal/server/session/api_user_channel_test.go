package session

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

const apiChannelOrigin = "https://application.example"
const nativeChannelOrigin = "https://daynight.example"

type apiChannelLogs struct {
	mu sync.Mutex
	bytes.Buffer
}

func (b *apiChannelLogs) Write(value []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Buffer.Write(value)
}

func (b *apiChannelLogs) text() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.Buffer.String()
}

type apiChannelFixture struct {
	t                               *testing.T
	routes                          *Routes
	server                          *httptest.Server
	auth                            *authhttp.RequestAuthentication
	identity                        store.OAuthAccessIdentity
	snapshot                        sp.Snapshot
	state                           map[string]any
	token                           string
	native                          model.Principal
	nativeCalls                     atomic.Int32
	apiCalls                        atomic.Int32
	polls                           atomic.Int32
	logs                            apiChannelLogs
	project, task, session, browser string
	onPoll                          func(context.Context, model.Principal, int32) error
	onDisconnect                    func(context.Context, model.Principal, string, string, string)
}

func newAPIChannelFixture(t *testing.T, expires time.Time) *apiChannelFixture {
	t.Helper()
	f := &apiChannelFixture{t: t, token: secret.Random("dnapi_"), project: uuid.NewString(), task: uuid.NewString(), session: uuid.NewString(), browser: uuid.NewString()}
	f.identity = store.OAuthAccessIdentity{Principal: model.Principal{Kind: model.OAuthCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}, GrantID: uuid.NewString(), ExpiresAt: expires}
	f.native = model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	f.snapshot = sp.Snapshot{Protocol: sp.Protocol, ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: f.session, ClaimID: uuid.NewString(), ExecutionGeneration: "1"}, ConnectionEpoch: "2"}, HistoryEpoch: uuid.NewString()}
	f.state = map[string]any{"type": "state", "protocol": v2.Protocol, "claimId": f.snapshot.ClaimID, "connectionEpoch": f.snapshot.ConnectionEpoch}
	logger := slog.New(slog.NewJSONHandler(&f.logs, nil))
	var err error
	f.auth, err = authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		f.nativeCalls.Add(1)
		if token != "native-secret" {
			return model.Principal{}, authhttp.Failure()
		}
		p := f.native
		p.Kind = kind
		return p, nil
	}, authconfig.AuthSettings{PublicOrigin: nativeChannelOrigin}, logger)
	if err != nil {
		t.Fatal(err)
	}
	f.auth.BindAPIAccess(func(_ context.Context, token string) (store.OAuthAccessIdentity, error) {
		f.apiCalls.Add(1)
		if token != f.token {
			return store.OAuthAccessIdentity{}, authhttp.Failure()
		}
		return f.identity, nil
	}, apiChannelOrigin)
	poll := func(ctx context.Context, p model.Principal) error {
		count := f.polls.Add(1)
		if f.onPoll != nil {
			return f.onPoll(ctx, p, count)
		}
		return nil
	}
	f.routes = newRoutes(serviceCalls{
		BrowserPoll: func(ctx context.Context, p model.Principal, project, task, session, after string) (sp.Snapshot, []map[string]any, string, error) {
			if session != f.session {
				t.Errorf("channel session = %q", session)
			}
			return f.snapshot, nil, "initial-cursor", poll(ctx, p)
		},
		TerminalState: func(ctx context.Context, p model.Principal, project, task, session string) (map[string]any, error) {
			if session != f.session {
				t.Errorf("terminal session = %q", session)
			}
			return f.state, poll(ctx, p)
		},
		DisconnectTerminalViewer: func(ctx context.Context, p model.Principal, project, task, session, browser, claim, epoch string) error {
			if f.onDisconnect != nil {
				f.onDisconnect(ctx, p, browser, claim, epoch)
			}
			return nil
		},
		AuthenticateController: func(context.Context, string) error { return authhttp.Failure() },
	}, f.auth, logger)
	mux := http.NewServeMux()
	f.routes.RegisterRoutes(mux)
	f.server = httptest.NewServer(httpx.RequestLogging(logger, mux))
	t.Cleanup(func() { f.shutdown(); f.server.Close() })
	return f
}

func (f *apiChannelFixture) path(protocol string, test bool) string {
	if test {
		return "/api/v1/test-sessions/" + f.session + "/channel"
	}
	path := "/api/v1/projects/" + f.project + "/tasks/" + f.task + "/sessions/" + f.session + "/channel"
	if protocol == v2.Protocol {
		path += "?browserClientId=" + f.browser
	}
	return path
}

func (f *apiChannelFixture) dial(path string, protocols []string, headers http.Header) (*websocket.Conn, *http.Response, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return websocket.Dial(ctx, strings.Replace(f.server.URL, "http://", "ws://", 1)+path, &websocket.DialOptions{Subprotocols: protocols, HTTPHeader: headers})
}

func (f *apiChannelFixture) shutdown() {
	f.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := f.routes.Shutdown(ctx); err != nil {
		f.t.Errorf("channel shutdown: %v", err)
	}
	f.routes.mutex.Lock()
	defer f.routes.mutex.Unlock()
	if f.routes.reserved != 0 || len(f.routes.connections) != 0 || len(f.routes.terminalViewers) != 0 {
		f.t.Errorf("channel resources remain: reserved=%d connections=%d viewers=%d", f.routes.reserved, len(f.routes.connections), len(f.routes.terminalViewers))
	}
}

func readAPIChannel(t *testing.T, conn *websocket.Conn) (map[string]any, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, raw, err := conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	var frame map[string]any
	if err := json.Unmarshal(raw, &frame); err != nil {
		t.Fatal(err)
	}
	return frame, nil
}

func TestAPIUserChannelSelectsRealProtocolAndPreservesIdentity(t *testing.T) {
	for _, c := range []struct {
		protocol string
		test     bool
	}{{sp.Protocol, false}, {v2.Protocol, false}, {sp.Protocol, true}} {
		t.Run(c.protocol+map[bool]string{true: "-test"}[c.test], func(t *testing.T) {
			f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
			seen := make(chan model.Principal, 1)
			f.onPoll = func(_ context.Context, p model.Principal, n int32) error {
				if n == 1 {
					seen <- p
				}
				return nil
			}
			conn, response, err := f.dial(f.path(c.protocol, c.test), []string{c.protocol, "daynight.authorization." + f.token}, http.Header{"Origin": {apiChannelOrigin}, "Cookie": {"__Host-daynight_session=bad-cookie"}})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.CloseNow()
			if response.Header.Get("Sec-WebSocket-Protocol") != c.protocol || conn.Subprotocol() != c.protocol || response.Header.Get("Daynight-User-ID") != f.identity.Principal.UserID {
				t.Fatal("upgrade changed selected protocol or user", response.Header)
			}
			if p := <-seen; p != f.identity.Principal {
				t.Fatalf("service principal = %+v", p)
			}
			frame, err := readAPIChannel(t, conn)
			if err != nil || frame["protocol"] != c.protocol {
				t.Fatal(frame, err)
			}
			if c.protocol == sp.Protocol && frame["userId"] != f.identity.Principal.UserID {
				t.Fatal("snapshot lost API user", frame)
			}
			if f.nativeCalls.Load() != 0 || f.apiCalls.Load() != 1 {
				t.Fatal("marker used native auth or repeated API auth")
			}
			conn.CloseNow()
			f.shutdown()
			if strings.Contains(f.logs.text(), f.token) || strings.Contains(f.logs.text(), "daynight.authorization") {
				t.Fatal("offered authorization leaked into logs")
			}
		})
	}
}

func TestAPIUserChannelRejectsAmbiguousOrMalformedCarriers(t *testing.T) {
	cases := []struct {
		name      string
		protocols func(string) []string
		header    http.Header
		test      bool
	}{
		{"missing actual protocol", func(s string) []string { return []string{"daynight.authorization." + s} }, nil, false},
		{"duplicate marker", func(s string) []string {
			return []string{sp.Protocol, "daynight.authorization." + s, "daynight.authorization." + s}
		}, nil, false},
		{"competing marker", func(s string) []string {
			return []string{sp.Protocol, "daynight.authorization." + s, "daynight.authorization." + secret.Random("dnapi_")}
		}, nil, false},
		{"competing actual protocol", func(s string) []string { return []string{sp.Protocol, v2.Protocol, "daynight.authorization." + s} }, nil, false},
		{"unknown protocol", func(s string) []string { return []string{"other.protocol", "daynight.authorization." + s} }, nil, false},
		{"empty marker", func(s string) []string { return []string{sp.Protocol, "daynight.authorization."} }, nil, false},
		{"malformed marker prefix", func(s string) []string { return []string{sp.Protocol, "daynight.authorization"} }, nil, false},
		{"malformed marker value", func(s string) []string { return []string{sp.Protocol, "daynight.authorization." + s + "/"} }, nil, false},
		{"authorization conflict", func(s string) []string { return []string{sp.Protocol, "daynight.authorization." + s} }, http.Header{"Authorization": {"Bearer native-secret"}}, false},
		{"selector conflict", func(s string) []string { return []string{sp.Protocol, "daynight.authorization." + s} }, http.Header{v2.ProtocolHeader: {v2.Protocol}}, false},
		{"test v2", func(s string) []string { return []string{v2.Protocol, "daynight.authorization." + s} }, nil, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
			headers := c.header.Clone()
			if headers == nil {
				headers = make(http.Header)
			}
			headers.Set("Origin", apiChannelOrigin)
			conn, response, err := f.dial(f.path(sp.Protocol, c.test), c.protocols(f.token), headers)
			if conn != nil {
				conn.CloseNow()
			}
			if err == nil || response == nil || response.StatusCode != http.StatusBadRequest {
				t.Fatalf("malformed carrier response=%v error=%v", response, err)
			}
			if f.apiCalls.Load() != 0 || f.nativeCalls.Load() != 0 || f.polls.Load() != 0 || f.routes.ActiveConnections() != 0 {
				t.Fatal("malformed carrier reached authentication or admission")
			}
			if strings.Contains(f.logs.text(), f.token) {
				t.Fatal("malformed carrier leaked token")
			}
		})
	}
}

func TestAPIUserChannelInvalidCredentialNeverFallsBackToCookie(t *testing.T) {
	for _, token := range []string{"dnapi_invalid", secret.Random("dnapi_"), secret.Random(model.OAuthAccessPrefix), secret.Random("dnapi_refresh_")} {
		t.Run(strings.Split(token, "_")[0], func(t *testing.T) {
			f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
			conn, response, err := f.dial(f.path(sp.Protocol, false), []string{sp.Protocol, "daynight.authorization." + token}, http.Header{"Origin": {apiChannelOrigin}, "Cookie": {"__Host-daynight_session=native-secret"}})
			if conn != nil {
				conn.CloseNow()
			}
			if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
				t.Fatal(response, err)
			}
			if f.nativeCalls.Load() != 0 || f.apiCalls.Load() != 1 || f.polls.Load() != 0 {
				t.Fatal("invalid marker fell back or reached service")
			}
		})
	}
}

func TestAPIUserChannelRequiresConfiguredExactApplicationOrigin(t *testing.T) {
	for _, origins := range [][]string{nil, {nativeChannelOrigin}, {apiChannelOrigin + "/"}, {apiChannelOrigin, apiChannelOrigin}, {"null"}} {
		t.Run(strings.Join(origins, ","), func(t *testing.T) {
			f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
			conn, response, err := f.dial(f.path(sp.Protocol, false), []string{sp.Protocol, "daynight.authorization." + f.token}, http.Header{"Origin": origins})
			if conn != nil {
				conn.CloseNow()
			}
			if err == nil || response == nil || response.StatusCode != http.StatusForbidden || f.polls.Load() != 0 {
				t.Fatal(response, err)
			}
		})
	}
	t.Run("unconfigured", func(t *testing.T) {
		f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
		f.auth.BindAPIAccess(func(context.Context, string) (store.OAuthAccessIdentity, error) { return f.identity, nil }, "")
		_, response, err := f.dial(f.path(sp.Protocol, false), []string{sp.Protocol, "daynight.authorization." + f.token}, http.Header{"Origin": {apiChannelOrigin}})
		if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
			t.Fatal(response, err)
		}
	})
}

func TestAPIUserChannelPreservesNativeCookieAndPATSelection(t *testing.T) {
	for _, cookie := range []bool{false, true} {
		t.Run(map[bool]string{false: "PAT", true: "cookie"}[cookie], func(t *testing.T) {
			f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
			headers := http.Header{"Authorization": {"Bearer native-secret"}}
			if cookie {
				headers = http.Header{"Cookie": {"__Host-daynight_session=native-secret"}, "Origin": {nativeChannelOrigin}}
			}
			seen := make(chan model.Principal, 1)
			f.onPoll = func(_ context.Context, p model.Principal, n int32) error {
				if n == 1 {
					seen <- p
				}
				return nil
			}
			conn, response, err := f.dial(f.path(sp.Protocol, false), nil, headers)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.CloseNow()
			if conn.Subprotocol() != "" || response.Header.Get("Sec-WebSocket-Protocol") != "" {
				t.Fatal("native empty offer changed")
			}
			p := <-seen
			kind := model.PATCredential
			if cookie {
				kind = model.SessionCredential
			}
			if p.UserID != f.native.UserID || p.Kind != kind || f.apiCalls.Load() != 0 {
				t.Fatal(p)
			}
			if _, err := readAPIChannel(t, conn); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestAPIUserChannelRejectsBearerWithoutAuthorizationMarker(t *testing.T) {
	for _, c := range []struct {
		name, protocol string
		test           bool
	}{
		{name: "task v1", protocol: sp.Protocol},
		{name: "task v2", protocol: v2.Protocol},
		{name: "test v1", protocol: sp.Protocol, test: true},
	} {
		t.Run(c.name, func(t *testing.T) {
			for _, origin := range []string{"", nativeChannelOrigin, apiChannelOrigin} {
				t.Run(origin, func(t *testing.T) {
					f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
					headers := http.Header{"Authorization": {"Bearer " + f.token}, "Cookie": {"__Host-daynight_session=native-secret"}}
					if origin != "" {
						headers.Set("Origin", origin)
					}
					conn, response, err := f.dial(f.path(c.protocol, c.test), []string{c.protocol}, headers)
					if conn != nil {
						conn.CloseNow()
					}
					if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized || f.apiCalls.Load() != 0 || f.nativeCalls.Load() != 0 || f.polls.Load() != 0 {
						t.Fatalf("non-marker API channel=%v response=%v API=%d native=%d polls=%d", err, response, f.apiCalls.Load(), f.nativeCalls.Load(), f.polls.Load())
					}
					if strings.Contains(f.logs.text(), f.token) {
						t.Fatal("non-marker API refusal logged its secret")
					}
				})
			}
		})
	}
}

func TestAPIUserChannelDeadlineCancelsAdmittedPollAndReleasesConnection(t *testing.T) {
	for _, protocol := range []string{sp.Protocol, v2.Protocol} {
		t.Run(protocol, func(t *testing.T) {
			deadline := time.Now().Add(time.Second)
			f := newAPIChannelFixture(t, deadline)
			started := make(chan context.Context, 1)
			stopped := make(chan error, 1)
			f.onPoll = func(ctx context.Context, p model.Principal, n int32) error {
				if p != f.identity.Principal {
					t.Error("deadline poll changed original principal")
				}
				if n == 1 {
					return nil
				}
				started <- ctx
				<-ctx.Done()
				stopped <- ctx.Err()
				return ctx.Err()
			}
			released := make(chan bool, 1)
			f.onDisconnect = func(ctx context.Context, p model.Principal, browser, claim, epoch string) {
				released <- ctx.Err() == nil && p == f.identity.Principal && browser == f.browser && claim == f.snapshot.ClaimID && epoch == f.snapshot.ConnectionEpoch
			}
			conn, _, err := f.dial(f.path(protocol, false), []string{protocol, "daynight.authorization." + f.token}, http.Header{"Origin": {apiChannelOrigin}})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.CloseNow()
			if _, err := readAPIChannel(t, conn); err != nil {
				t.Fatal(err)
			}
			var ctx context.Context
			select {
			case ctx = <-started:
			case <-time.After(3 * time.Second):
				t.Fatal("poll never entered")
			}
			got, ok := ctx.Deadline()
			if !ok || !got.Equal(deadline) {
				t.Fatalf("poll deadline=%v,%v want=%v", got, ok, deadline)
			}
			identity, ok := userAccess(ctx)
			if !ok || identity != f.identity {
				t.Fatal("connection lost actual grant identity", identity)
			}
			select {
			case err := <-stopped:
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatal(err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("expiry did not cancel admitted poll")
			}
			if _, err := readAPIChannel(t, conn); err == nil {
				t.Fatal("expired socket published another frame")
			}
			f.shutdown()
			if protocol == v2.Protocol {
				select {
				case ok := <-released:
					if !ok {
						t.Fatal("viewer cleanup changed original principal/fence or reused canceled context")
					}
				default:
					t.Fatal("viewer cleanup absent")
				}
			}
		})
	}
}

func TestAPIUserChannelPollRefusalClosesWithFixedPolicyReason(t *testing.T) {
	for _, protocol := range []string{sp.Protocol, v2.Protocol} {
		for _, code := range []string{"unauthenticated", "forbidden"} {
			t.Run(protocol+"-"+code, func(t *testing.T) {
				f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
				f.onPoll = func(_ context.Context, _ model.Principal, n int32) error {
					if n > 1 {
						return &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &model.Fault{Code: code, Message: "private-token-must-not-be-sent"}}
					}
					return nil
				}
				conn, _, err := f.dial(f.path(protocol, false), []string{protocol, "daynight.authorization." + f.token}, http.Header{"Origin": {apiChannelOrigin}})
				if err != nil {
					t.Fatal(err)
				}
				defer conn.CloseNow()
				if _, err := readAPIChannel(t, conn); err != nil {
					t.Fatal(err)
				}
				_, err = readAPIChannel(t, conn)
				var closeError websocket.CloseError
				if !errors.As(err, &closeError) || closeError.Code != websocket.StatusPolicyViolation || closeError.Reason != code {
					t.Fatalf("policy close = %v", err)
				}
				f.shutdown()
				if f.polls.Load() != 2 {
					t.Fatal("refused socket admitted another poll", f.polls.Load())
				}
			})
		}
	}
}

func TestAPIUserChannelInfrastructureFailureUsesFixedInternalClose(t *testing.T) {
	for _, protocol := range []string{sp.Protocol, v2.Protocol} {
		t.Run(protocol, func(t *testing.T) {
			f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
			f.onPoll = func(_ context.Context, _ model.Principal, count int32) error {
				if count > 1 {
					return &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: &model.Fault{Code: "unauthenticated", Message: "private database detail"}}
				}
				return nil
			}
			conn, _, err := f.dial(f.path(protocol, false), []string{protocol, "daynight.authorization." + f.token}, http.Header{"Origin": {apiChannelOrigin}})
			if err != nil {
				t.Fatal(err)
			}
			defer conn.CloseNow()
			if _, err := readAPIChannel(t, conn); err != nil {
				t.Fatal(err)
			}
			_, err = readAPIChannel(t, conn)
			var failure websocket.CloseError
			if !errors.As(err, &failure) || failure.Code != websocket.StatusInternalError || failure.Reason != "Session channel failed." {
				t.Fatalf("infrastructure close = %v", err)
			}
			f.shutdown()
			if f.polls.Load() != 2 {
				t.Fatal("failed socket admitted another poll")
			}
		})
	}
}

func TestAPIUserChannelCanceledHandshakeDoesNotCancelNextRequest(t *testing.T) {
	f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
	var requests atomic.Int32
	handler := f.server.Config.Handler
	f.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) == 1 {
			ctx, cancel := context.WithCancel(r.Context())
			cancel()
			r = r.WithContext(ctx)
		}
		handler.ServeHTTP(w, r)
	})
	seen := make(chan error, 2)
	f.auth.BindAPIAccess(func(ctx context.Context, token string) (store.OAuthAccessIdentity, error) {
		seen <- ctx.Err()
		if ctx.Err() != nil {
			return store.OAuthAccessIdentity{}, ctx.Err()
		}
		if token != f.token {
			return store.OAuthAccessIdentity{}, authhttp.Failure()
		}
		return f.identity, nil
	}, apiChannelOrigin)
	conn, _, err := f.dial(f.path(sp.Protocol, false), []string{sp.Protocol, "daynight.authorization." + f.token}, http.Header{"Origin": {apiChannelOrigin}})
	if conn != nil {
		conn.CloseNow()
	}
	if err == nil || !errors.Is(<-seen, context.Canceled) || f.polls.Load() != 0 {
		t.Fatal("canceled handshake entered protected work", err)
	}
	conn, _, err = f.dial(f.path(sp.Protocol, false), []string{sp.Protocol, "daynight.authorization." + f.token}, http.Header{"Origin": {apiChannelOrigin}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if err := <-seen; err != nil {
		t.Fatal("next handshake reused canceled context", err)
	}
	if _, err := readAPIChannel(t, conn); err != nil {
		t.Fatal(err)
	}
}

func TestAPIUserChannelPostHandshakeResetPreservesControlFrame(t *testing.T) {
	f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
	f.onPoll = func(_ context.Context, _ model.Principal, count int32) error {
		if count > 1 {
			return &model.Fault{Code: "reset_required", Message: "Cursor retention changed."}
		}
		return nil
	}
	conn, _, err := f.dial(f.path(sp.Protocol, false), []string{sp.Protocol, "daynight.authorization." + f.token}, http.Header{"Origin": {apiChannelOrigin}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if _, err := readAPIChannel(t, conn); err != nil {
		t.Fatal(err)
	}
	frame, err := readAPIChannel(t, conn)
	if err != nil || frame["type"] != "reset_required" || frame["protocol"] != sp.Protocol || frame["reason"] != "Cursor retention changed." {
		t.Fatal("poll reset lost original control frame", frame, err)
	}
	_, err = readAPIChannel(t, conn)
	if err == nil || websocket.CloseStatus(err) == websocket.StatusInternalError {
		t.Fatal("handled reset became infrastructure failure", err)
	}
	f.shutdown()
	if f.polls.Load() != 2 {
		t.Fatal("reset socket admitted another poll")
	}
}

func TestAPIUserChannelPersistedEventEncodingFailureClosesInternal(t *testing.T) {
	f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
	poll := f.routes.service.BrowserPoll
	f.routes.service.BrowserPoll = func(ctx context.Context, p model.Principal, project, task, session, after string) (sp.Snapshot, []map[string]any, string, error) {
		snapshot, _, cursor, err := poll(ctx, p, project, task, session, after)
		if f.polls.Load() > 1 {
			return snapshot, []map[string]any{{"eventSeq": 42}}, cursor, err
		}
		return snapshot, nil, cursor, err
	}
	conn, _, err := f.dial(f.path(sp.Protocol, false), []string{sp.Protocol, "daynight.authorization." + f.token}, http.Header{"Origin": {apiChannelOrigin}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if _, err := readAPIChannel(t, conn); err != nil {
		t.Fatal(err)
	}
	_, err = readAPIChannel(t, conn)
	var failure websocket.CloseError
	if !errors.As(err, &failure) || failure.Code != websocket.StatusInternalError || failure.Reason != "Session channel failed." {
		t.Fatalf("persisted event failure close = %v", err)
	}
	f.shutdown()
}

func TestAPIUserChannelUpgradeFailureReleasesReservation(t *testing.T) {
	f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
	r := httptest.NewRequest(http.MethodGet, f.path(sp.Protocol, false), nil)
	r.Header = http.Header{"Origin": {apiChannelOrigin}, "Sec-Websocket-Protocol": {sp.Protocol + ", daynight.authorization." + f.token}}
	w := httptest.NewRecorder()
	f.server.Config.Handler.ServeHTTP(w, r)
	if w.Code != http.StatusUpgradeRequired {
		t.Fatalf("non-upgrade status=%d body=%s", w.Code, w.Body.String())
	}
	f.routes.mutex.Lock()
	reserved := f.routes.reserved
	f.routes.mutex.Unlock()
	if reserved != 0 || f.routes.ActiveConnections() != 0 {
		t.Fatal("failed upgrade retained reservation")
	}
	if strings.Contains(w.Body.String(), f.token) || strings.Contains(f.logs.text(), f.token) {
		t.Fatal("failed upgrade leaked token")
	}
}

func TestAPIUserChannelProducerMarkersDoNotSelectAPIAuthentication(t *testing.T) {
	f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
	for _, path := range []string{"/api/v1/controller-channel", "/api/v1/projects/" + f.project + "/tasks/" + f.task + "/sessions/" + f.session + "/worker-channel"} {
		conn, response, err := f.dial(path, []string{sp.Protocol, "daynight.authorization." + f.token}, http.Header{"Origin": {apiChannelOrigin}})
		if conn != nil {
			conn.CloseNow()
		}
		if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
			t.Fatal(response, err)
		}
	}
	if f.apiCalls.Load() != 0 {
		t.Fatal("producer selected browser API verifier")
	}
}

func TestAPIUserChannelNewAccessDoesNotExtendOldSocketAndReconnectsAfterRelease(t *testing.T) {
	oldExpiry := time.Now().Add(1250 * time.Millisecond)
	f := newAPIChannelFixture(t, oldExpiry)
	newToken := secret.Random("dnapi_")
	newIdentity := f.identity
	newIdentity.Principal.CredentialID = uuid.NewString()
	newIdentity.ExpiresAt = oldExpiry.Add(time.Hour)
	f.auth.BindAPIAccess(func(_ context.Context, token string) (store.OAuthAccessIdentity, error) {
		switch token {
		case f.token:
			return f.identity, nil
		case newToken:
			return newIdentity, nil
		default:
			return store.OAuthAccessIdentity{}, authhttp.Failure()
		}
	}, apiChannelOrigin)
	oldPoll := make(chan context.Context, 1)
	newPoll := make(chan context.Context, 1)
	var observedOld, observedNew atomic.Bool
	f.onPoll = func(ctx context.Context, p model.Principal, _ int32) error {
		if _, deadline := ctx.Deadline(); deadline {
			if p == f.identity.Principal && !observedOld.Swap(true) {
				oldPoll <- ctx
			} else if p == newIdentity.Principal && !observedNew.Swap(true) {
				newPoll <- ctx
			}
		}
		return nil
	}
	released := make(chan model.Principal, 2)
	f.onDisconnect = func(ctx context.Context, p model.Principal, browser, claim, epoch string) {
		if ctx.Err() != nil || browser != f.browser || claim != f.snapshot.ClaimID || epoch != f.snapshot.ConnectionEpoch {
			t.Error("reconnect cleanup changed original lease or used canceled context")
		}
		released <- p
	}
	oldConn, _, err := f.dial(f.path(v2.Protocol, false), []string{v2.Protocol, "daynight.authorization." + f.token}, http.Header{"Origin": {apiChannelOrigin}})
	if err != nil {
		t.Fatal(err)
	}
	defer oldConn.CloseNow()
	if _, err := readAPIChannel(t, oldConn); err != nil {
		t.Fatal(err)
	}
	var oldContext context.Context
	select {
	case oldContext = <-oldPoll:
	case <-time.After(3 * time.Second):
		t.Fatal("old access did not enter poll")
	}
	if expiry, ok := oldContext.Deadline(); !ok || !expiry.Equal(oldExpiry) {
		t.Fatal("new access changed old deadline", expiry)
	}
	select {
	case <-oldContext.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("old socket did not expire")
	}
	if _, err := readAPIChannel(t, oldConn); err == nil {
		t.Fatal("old socket survived new access availability")
	}
	select {
	case p := <-released:
		if p != f.identity.Principal {
			t.Fatal("new access replaced old cleanup Actor", p)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("old viewer was not released")
	}
	// Viewer deletion and connection reservation release follow the detached cleanup callback.
	f.routes.active.Wait()
	newConn, response, err := f.dial(f.path(v2.Protocol, false), []string{v2.Protocol, "daynight.authorization." + newToken}, http.Header{"Origin": {apiChannelOrigin}})
	if err != nil {
		t.Fatal(err)
	}
	defer newConn.CloseNow()
	if response.Header.Get("Daynight-User-ID") != f.identity.Principal.UserID {
		t.Fatal("refresh changed user")
	}
	frame, err := readAPIChannel(t, newConn)
	if err != nil || frame["claimId"] != f.snapshot.ClaimID || frame["connectionEpoch"] != f.snapshot.ConnectionEpoch {
		t.Fatal("reconnect changed original fence", frame, err)
	}
	select {
	case ctx := <-newPoll:
		if expiry, ok := ctx.Deadline(); !ok || !expiry.Equal(newIdentity.ExpiresAt) || ctx.Err() != nil {
			t.Fatal("new handshake did not own new expiry", expiry, ctx.Err())
		}
		identity, ok := userAccess(ctx)
		if !ok || identity != newIdentity {
			t.Fatal("reconnect lost new access identity", identity)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("new access did not enter poll")
	}
}
