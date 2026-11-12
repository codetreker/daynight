package auth

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	identityconfig "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity/config"

	coreidentity "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
)

func TestCallbackBoundsDecompressedGatewayResponse(t *testing.T) {
	h := authTestHarness(t)
	var calls atomic.Int32
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		var input struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			return
		}
		parts := strings.Split(input.Code, "-")
		size := 0
		if len(parts) == 2 {
			size, _ = strconv.Atoi(parts[1])
		}
		name := "original"
		if size > coreidentity.MaxIdentityResponseBytes {
			name = "must-not-save"
		}
		body := []byte(fmt.Sprintf(`{"provider":"github","id":"stable-gateway","email":null,"email_verified":null,"name":%q,"avatar_url":"avatar","origin":{}}`, name))
		if size > len(body) {
			body = append(body, bytes.Repeat([]byte(" "), size-len(body))...)
		}
		w.Header().Set("Content-Type", "application/json")
		if parts[0] == "gzip" {
			var compressed bytes.Buffer
			writer := gzip.NewWriter(&compressed)
			_, _ = writer.Write(body)
			_ = writer.Close()
			w.Header().Set("Content-Encoding", "gzip")
			w.Header().Set("Content-Length", strconv.Itoa(compressed.Len()))
			_, _ = w.Write(compressed.Bytes())
			return
		}
		if parts[0] == "chunked" {
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
		} else {
			w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		}
		_, _ = w.Write(body)
	}))
	t.Cleanup(gateway.Close)
	client, err := service.NewIdentityClient(identityconfig.Config{URL: gateway.URL, AppID: "test", AppSecret: "secret", AllowLoopbackHTTP: true})
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
	h.Login(t, "initial")
	ctx := context.Background()
	for _, mode := range []string{"plain", "chunked", "gzip"} {
		for _, extra := range []int{0, 1} {
			t.Run(fmt.Sprintf("%s/extra-%d", mode, extra), func(t *testing.T) {
				state, binding := h.Start(t, "/projects")
				stateHash := sha256.Sum256([]byte(state))
				var usersBefore, teamsBefore, sessionsBefore, pending int
				if err := h.Database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM teams),(SELECT count(*) FROM sessions),(SELECT count(*) FROM login_transactions WHERE state_hash=$1)`, stateHash[:]).Scan(&usersBefore, &teamsBefore, &sessionsBefore, &pending); err != nil || pending != 1 {
					t.Fatalf("pending login before callback: %d %v", pending, err)
				}
				code := fmt.Sprintf("%s-%d", mode, coreidentity.MaxIdentityResponseBytes+extra)
				path := "/api/v1/auth/callback?" + url.Values{"state": {state}, "code": {code}}.Encode()
				before := calls.Load()
				response := h.Request(http.MethodGet, path, "", []*http.Cookie{binding}, nil, "")
				if extra == 0 {
					if response.Code != http.StatusSeeOther || response.Header().Get("Location") != "/auth/complete?callbackPath=%2Fapi%2Fv1%2Fauth%2Fcallback&returnPath=%2Fprojects" {
						t.Fatalf("boundary response: %d %s", response.Code, response.Body)
					}
				} else {
					testsupport.AssertProjectError(t, response, http.StatusBadGateway, "identity_unavailable")
					cookies := response.Result().Cookies()
					if len(cookies) != 1 || cookies[0].Name != binding.Name || cookies[0].MaxAge != -1 {
						t.Fatalf("binding not cleared: %#v", cookies)
					}
				}
				var users, teams, sessions int
				var name, avatar string
				if err := h.Database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM users),(SELECT count(*) FROM teams),(SELECT count(*) FROM sessions),(SELECT count(*) FROM login_transactions WHERE state_hash=$1),name,avatar_url FROM users WHERE uniauth_id='stable-gateway'`, stateHash[:]).Scan(&users, &teams, &sessions, &pending, &name, &avatar); err != nil {
					t.Fatal(err)
				}
				if pending != 0 || users != usersBefore || teams != teamsBefore || sessions != sessionsBefore+1-extra || name != "original" || avatar != "avatar" {
					t.Fatalf("unexpected persistence: users=%d teams=%d sessions=%d pending=%d name=%q avatar=%q", users, teams, sessions, pending, name, avatar)
				}
				testsupport.AssertProjectError(t, h.Request(http.MethodGet, path, "", []*http.Cookie{binding}, nil, ""), http.StatusUnauthorized, "unauthenticated")
				if calls.Load() != before+1 {
					t.Fatal("replay reached gateway")
				}
			})
		}
	}
}
