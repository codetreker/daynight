package session_test

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/google/uuid"
)

type listHTTPFixture struct {
	handler *resourceTestHandler
	auth    *routeAuthentication
	writer  *listHTTPWriter
}

func newListHTTPFixture(t *testing.T) listHTTPFixture {
	t.Helper()
	principal := model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	auth := newRouteAuthentication(t, "https://daynight.example")
	writer := &listHTTPWriter{t: t, principal: principal}
	engine := sessioncore.NewEngine(nil)
	service := sessionservice.New(writer, engine)
	routes := sessionhttp.NewRoutes(service, auth.Authentication, testLogger())
	mux := http.NewServeMux()
	routes.RegisterRoutes(mux)
	t.Cleanup(func() {
		if writer.phase != nil {
			t.Error("test Session list fixture retained an unfinished request plan")
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := errors.Join(routes.Shutdown(ctx), engine.Stop(ctx)); err != nil {
			t.Error(err)
		}
	})
	return listHTTPFixture{handler: &resourceTestHandler{Handler: httpx.RequestLogging(testLogger(), mux), token: auth.Credential(principal), principal: principal}, auth: auth, writer: writer}
}

type listHTTPWriter struct {
	t         *testing.T
	principal model.Principal
	phase     *listHTTPDAO
	calls     int
}

func (w *listHTTPWriter) Expect(limit int, online bool, rows []store.TestSessionListItem) {
	w.t.Helper()
	if w.phase != nil {
		w.t.Fatal("list request still has unfinished expectations")
	}
	w.phase = &listHTTPDAO{t: w.t, principal: w.principal, limit: limit, online: online, rows: rows}
}

func (w *listHTTPWriter) Finish() {
	w.t.Helper()
	if w.phase == nil || !w.phase.closed || w.phase.credentials != 1 || w.phase.lists != 1 {
		w.t.Fatalf("list request did not finish its exact credential/list plan: %+v", w.phase)
	}
	w.phase = nil
}

func (w *listHTTPWriter) WriteSession(ctx context.Context, work func(store.SessionScope) error) (store.Completion, error) {
	w.calls++
	if w.phase == nil || w.phase.closed {
		w.t.Error("unexpected test Session list transaction")
		return store.Completion{Outcome: store.TransactionNotCommitted}, errors.New("unexpected test Session list transaction")
	}
	w.phase.ctx = ctx
	err := work(listHTTPScope{dao: w.phase})
	w.phase.closed = true
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}, err
	}
	return store.Completion{Outcome: store.TransactionCommitted}, nil
}

type listHTTPScope struct{ dao *listHTTPDAO }

func (s listHTTPScope) SessionDAO() store.SessionDAO { return s.dao }
func (listHTTPScope) BotDAO() store.BotWriteDAO      { return listHTTPUnusedBotDAO{} }

type listHTTPUnusedBotDAO struct{ store.BotWriteDAO }

type listHTTPDAO struct {
	store.SessionDAO
	t           *testing.T
	ctx         context.Context
	principal   model.Principal
	limit       int
	online      bool
	rows        []store.TestSessionListItem
	credentials int
	lists       int
	closed      bool
}

func (d *listHTTPDAO) LockCredential(ctx context.Context, principal model.Principal, now time.Time) error {
	d.credentials++
	if d.closed || d.credentials != 1 || d.lists != 0 || ctx != d.ctx || principal != d.principal || now.IsZero() {
		d.t.Fatal("list credential call changed its identity, context or order")
	}
	return nil
}

func (d *listHTTPDAO) ListTestSessions(ctx context.Context, owner string, now time.Time, limit int, online bool, heartbeat time.Time, cursor *time.Time, id string) ([]store.TestSessionListItem, error) {
	d.lists++
	if d.closed || d.lists != 1 || d.credentials != 1 || ctx != d.ctx || owner != d.principal.UserID || now.IsZero() || limit != d.limit || online != d.online || heartbeat != now.Add(-sessioncore.HeartbeatTimeout) || cursor != nil || id != "" {
		d.t.Fatalf("list DAO arguments/order changed: owner=%s limit=%d online=%v heartbeat=%s cursor=%v id=%s", owner, limit, online, heartbeat, cursor, id)
	}
	return d.rows, nil
}
