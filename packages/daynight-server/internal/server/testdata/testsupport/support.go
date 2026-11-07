package testsupport

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	uniauth "github.com/codetreker/uniauth/sdk/go"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Auth interface {
	SessionCookieName() string
	AuthenticateRequest(*http.Request) (model.Principal, error)
	Require(httpx.AuthenticatedHandler) http.HandlerFunc
	RegisterRoutes(*http.ServeMux)
}
type AuthHarness[A Auth] struct {
	Database *postgres.Store
	Auth     A
	Identity *identityservice.Identity
	Handler  http.Handler
	Logs     bytes.Buffer
	Claims   atomic.Int32
	Origin   string
}

func NewAuthHarness[A Auth](t *testing.T, factory func(*identityservice.Identity, *slog.Logger) (A, error)) *AuthHarness[A] {
	t.Helper()
	h := &AuthHarness[A]{Database: TestStore(t), Origin: "http://127.0.0.1:8787"}
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.Claims.Add(1)
		app, secret, ok := r.BasicAuth()
		if !ok || app != "test-app" || secret != "app-secret-never-log" || r.Method != "POST" || r.URL.Path != "/auth/result" {
			t.Error("incorrect gateway request")
		}
		var input struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		switch input.Code {
		case "protocol-secret":
			w.Header().Set("X-Request-ID", "upstream-request")
			_, _ = io.WriteString(w, `{"payload":"raw-secret"}`)
		case "denied-secret":
			w.Header().Set("X-Request-ID", "bad secret")
			w.WriteHeader(410)
			_, _ = io.WriteString(w, `{"error":{"code":"expired","message":"upstream-secret"}}`)
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"provider": "github", "id": "github:" + input.Code, "email": nil, "email_verified": false, "name": nil, "avatar_url": nil, "origin": map[string]any{"provider-secret": "raw-secret"}})
		}
	}))
	t.Cleanup(gateway.Close)
	client, err := uniauth.New(uniauth.Config{BaseURL: gateway.URL, AppID: "test-app", AppSecret: "app-secret-never-log", AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	h.Identity = identityservice.New(h.Database, client, h.Origin+"/api/v1/auth/callback")
	h.Auth, err = factory(h.Identity, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	mux.HandleFunc("POST /mutation", h.Auth.Require(func(w http.ResponseWriter, r *http.Request, p model.Principal) { w.WriteHeader(204) }))
	h.Handler = httpx.RequestLogging(logger, mux)
	return h
}

func (h *AuthHarness[A]) Request(method, path, body string, cookies []*http.Cookie, authorization []string, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("X-Request-ID", "project-test")
	r.Header.Set("Content-Type", "application/json")
	for _, cookie := range cookies {
		r.AddCookie(cookie)
	}
	if authorization != nil {
		r.Header["Authorization"] = authorization
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	h.Handler.ServeHTTP(w, r)
	return w
}

func (h *AuthHarness[A]) Start(t *testing.T, returnPath string) (string, *http.Cookie) {
	t.Helper()
	values := url.Values{"provider": {"github"}}
	if returnPath != "" {
		values.Set("returnPath", returnPath)
	}
	loginURL := "/api/v1/auth/login?" + values.Encode()
	bootstrap := h.Request("GET", loginURL, "", nil, nil, "")
	if bootstrap.Code != 303 || bootstrap.Header().Get("Location") != loginURL || len(bootstrap.Result().Cookies()) != 1 {
		t.Fatalf("login bootstrap: %d %s", bootstrap.Code, bootstrap.Body)
	}
	scope := bootstrap.Result().Cookies()[0]
	response := h.Request("GET", loginURL, "", []*http.Cookie{scope}, nil, "")
	if response.Code != 303 || len(response.Result().Cookies()) != 2 {
		t.Fatalf("login start: %d %s", response.Code, response.Body)
	}
	u, err := url.Parse(response.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	var cookie *http.Cookie
	for _, candidate := range response.Result().Cookies() {
		if candidate.Name != scope.Name {
			cookie = candidate
		}
	}
	if cookie == nil || cookie.Domain != "" || cookie.Path != "/" || cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode || cookie.MaxAge != 600 {
		t.Fatalf("binding cookie: %+v", cookie)
	}
	return u.Query().Get("state"), cookie
}

func (h *AuthHarness[A]) Login(t *testing.T, code string) *http.Cookie {
	t.Helper()
	state, binding := h.Start(t, "/projects?view=all")
	response := h.Request("GET", "/api/v1/auth/callback?"+url.Values{"state": {state}, "code": {code}}.Encode(), "", []*http.Cookie{binding}, nil, "")
	if response.Code != 303 || response.Header().Get("Location") != "/projects?view=all" {
		t.Fatalf("callback: %d %s %s", response.Code, response.Header().Get("Location"), response.Body)
	}
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == h.Auth.SessionCookieName() {
			return cookie
		}
	}
	t.Fatal("missing session cookie")
	return nil
}

func TestStore(t *testing.T) *postgres.Store {
	t.Helper()
	databaseURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required for PostgreSQL tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := "http_" + strings.ToLower(rand.Text())
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	query.Set("timezone", "UTC")
	query.Set("application_name", schema)
	parsed.RawQuery = query.Encode()
	database, err := postgres.Open(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	return database
}

func DecodeResponse[T any](t *testing.T, response *httptest.ResponseRecorder, status int) T {
	t.Helper()
	if response.Code != status || response.Header().Get("Content-Type") != "application/json" {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body)
	}
	var value T
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func AssertProjectError(t *testing.T, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	value := DecodeResponse[api.ErrorResponse](t, response, status)
	if value.Error.Code != code || value.Error.Message == "" || value.Error.RequestID != response.Header().Get("X-Request-ID") || value.Error.RequestID != "project-test" {
		t.Fatalf("unexpected error correlation: %+v", value)
	}
}

func JSONBody(t *testing.T, input any) string {
	t.Helper()
	data, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
