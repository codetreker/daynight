package session

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

func TestScopedReadBinderReachesChannelPoll(t *testing.T) {
	f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
	type contextKey struct{}
	if err := f.routes.EnableScopedSessionReads(func(r *http.Request, p model.Principal) (context.Context, error) {
		if p != f.native {
			t.Errorf("unexpected principal: %+v", p)
		}
		return context.WithValue(r.Context(), contextKey{}, true), nil
	}, func(*http.Request, model.Principal) (func(context.Context, string, string, string) error, error) {
		return func(context.Context, string, string, string) error { return nil }, nil
	}); err != nil {
		t.Fatal(err)
	}
	f.onPoll = func(ctx context.Context, _ model.Principal, _ int32) error {
		if ctx.Value(contextKey{}) != true {
			t.Error("read context did not reach poll")
		}
		return nil
	}
	conn, _, err := f.dial(f.path("", false), []string{"daynight.session.v1"}, http.Header{"Authorization": {"Bearer native-secret"}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if frame, err := readAPIChannel(t, conn); err != nil || frame["type"] != "snapshot" {
		t.Fatalf("snapshot: %v %v", frame, err)
	}
}

func TestScopedStandaloneReadRoutesRejectBeforeBackend(t *testing.T) {
	const project = "11111111-1111-4111-8111-111111111111"
	const task = "22222222-2222-4222-8222-222222222222"
	const session = "33333333-3333-4333-8333-333333333333"
	base := "/api/v1/projects/" + project + "/tasks/" + task + "/sessions/" + session
	group := "/api/v1/projects/" + project + "/history-directory"
	principal := model.Principal{Kind: model.PATCredential, UserID: "owner", CredentialID: "token"}
	mux := http.NewServeMux()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	auth := inspectionRouteAuth{principal}
	var binds int
	bind := func(_ *http.Request, p model.Principal) (context.Context, error) {
		binds++
		if p != principal {
			t.Error("principal changed")
		}
		return nil, &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."}
	}
	if err := RegisterScopedHistoryRoutes(mux, historyRouteMock{}, auth, bind, logger); err != nil {
		t.Fatal(err)
	}
	if err := RegisterScopedInspectionRoutes(mux, inspectionRouteOperation(nil), auth, bind, logger); err != nil {
		t.Fatal(err)
	}
	if err := RegisterScopedGroupDirectoryRoutes(mux, groupRouteRead(nil), auth, bind, logger); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{base + "/messages", base + "/message-content?cursor=body", base + "/inspection", group, group + "/" + task + "/members", group + "/tasks/" + task + "/sessions"} {
		for _, method := range []string{"GET", "HEAD"} {
			before := binds
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest(method, path, nil))
			if w.Code != http.StatusForbidden || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || binds != before+1 {
				t.Fatalf("%s %s: status=%d binds=%d body=%s", method, path, w.Code, binds-before, w.Body.String())
			}
		}
		before := binds
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, httptest.NewRequest("POST", path, nil))
		if w.Code != http.StatusMethodNotAllowed || binds != before {
			t.Fatalf("POST %s: %d binds=%d", path, w.Code, binds-before)
		}
	}
}

func TestScopedRegisteredReadsRejectBeforeSessionService(t *testing.T) {
	f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
	reserved, released := 0, 0
	f.routes.service.TryReserveArchivePreflight = func() (io.Closer, error) {
		reserved++
		return historyCloser(func() error { released++; return nil }), nil
	}
	binds := 0
	bind := func(_ *http.Request, p model.Principal) (context.Context, error) {
		binds++
		if p != f.native {
			t.Error("principal changed")
		}
		return nil, &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope."}
	}
	admission := func(*http.Request, model.Principal) (func(context.Context, string, string, string) error, error) {
		t.Error("channel admission entered after context refusal")
		return nil, nil
	}
	if err := f.routes.EnableScopedSessionReads(bind, admission); err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/projects/" + f.project + "/tasks/" + f.task + "/sessions"
	id := "/" + f.session
	test := "/api/v1/test-sessions/" + f.session
	for _, path := range []string{base, base + "/current", base + id + "/timeline", base + id + "/operations/" + f.session, base + id + "/resources/" + f.session + "/content", base + id + "/channel", base + id + "/archive", base + id + "/archive/content", base + id + "/archive/files/" + f.session, "/api/v1/test-sessions", test, test + "/timeline", test + "/operations/" + f.session, test + "/resources/" + f.session + "/content", test + "/channel", test + "/archive", test + "/archive/content", test + "/archive/files/" + f.session} {
		before := binds
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", "Bearer native-secret")
		w := httptest.NewRecorder()
		f.server.Config.Handler.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden || w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || binds != before+1 {
			t.Fatalf("GET %s: status=%d binds=%d body=%s", path, w.Code, binds-before, w.Body.String())
		}
	}
	if f.polls.Load() != 0 {
		t.Fatal("refused read entered session service")
	}
	if reserved != 4 || released != reserved {
		t.Fatalf("archive reservations: %d acquired, %d released", reserved, released)
	}
	for _, path := range []string{base, base + id + "/archive", base + id + "/archive/content"} {
		before := binds
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", "Bearer native-secret")
		r.Header.Set(v2.ProtocolHeader, v2.Protocol)
		w := httptest.NewRecorder()
		f.server.Config.Handler.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden || binds != before+1 {
			t.Fatalf("Terminal %s: %d binds=%d", path, w.Code, binds-before)
		}
	}
	if reserved != released {
		t.Fatalf("archive reservations leaked: %d/%d", reserved, released)
	}
	before := binds
	r := httptest.NewRequest("HEAD", base+id+"/timeline", nil)
	r.Header.Set("Authorization", "Bearer native-secret")
	w := httptest.NewRecorder()
	f.server.Config.Handler.ServeHTTP(w, r)
	if w.Code != http.StatusMethodNotAllowed || binds != before {
		t.Fatalf("explicit HEAD fallback: %d binds=%d", w.Code, binds-before)
	}
}

func TestScopedChannelBindingPreservesAuthenticationProfile(t *testing.T) {
	for _, profile := range []string{"pat", "cookie", "api"} {
		t.Run(profile, func(t *testing.T) {
			f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
			seen := false
			bind := func(r *http.Request, p model.Principal) (context.Context, error) {
				seen = true
				_, application := userAccess(r.Context())
				want := f.native
				if profile == "cookie" {
					want.Kind = model.SessionCredential
				}
				if profile == "api" {
					want = f.identity.Principal
				}
				if p != want || application != (profile == "api") {
					t.Errorf("profile changed: %+v application=%v", p, application)
				}
				return nil, &model.Fault{Code: "insufficient_scope", Message: "scope"}
			}
			admission := func(*http.Request, model.Principal) (func(context.Context, string, string, string) error, error) {
				t.Error("unexpected channel admission")
				return nil, nil
			}
			if err := f.routes.EnableScopedSessionReads(bind, admission); err != nil {
				t.Fatal(err)
			}
			protocols := []string{"daynight.session.v1"}
			headers := http.Header{"Authorization": {"Bearer native-secret"}}
			if profile == "cookie" {
				headers = http.Header{"Cookie": {"__Host-daynight_session=native-secret"}, "Origin": {nativeChannelOrigin}}
			}
			if profile == "api" {
				protocols = append(protocols, "daynight.authorization."+f.token)
				headers = http.Header{"Origin": {apiChannelOrigin}}
			}
			conn, response, err := f.dial(f.path("", false), protocols, headers)
			if conn != nil {
				conn.CloseNow()
			}
			if err == nil || response == nil || response.StatusCode != http.StatusForbidden || !seen {
				t.Fatalf("response=%v err=%v seen=%v", response, err, seen)
			}
			response.Body.Close()
		})
	}
}
