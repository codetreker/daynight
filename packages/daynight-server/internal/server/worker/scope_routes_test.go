package worker

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	ro "github.com/codetreker/daynight/packages/daynight-server/internal/core/workerreadonly"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

type scopedWorkerHTTPAuth struct {
	request       *authhttp.RequestAuthentication
	authorization model.CredentialAuthorization
}

func (a scopedWorkerHTTPAuth) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return a.request.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		if p != a.authorization.Principal {
			panic("unexpected principal")
		}
		next(w, r, a.authorization)
	})
}

type workerHTTPAuthority struct {
	service.AuthorizationSource
	authorization model.CredentialAuthorization
	calls         int
}

func (a *workerHTTPAuthority) Read(context.Context, store.SnapshotScope, model.Principal) (model.CredentialAuthorization, error) {
	a.calls++
	return a.authorization, nil
}

func (a *workerHTTPAuthority) WorkerWrite(context.Context, store.WorkerScope, model.Principal) (model.CredentialAuthorization, error) {
	a.calls++
	return a.authorization, nil
}

func TestScopedWorkerHTTPRefusalAndAuthentication(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	p := defaultHTTPPrincipal()
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"prompt:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	authority := &workerHTTPAuthority{authorization: model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}}
	database := newHTTPTestStore(t)
	database.ReadSnapshotCall = func(_ context.Context, call func(store.SnapshotScope) error) error {
		return call(&workerHTTPReadScope{t: t, DAO: &workerHTTPReader{t: t, WorkerConfigurationCall: func(_ context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
			if user != p.UserID || worker != "11111111-1111-4111-8111-111111111111" {
				t.Fatal("configuration target changed")
			}
			return model.WorkerConfigurationResource{ObservationRevision: "0"}, nil
		}}})
	}
	database.WriteWorkerCall = func(_ context.Context, call func(store.WorkerScope) error) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionNotCommitted}, call(nil)
	}
	workers, err := service.NewScopedWorkers(database, authority)
	if err != nil {
		t.Fatal(err)
	}
	requestAuth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
		if kind != model.PATCredential || token != defaultHTTPToken() {
			return model.Principal{}, authhttp.Failure()
		}
		return p, nil
	}, authconfig.AuthSettings{PublicOrigin: workerTestOrigin}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterScopedRoutes(mux, workers, scopedWorkerHTTPAuth{requestAuth, authority.authorization}, logger, nil)
	for _, tc := range []struct {
		method, suffix, body, token string
		want, calls                 int
	}{
		{"GET", "/configuration", "", defaultHTTPToken(), 403, 1},
		{"HEAD", "/configuration", "", defaultHTTPToken(), 403, 1},
		{"POST", "/report", jsonBody(t, configurationHTTPReportBody(nil, nil)), defaultHTTPToken(), 403, 1},
		{"DELETE", "/configuration", "", defaultHTTPToken(), 405, 0},
		{"GET", "/configuration", "", "invalid", 401, 0},
		{"DELETE", "/configuration", "", "invalid", 401, 0},
	} {
		t.Run(tc.method+tc.suffix+tc.token, func(t *testing.T) {
			authority.calls = 0
			r := httptest.NewRequest(tc.method, "/api/v1/me/workers/11111111-1111-4111-8111-111111111111"+tc.suffix, strings.NewReader(tc.body))
			r.Header.Set("Authorization", "Bearer "+tc.token)
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set(workerToolPathsHeader, "2")
			if tc.method == "POST" {
				r.Header.Set(workerConfigurationHeader, "1")
			}
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != tc.want || authority.calls != tc.calls {
				t.Fatalf("status=%d body=%s calls=%d", w.Code, w.Body, authority.calls)
			}
			if tc.want == 403 && (w.Header().Get("Daynight-Scope-Status") != "insufficient_scope" || !strings.Contains(w.Body.String(), `"forbidden"`)) {
				t.Fatalf("scope refusal lost: %v %s", w.Header(), w.Body)
			}
		})
	}
}

func TestWorkerRouteClassificationMatchesMux(t *testing.T) {
	mux := http.NewServeMux()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	entries := map[string]ScopeRoute{}
	observe := func(entry ScopeRoute) {
		if _, exists := entries[entry.Pattern]; exists {
			t.Fatalf("duplicate registration %s", entry.Pattern)
		}
		entries[entry.Pattern] = entry
	}
	require := func(next httpx.AuthenticatedHandler) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) { next(w, r, defaultHTTPPrincipal()) }
	}
	RegisterRoutesWithScopeObserver(mux, nil, require, logger, observe)
	broker := ro.New(func(context.Context, model.Principal, string) error { return nil })
	defer broker.Close()
	readonly := NewScopedReadOnlyRoutes(broker, fixedScopedWorkerAuth{}, logger)
	readonly.RegisterRoutesWithScopeObserver(mux, observe)
	for pattern, entry := range entries {
		if !entry.Fallback && len(entry.Operations) == 0 {
			t.Errorf("unclassified %s", pattern)
		}
		method, path, found := strings.Cut(pattern, " ")
		if !found {
			method, path = "DELETE", pattern
		}
		path = strings.ReplaceAll(path, "{workerId}", "11111111-1111-4111-8111-111111111111")
		_, actual := mux.Handler(httptest.NewRequest(method, path, nil))
		if method == "HEAD" && !entry.Fallback {
			pattern = "GET " + strings.TrimPrefix(pattern, "HEAD ")
		}
		if actual != pattern {
			t.Errorf("mapping %s selects %s", pattern, actual)
		}
	}
	base := "/api/v1/me/workers/{workerId}"
	if entries["POST "+base+"/report"].Dynamic == "" || entries["POST "+base+"/readonly/requests"].Operations[0] != scopepolicy.WorkerInspect || entries["GET "+base+"/readonly/channel"].Operations[0] != scopepolicy.WorkerReport || !entries["HEAD "+base+"/readonly/channel"].Fallback {
		t.Fatal("business variant classification lost")
	}
}

type fixedScopedWorkerAuth struct{}

func (fixedScopedWorkerAuth) RequireScoped(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		next(w, r, model.CredentialAuthorization{Principal: defaultHTTPPrincipal(), Profile: model.ScopedPATProfile})
	}
}

func TestScopedReadOnlyRegistrationRejectsMissingDependencies(t *testing.T) {
	broker := ro.New(func(context.Context, model.Principal, string) error { return nil })
	defer broker.Close()
	for _, tc := range []struct {
		name   string
		broker *ro.Broker
		auth   ScopedAuthentication
	}{
		{"broker", nil, fixedScopedWorkerAuth{}},
		{"authentication", broker, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Fatal("missing dependency admitted")
				}
			}()
			NewScopedReadOnlyRoutes(tc.broker, tc.auth, slog.Default())
		})
	}
}

func TestScopedWorkerRegistrationRejectsLegacyService(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("legacy service admitted")
		}
	}()
	RegisterScopedRoutes(http.NewServeMux(), service.NewWorkers(nil), scopedWorkerHTTPAuth{}, slog.Default(), nil)
}
