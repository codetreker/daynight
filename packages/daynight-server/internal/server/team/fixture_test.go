package team

import (
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

type authHarness = testsupport.AuthHarness[*authhttp.Authentication]

func authTestHarness(t *testing.T) *authHarness {
	return testsupport.NewAuthHarness(t, func(identity *identityservice.Identity, logger *slog.Logger) (*authhttp.Authentication, error) {
		return authhttp.NewAuthentication(identity, configpkg.AuthSettings{PublicOrigin: "http://127.0.0.1:8787", AllowHTTPTestOrigin: true}, logger)
	})
}

func jsonBody(t *testing.T, input any) string { return testsupport.JSONBody(t, input) }
func decodeResponse[T any](t *testing.T, response *httptest.ResponseRecorder, status int) T {
	return testsupport.DecodeResponse[T](t, response, status)
}
func assertProjectError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	testsupport.AssertProjectError(t, response, status, code)
}

type threadFailingWriter struct {
	*httptest.ResponseRecorder
	short bool
	calls int
}

func (w *threadFailingWriter) Write(data []byte) (int, error) {
	w.calls++
	if w.short {
		return 0, nil
	}
	return 0, errors.New("private response failure")
}

type teamResourceHandler struct {
	http.Handler
	database  *store.Store
	principal model.Principal
	cookie    *http.Cookie
	origin    string
}

func teamTestHandler(t *testing.T) *teamResourceHandler {
	t.Helper()
	h := authTestHarness(t)
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	RegisterRoutes(mux, teamservice.NewTeams(h.Database), h.Auth, logger)
	h.Handler = httpx.RequestLogging(logger, mux)
	cookie := h.Login(t, "team-resource")
	user := decodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", []*http.Cookie{cookie}, nil, ""), 200)
	return &teamResourceHandler{Handler: h.Handler, database: h.Database, principal: model.Principal{UserID: user.ID}, cookie: cookie, origin: h.Origin}
}

func projectRequest(handler *teamResourceHandler, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.AddCookie(handler.cookie)
	request.Header.Set("Origin", handler.origin)
	request.Header.Set("Content-Type", "application/json; charset=UTF-8")
	request.Header.Set("X-Request-ID", "project-test")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
