package mcp

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"sync"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type Authenticator interface {
	Authenticate(context.Context, model.CredentialKind, string) (model.Principal, error)
}

type AuthorityRef struct {
	Kind string
	ID   string
}
type RequestActor struct {
	Principal    model.Principal
	AuthorityRef AuthorityRef
	RequestID    string
	Context      context.Context
	Budget       *Budget
}

type scopeKey struct{}
type requestScope struct {
	actor    RequestActor
	mu       sync.Mutex
	httpDone bool
	handlers int
	releases []func()
}

func (s *requestScope) begin()     { s.mu.Lock(); s.handlers++; s.mu.Unlock() }
func (s *requestScope) end()       { s.mu.Lock(); s.handlers--; s.finish(); s.mu.Unlock() }
func (s *requestScope) delivered() { s.mu.Lock(); s.httpDone = true; s.finish(); s.mu.Unlock() }
func (s *requestScope) hold(release func()) {
	s.mu.Lock()
	s.releases = append(s.releases, release)
	s.mu.Unlock()
}
func (s *requestScope) finish() {
	if s.httpDone && s.handlers == 0 {
		for _, release := range s.releases {
			release()
		}
		s.releases = nil
	}
}

type Entry struct {
	server     *sdk.Server
	http       http.Handler
	auth       Authenticator
	logger     *slog.Logger
	origins    map[string]bool
	publicHost string
	budget     *Budget
	ctx        context.Context
	cancel     context.CancelFunc
	mu         sync.Mutex
	stopped    bool
	drained    chan struct{}
	active     sync.WaitGroup
}

// New creates a stateless HTTP endpoint. Register tools before serving requests.
func New(auth Authenticator, publicOrigin string, allowedOrigins []string, logger *slog.Logger) (*Entry, error) {
	if auth == nil || logger == nil {
		return nil, errors.New("MCP authentication and logger are required")
	}
	if err := config.ValidateMCPOrigins(append([]string{publicOrigin}, allowedOrigins...)); err != nil {
		return nil, err
	}
	origins := make(map[string]bool)
	origins[publicOrigin] = true
	for _, origin := range allowedOrigins {
		origins[origin] = true
	}
	ctx, cancel := context.WithCancel(context.Background())
	server := sdk.NewServer(&sdk.Implementation{Name: "daynight", Version: "1"}, &sdk.ServerOptions{Logger: logger, SupportedProtocolVersions: []string{"2026-07-28", "2025-11-25"}, SetCacheable: func(_ context.Context, _ sdk.Request, c *sdk.Cacheable) { c.CacheScope = "private"; c.TTLMs = 0 }})
	e := &Entry{server: server, auth: auth, logger: logger, origins: origins, publicHost: mustOriginHost(publicOrigin), budget: NewBudget(), ctx: ctx, cancel: cancel}
	e.http = sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return server }, &sdk.StreamableHTTPOptions{Stateless: true, JSONResponse: true, PropagateRequestCancellation: true, MaxRequestBodyBytes: 4 << 20, Logger: logger, DisableLocalhostProtection: true})
	return e, nil
}

func mustOriginHost(origin string) string { u, _ := url.Parse(origin); return u.Host }
func (e *Entry) allowedHost(host string) bool {
	if host == e.publicHost {
		return true
	}
	hostname := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		hostname = h
	}
	if hostname == "localhost" {
		return true
	}
	addr, err := netip.ParseAddr(strings.Trim(hostname, "[]"))
	return err == nil && addr.IsLoopback()
}

type noStoreWriter struct {
	http.ResponseWriter
	failed bool
}

func (w *noStoreWriter) WriteHeader(code int) {
	w.Header().Set("Cache-Control", "no-store")
	w.ResponseWriter.WriteHeader(code)
}
func (w *noStoreWriter) Write(p []byte) (int, error) {
	w.Header().Set("Cache-Control", "no-store")
	n, err := w.ResponseWriter.Write(p)
	if err != nil || n != len(p) {
		w.failed = true
	}
	return n, err
}
func (w *noStoreWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (e *Entry) ServeHTTP(writer http.ResponseWriter, r *http.Request) {
	w := &noStoreWriter{ResponseWriter: writer}
	defer func() {
		if w.failed {
			e.logger.ErrorContext(r.Context(), "MCP response delivery failed", "type", "response_error", "component", "mcp", "phase", "delivery", "request_id", httpx.RequestID(r.Context()))
		}
	}()
	w.Header().Set("Cache-Control", "no-store")
	if !e.beginWork() {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	defer e.active.Done()
	if _, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr); ok && !e.allowedHost(r.Host) {
		http.Error(w, "forbidden host", http.StatusForbidden)
		return
	}
	origins := r.Header.Values("Origin")
	if len(origins) > 1 || (len(origins) == 1 && !e.origins[origins[0]]) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if len(origins) == 1 {
		w.Header().Set("Access-Control-Allow-Origin", origins[0])
		w.Header().Add("Vary", "Origin")
		w.Header().Set("Access-Control-Expose-Headers", "MCP-Session-Id, MCP-Protocol-Version")
	}
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Session-Id, MCP-Method, MCP-Name, Last-Event-ID")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		w.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(w, "authentication required", http.StatusUnauthorized)
		return
	}
	parts := strings.Fields(values[0])
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		w.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(w, "authentication required", http.StatusUnauthorized)
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stop := context.AfterFunc(e.ctx, cancel)
	defer stop()
	p, err := e.auth.Authenticate(ctx, model.PATCredential, parts[1])
	if err != nil {
		w.Header().Set("WWW-Authenticate", "Bearer")
		httpx.WriteError(w, r, e.logger, "mcp", "authenticate", err)
		return
	}
	s := &requestScope{actor: RequestActor{Principal: p, AuthorityRef: AuthorityRef{Kind: "pat", ID: p.CredentialID}, RequestID: httpx.RequestID(r.Context()), Context: ctx, Budget: e.budget}}
	defer s.delivered()
	e.http.ServeHTTP(w, r.WithContext(context.WithValue(ctx, scopeKey{}, s)))
}

// beginWork synchronizes HTTP and tool admission with shutdown's wait start.
func (e *Entry) beginWork() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.stopped {
		return false
	}
	e.active.Add(1)
	return true
}

// BeginShutdown rejects new work and cancels admitted requests.
func (e *Entry) BeginShutdown() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.stopped {
		return
	}
	e.stopped = true
	e.cancel()
	e.drained = make(chan struct{})
	// No Add can follow the admission closure, including tool callbacks that
	// were dispatched by an HTTP request just as shutdown began.
	go func() { e.active.Wait(); close(e.drained) }()
}

// Shutdown waits for the same drain across timeouts and retries.
func (e *Entry) Shutdown(ctx context.Context) error {
	e.BeginShutdown()
	e.mu.Lock()
	done := e.drained
	e.mu.Unlock()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
