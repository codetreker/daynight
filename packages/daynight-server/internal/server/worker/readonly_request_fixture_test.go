package worker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type requestMarker struct{}

type requestPlan struct {
	token                   string
	principal               model.Principal
	worker                  string
	input                   ro.Request
	result                  ro.Message
	err                     error
	done                    chan struct{}
	serverContext           context.Context
	authCalls, requestCalls int
}

type strictReadOnly struct {
	t             *testing.T
	mu            sync.Mutex
	plan          *requestPlan
	closeExpected bool
	closeCalls    int
}

func (s *strictReadOnly) Request(ctx context.Context, principal model.Principal, worker string, input ro.Request) (ro.Message, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.plan
	if p == nil {
		s.t.Errorf("unexpected Request")
		return ro.Message{}, errors.New("unexpected Request")
	}
	p.requestCalls++
	deadline, hasDeadline := ctx.Deadline()
	if p.requestCalls != 1 || principal != p.principal || worker != p.worker || !reflect.DeepEqual(input, p.input) || ctx.Value(requestMarker{}) != p || ctx == p.serverContext || !hasDeadline || !deadline.After(time.Now()) || deadline.After(time.Now().Add(ro.RequestTimeout)) || ctx.Err() != nil {
		s.t.Errorf("Request mismatch: calls=%d principal=%+v worker=%s input=%+v marker=%t deadline=%v err=%v", p.requestCalls, principal, worker, input, ctx.Value(requestMarker{}) == p, deadline, ctx.Err())
		return ro.Message{}, errors.New("unexpected Request arguments")
	}
	return p.result, p.err
}
func (s *strictReadOnly) Connect(context.Context, model.Principal, string, ro.Hello) (*ro.Connection, error) {
	s.t.Errorf("unexpected Connect")
	return nil, errors.New("unexpected Connect")
}
func (s *strictReadOnly) Disconnect(*ro.Connection) { s.t.Errorf("unexpected Disconnect") }
func (s *strictReadOnly) Deliver(context.Context, *ro.Connection, ro.Message) error {
	s.t.Errorf("unexpected Deliver")
	return errors.New("unexpected Deliver")
}
func (s *strictReadOnly) Check(context.Context, *ro.Connection) error {
	s.t.Errorf("unexpected Check")
	return errors.New("unexpected Check")
}
func (s *strictReadOnly) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeCalls++
	if !s.closeExpected || s.closeCalls != 1 {
		s.t.Errorf("unexpected Close: calls=%d", s.closeCalls)
	}
}

type requestFixture struct {
	t       *testing.T
	backend *strictReadOnly
	routes  *ReadOnlyRoutes
	server  *httptest.Server
}

func newRequestFixture(t *testing.T) *requestFixture {
	t.Helper()
	f := &requestFixture{t: t, backend: &strictReadOnly{t: t, closeExpected: true}}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		f.backend.mu.Lock()
		defer f.backend.mu.Unlock()
		p := f.backend.plan
		if p == nil {
			t.Errorf("unexpected authentication")
			return model.Principal{}, errors.New("unexpected authentication")
		}
		p.authCalls++
		if p.authCalls != 1 || ctx != p.serverContext || kind != model.PATCredential || token != p.token {
			t.Errorf("authentication mismatch: calls=%d kind=%s token=%q context=%t", p.authCalls, kind, token, ctx == p.serverContext)
			return model.Principal{}, errors.New("unexpected authentication arguments")
		}
		return p.principal, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	f.routes = NewReadOnlyRoutes(nil, &authhttp.Authentication{RequestAuthentication: auth}, logger)
	f.routes.broker = f.backend
	mux := http.NewServeMux()
	f.routes.RegisterRoutes(mux)
	f.server = httptest.NewServer(httpx.RequestLogging(logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.backend.mu.Lock()
		p := f.backend.plan
		if p == nil {
			f.backend.mu.Unlock()
			t.Errorf("unexpected HTTP request")
			http.Error(w, "unexpected", 500)
			return
		}
		ctx := context.WithValue(r.Context(), requestMarker{}, p)
		p.serverContext = ctx
		f.backend.mu.Unlock()
		defer close(p.done)
		mux.ServeHTTP(w, r.WithContext(ctx))
	})))
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := f.routes.Shutdown(ctx); err != nil {
			t.Errorf("route shutdown: %v", err)
		}
		f.server.CloseClientConnections()
		f.server.Close()
		f.backend.mu.Lock()
		defer f.backend.mu.Unlock()
		if f.backend.closeCalls != 1 {
			t.Errorf("Close calls: %d", f.backend.closeCalls)
		}
	})
	return f
}

func (f *requestFixture) request(p *requestPlan, input ro.Request) (int, http.Header, []byte) {
	f.t.Helper()
	p.done = make(chan struct{})
	f.backend.mu.Lock()
	f.backend.plan = p
	f.backend.mu.Unlock()
	raw, err := json.Marshal(input)
	if err != nil {
		f.t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, http.MethodPost, f.server.URL+"/api/v1/me/workers/"+p.worker+"/readonly/requests", bytes.NewReader(raw))
	if err != nil {
		f.t.Fatal(err)
	}
	r.Header.Set("Authorization", "Bearer "+p.token)
	response, err := f.server.Client().Do(r)
	if err != nil {
		f.t.Fatalf("HTTP request: %v", err)
	}
	body, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil {
		f.t.Fatalf("response body: read=%v close=%v", readErr, closeErr)
	}
	select {
	case <-p.done:
	case <-time.After(3 * time.Second):
		f.t.Fatal("handler did not finish")
	}
	f.backend.mu.Lock()
	if p.authCalls != 1 || p.requestCalls != 1 {
		f.t.Errorf("calls: auth=%d Request=%d", p.authCalls, p.requestCalls)
	}
	f.backend.plan = nil
	f.backend.mu.Unlock()
	if response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Daynight-User-ID") != p.principal.UserID {
		f.t.Errorf("response headers: %v", response.Header)
	}
	return response.StatusCode, response.Header, body
}

func TestReadOnlyRouteDefaultBrokerBinding(t *testing.T) {
	broker := ro.New(func(context.Context, model.Principal, string) error { return errors.New("unexpected authorization") })
	defer broker.Close()
	for _, source := range []*ro.Broker{broker, nil} {
		routes := NewReadOnlyRoutes(source, nil, nil)
		actual, ok := routes.broker.(*ro.Broker)
		if !ok || actual != source {
			t.Fatalf("binding: type=%T value=%p want=%p", routes.broker, actual, source)
		}
		if routes.bodyTimeout != 5*time.Second || routes.heartbeatInterval != 5*time.Second || routes.operationTimeout("directory.list") != ro.RequestTimeout || routes.operationTimeout("model.list") != ro.ModelRequestTimeout || routes.connections == nil || routes.requestTargets == nil || routes.drained == nil {
			t.Fatal("route defaults changed")
		}
	}
}
