package auth

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

func TestCallbackRejectsOversizedUpstreamProfile(t *testing.T) {
	h := authTestHarness(t)
	var calls atomic.Int32
	name, avatar := "original", "avatar"
	transport := providerTestTransport(func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		body := `{"provider":"github","id":"stable","email":null,"email_verified":null,"name":"` + name + `","avatar_url":"` + avatar + `","origin":{}}`
		return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	client, err := uniauth.New(uniauth.Config{BaseURL: "https://identity.example", AppID: "test", AppSecret: "secret", HTTPClient: &http.Client{Transport: transport, Timeout: time.Second}})
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(&h.Logs, nil))
	h.Identity = identityservice.New(h.Database, client, h.Origin+"/api/v1/auth/callback")
	h.Auth, err = NewAuthentication(h.Identity, authconfig.AuthSettings{PublicOrigin: h.Origin, AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	h.Auth.RegisterRoutes(mux)
	h.Handler = httpx.RequestLogging(logger, mux)
	h.Login(t, "original")
	ctx := context.Background()
	var userCount, teamCount, sessionCount int
	if err := h.Database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM teams),(SELECT count(*) FROM sessions)`).Scan(&userCount, &teamCount, &sessionCount); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ name, avatar string }{
		{strings.Repeat("N", 1025), "avatar"},
		{"original", strings.Repeat("<", 512<<10)},
	} {
		name, avatar = tc.name, tc.avatar
		state, binding := h.Start(t, "/projects")
		path := "/api/v1/auth/callback?" + url.Values{"state": {state}, "code": {"private-code"}}.Encode()
		before := calls.Load()
		response := h.Request(http.MethodGet, path, "", []*http.Cookie{binding}, nil, "")
		testsupport.AssertProjectError(t, response, http.StatusBadGateway, "identity_unavailable")
		cookies := response.Result().Cookies()
		if len(cookies) != 1 || cookies[0].Name != binding.Name || cookies[0].MaxAge != -1 || response.Header().Get("Location") != "" {
			t.Fatalf("failed callback cookie or redirect: %#v", cookies)
		}
		testsupport.AssertProjectError(t, h.Request(http.MethodGet, path, "", []*http.Cookie{binding}, nil, ""), http.StatusUnauthorized, "unauthenticated")
		if calls.Load() != before+1 {
			t.Fatal("replay reached upstream")
		}
		var users, teams, sessions int
		var savedName, savedAvatar string
		if err := h.Database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM teams),(SELECT count(*) FROM sessions),name,avatar_url FROM users WHERE uniauth_id='stable'`).Scan(&users, &teams, &sessions, &savedName, &savedAvatar); err != nil {
			t.Fatal(err)
		}
		if users != userCount || teams != teamCount || sessions != sessionCount || savedName != "original" || savedAvatar != "avatar" {
			t.Fatal("rejected profile changed persisted identity or created resources")
		}
	}
	if strings.Contains(h.Logs.String(), "private-code") || strings.Contains(h.Logs.String(), strings.Repeat("N", 20)) || strings.Contains(h.Logs.String(), strings.Repeat("<", 20)) {
		t.Fatal("upstream data appeared in logs")
	}
}
