package preview

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type operations struct {
	create       func(context.Context, string) (model.PreviewSSOLogin, error)
	start        func(context.Context, string) (identity.PreviewSSOStart, error)
	authorize    func(context.Context, string, string, model.Principal) (identity.PreviewSSOAuthorization, error)
	redeem       func(context.Context, string, string, string) (identity.PreviewSSORedemption, error)
	complete     func(context.Context, string, string) (string, error)
	authenticate func(context.Context, string) (model.Principal, time.Time, error)
	retry        func(context.Context, string, string, model.Principal) (string, error)
}

func (o *operations) Create(ctx context.Context, target string) (model.PreviewSSOLogin, error) {
	return o.create(ctx, target)
}
func (o *operations) Start(ctx context.Context, id string) (identity.PreviewSSOStart, error) {
	return o.start(ctx, id)
}
func (o *operations) Authorize(ctx context.Context, id, state string, principal model.Principal) (identity.PreviewSSOAuthorization, error) {
	return o.authorize(ctx, id, state, principal)
}
func (o *operations) Redeem(ctx context.Context, code, state, binding string) (identity.PreviewSSORedemption, error) {
	return o.redeem(ctx, code, state, binding)
}
func (o *operations) Complete(ctx context.Context, id, value string) (string, error) {
	return o.complete(ctx, id, value)
}
func (o *operations) Authenticate(ctx context.Context, value string) (model.Principal, time.Time, error) {
	if o.authenticate == nil {
		panic("unexpected preview authentication")
	}
	return o.authenticate(ctx, value)
}
func (o *operations) Retry(ctx context.Context, id, state string, principal model.Principal) (string, error) {
	if o.retry == nil {
		panic("unexpected preview retry")
	}
	return o.retry(ctx, id, state, principal)
}

func fixture(t *testing.T, ops *operations, secure bool) (*Routes, *bytes.Buffer, http.Handler) {
	t.Helper()
	var logs bytes.Buffer
	scheme := "http"
	if secure {
		scheme = "https"
	}
	h, err := New(ops, func(*http.Request) (model.Principal, error) {
		return model.Principal{Kind: model.SessionCredential, UserID: "user", CredentialID: "session"}, nil
	}, scheme+"://daynight.test", scheme+"://preview.daynight.test", slog.New(slog.NewJSONHandler(&logs, nil)))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.RegisterMain(mux)
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusAccepted) })
	return h, &logs, httpx.RequestLogging(h.logger, h.Wrap(mux))
}

func request(handler http.Handler, method, target string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, nil)
	for _, cookie := range cookies {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}
