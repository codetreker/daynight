package session

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	sessionservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/session"
	"github.com/google/uuid"
)

type occurrenceAuthorizationSource struct{}

type occurrenceRejectWriter struct{ failure error }

func (w occurrenceRejectWriter) WriteSession(context.Context, func(store.SessionScope) error) (store.Completion, error) {
	return store.Completion{Outcome: store.TransactionNotCommitted}, w.failure
}

func (occurrenceAuthorizationSource) SessionWrite(context.Context, store.SessionScope, model.Principal) (model.CredentialAuthorization, error) {
	return model.CredentialAuthorization{}, nil
}

func TestScopedImageOccurrenceUsesGuardedExecution(t *testing.T) {
	f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
	engine := sessioncore.NewEngine(nil)
	t.Cleanup(func() {
		if err := engine.Stop(context.Background()); err != nil {
			t.Error(err)
		}
	})
	failure := errors.New("original execution writer")
	service, err := sessionservice.NewScopedCommands(occurrenceRejectWriter{failure}, engine, occurrenceAuthorizationSource{})
	if err != nil {
		t.Fatal(err)
	}
	h := NewRoutes(service, nil, f.routes.logger)
	if !h.scopedImageOccurrence {
		t.Fatal("guarded execution not installed")
	}
	service.Execution = nil
	if _, err := h.service.GetImageOccurrence(t.Context(), f.native, "", "", f.session, uuid.NewString()); !errors.Is(err, failure) {
		t.Fatalf("status lost its original execution: %v", err)
	}
	if _, err := h.service.RetryImageOccurrence(t.Context(), f.native, "", "", f.session, uuid.NewString()); !errors.Is(err, failure) {
		t.Fatalf("retry lost its original execution: %v", err)
	}
	legacy := NewRoutes(sessionservice.New(nil, engine), nil, f.routes.logger)
	if legacy.scopedImageOccurrence {
		t.Fatal("unguarded execution accepted")
	}
	h.auth = f.routes.auth
	if err := h.EnableScopedSessionReads(func(r *http.Request, _ model.Principal) (context.Context, error) { return r.Context(), nil }, func(*http.Request, model.Principal) (func(context.Context, string, string, string) error, error) {
		return nil, nil
	}); err != nil {
		t.Fatal(err)
	}
	image := uuid.NewString()
	reads, retries := 0, 0
	h.service.GetImageOccurrence = func(_ context.Context, p model.Principal, _, _, _, id string) (sp.ImageOccurrenceStatus, error) {
		reads++
		if p != f.native || id != image {
			t.Error("status identity changed")
		}
		return sp.ImageOccurrenceStatus{ImageID: id, Revision: "1", State: "failed", Action: "none", Error: &sp.ImageError{Code: "invalid_image", Message: "failed"}}, nil
	}
	h.service.RetryImageOccurrence = func(_ context.Context, p model.Principal, _, _, _, id string) (sp.ImageOccurrenceRetryReceipt, error) {
		retries++
		if p != f.native || id != image {
			t.Error("retry identity changed")
		}
		return sp.ImageOccurrenceRetryReceipt{}, nil
	}
	mux := http.NewServeMux()
	h.RegisterRoutes(mux)
	path := "/api/v1/test-sessions/" + f.session + "/image-occurrences/" + image
	for _, req := range []struct{ method, path, body string }{{"GET", path, ""}, {"POST", path + "/retry", `{}`}} {
		r := httptest.NewRequest(req.method, req.path, strings.NewReader(req.body))
		r.Header.Set("Authorization", "Bearer native-secret")
		r.Header.Set("Daynight-Session-Content-Revision", "2")
		if req.body != "" {
			r.Header.Set("Content-Type", "application/json")
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", req.method, w.Code, w.Body)
		}
	}
	if reads != 1 || retries != 1 {
		t.Fatalf("calls: %d %d", reads, retries)
	}
}

func TestScopedImageOccurrenceRoutesKeepFixedProfilesAndClosePAT(t *testing.T) {
	for _, profile := range []string{"pat", "cookie", "api", "legacy-pat"} {
		t.Run(profile, func(t *testing.T) {
			f := newAPIChannelFixture(t, time.Now().Add(time.Hour))
			p := f.native
			headers := http.Header{"Authorization": {"Bearer native-secret"}}
			scoped := profile != "legacy-pat"
			if profile == "cookie" {
				p.Kind = model.SessionCredential
				headers = http.Header{"Cookie": {"__Host-daynight_session=native-secret"}, "Origin": {nativeChannelOrigin}}
			} else if profile == "api" {
				p = f.identity.Principal
				headers = http.Header{"Authorization": {"Bearer " + f.token}}
			}
			policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"session:control", "session:read"}, 1)
			if err != nil {
				t.Fatal(err)
			}
			auth := model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}
			if profile == "cookie" {
				auth.Profile, auth.Policy = model.SessionProfile, nil
			}
			if profile == "api" {
				auth.Profile, auth.Policy = model.OAuthAPIProfile, nil
			}
			binds, reads, retries := 0, 0, 0
			if scoped {
				resolve := func(_ *http.Request, actual model.Principal) (model.CredentialAuthorization, error) {
					binds++
					if actual != p {
						t.Errorf("identity changed: %+v", actual)
					}
					return auth, nil
				}
				current := func(context.Context, store.SessionScope, model.CredentialAuthorization) (model.CredentialAuthorization, error) {
					t.Error("controlled route unexpectedly entered the service transaction")
					return model.CredentialAuthorization{}, nil
				}
				snapshot := func(context.Context, store.SnapshotScope, model.CredentialAuthorization) (model.CredentialAuthorization, error) {
					t.Error("unexpected snapshot")
					return model.CredentialAuthorization{}, nil
				}
				bind, err := NewScopedReadContextBinder(resolve, current, snapshot)
				if err != nil {
					t.Fatal(err)
				}
				admission := func(*http.Request, model.Principal) (func(context.Context, string, string, string) error, error) {
					t.Error("unexpected channel admission")
					return nil, nil
				}
				if err := f.routes.EnableScopedSessionReads(bind, admission); err != nil {
					t.Fatal(err)
				}
			}
			image := uuid.NewString()
			f.routes.service.GetImageOccurrence = func(ctx context.Context, actual model.Principal, project, task, session, id string) (sp.ImageOccurrenceStatus, error) {
				reads++
				if ctx.Err() != nil || actual != p || session != f.session || id != image || (project != "" && (project != f.project || task != f.task)) {
					t.Error("status read changed identity or target")
				}
				return sp.ImageOccurrenceStatus{ImageID: image, Revision: "2", State: "failed", Action: "retry_source", Error: &sp.ImageError{Code: "invalid_image", Message: "Original source failed."}}, nil
			}
			f.routes.service.RetryImageOccurrence = func(_ context.Context, actual model.Principal, _, _, _, _ string) (sp.ImageOccurrenceRetryReceipt, error) {
				retries++
				if actual != p {
					t.Error("retry principal changed")
				}
				return sp.ImageOccurrenceRetryReceipt{}, nil
			}
			taskPath := "/api/v1/projects/" + f.project + "/tasks/" + f.task + "/sessions/" + f.session + "/image-occurrences/" + image
			testPath := "/api/v1/test-sessions/" + f.session + "/image-occurrences/" + image
			request := func(method, path, body string) *httptest.ResponseRecorder {
				r := httptest.NewRequest(method, path, strings.NewReader(body))
				r.Header = headers.Clone()
				r.Header.Set("Daynight-Session-Content-Revision", "2")
				if body != "" {
					r.Header.Set("Content-Type", "application/json")
				}
				w := httptest.NewRecorder()
				f.server.Config.Handler.ServeHTTP(w, r)
				return w
			}
			for _, path := range []string{taskPath, testPath} {
				for _, method := range []string{"GET", "HEAD"} {
					before := reads
					w := request(method, path, "")
					if profile == "pat" {
						if w.Code != http.StatusForbidden || w.Header().Get("Daynight-Scope-Status") != "" || reads != before {
							t.Fatalf("scoped PAT status leaked: %d %s", w.Code, w.Body)
						}
					} else {
						var status sp.ImageOccurrenceStatus
						if w.Code != http.StatusOK || json.Unmarshal(w.Body.Bytes(), &status) != nil || status.ImageID != image || status.Action != "retry_source" || reads != before+1 {
							t.Fatalf("fixed or legacy status changed: %d %s", w.Code, w.Body)
						}
					}
				}
			}
			if profile == "pat" {
				if w := request("POST", taskPath+"/retry", `{}`); w.Code != http.StatusForbidden || retries != 0 {
					t.Fatalf("scoped PAT retry with both permissions: %d %s", w.Code, w.Body)
				}
				denied, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 2)
				if err != nil {
					t.Fatal(err)
				}
				auth.Policy = &denied
				if w := request("GET", taskPath, ""); w.Code != http.StatusForbidden || reads != 0 {
					t.Fatalf("revoked PAT status: %d %s", w.Code, w.Body)
				}
			}
			for _, path := range []string{taskPath, testPath} {
				beforeBinds, beforeRetries := binds, retries
				w := request("POST", path+"/retry", `{}`)
				if profile == "pat" {
					if w.Code != http.StatusForbidden || retries != beforeRetries {
						t.Fatalf("scoped PAT retry escaped: %d %s", w.Code, w.Body)
					}
				} else if w.Code != http.StatusOK || retries != beforeRetries+1 {
					t.Fatalf("fixed or legacy retry changed: %d %s", w.Code, w.Body)
				}
				if binds != beforeBinds {
					t.Fatal("retry unexpectedly received read context")
				}
			}
		})
	}
}
