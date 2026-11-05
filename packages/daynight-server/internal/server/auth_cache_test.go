package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestMatchesEntityTag(t *testing.T) {
	for _, test := range []struct {
		name   string
		values []string
		match  bool
	}{
		{"missing", nil, false},
		{"empty", []string{" \t"}, false},
		{"strong", []string{`"current"`}, true},
		{"weak", []string{`W/"current"`}, true},
		{"wildcard", []string{" * \t"}, true},
		{"different", []string{`"other"`}, false},
		{"list", []string{`"other", W/"current"`}, true},
		{"header lines", []string{`"other"`, `"current"`}, true},
		{"empty list members", []string{`, "other",, "current",`}, true},
		{"opaque comma", []string{`"other,value", "current"`}, true},
		{"malformed suffix", []string{`"current" suffix`}, false},
		{"unclosed", []string{`"current`}, false},
		{"unquoted", []string{`current`}, false},
		{"empty weak", []string{`W/`}, false},
		{"invalid case", []string{`w/"current"`}, false},
		{"invalid control", []string{"\"other\nvalue\", \"current\""}, false},
		{"invalid space", []string{`"other value", "current"`}, false},
		{"invalid delete", []string{"\"other\x7fvalue\", \"current\""}, false},
		{"invalid wildcard list", []string{`*, "current"`}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if actual := matchesEntityTag(test.values, `"current"`); actual != test.match {
				t.Fatalf("match=%t want %t", actual, test.match)
			}
		})
	}
}

func TestCachedUserRepresentation(t *testing.T) {
	auth := &Authentication{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	name, avatar := "Profile <&> 中文", "data:image/png;base64,AAAA"
	user := api.User{ID: "10000000-0000-4000-8000-000000000001", Name: &name, AvatarURL: &avatar}
	body, err := json.Marshal(user)
	if err != nil {
		t.Fatal(err)
	}
	body = append(body, '\n')
	digest := sha256.Sum256(body)
	etag := `"` + hex.EncodeToString(digest[:]) + `"`
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		t.Run(method, func(t *testing.T) {
			request := httptest.NewRequest(method, "/api/v1/me", nil)
			response := httptest.NewRecorder()
			auth.writeCachedUser(response, request, user)
			if response.Code != http.StatusOK || response.Header().Get("ETag") != etag || response.Header().Get("Cache-Control") != "private, no-cache" || response.Header().Get("Content-Type") != "application/json" || response.Header().Get("Content-Length") != strconv.Itoa(len(body)) {
				t.Fatalf("invalid cache response: %d %#v", response.Code, response.Header())
			}
			if method == http.MethodHead && response.Body.Len() != 0 || method == http.MethodGet && response.Body.String() != string(body) {
				t.Fatalf("unexpected %s response body", method)
			}
			request.Header.Set("If-None-Match", "W/"+etag)
			response = httptest.NewRecorder()
			auth.writeCachedUser(response, request, user)
			if response.Code != http.StatusNotModified || response.Body.Len() != 0 || response.Header().Get("ETag") != etag || response.Header().Get("Content-Length") != "" {
				t.Fatalf("invalid unchanged response: %d %#v", response.Code, response.Header())
			}
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	response := httptest.NewRecorder()
	auth.writeCachedUser(response, httptest.NewRequest(http.MethodGet, "/api/v1/me", nil).WithContext(ctx), user)
	if response.Body.Len() != 0 || response.Header().Get("ETag") != "" {
		t.Fatal("cancelled response published cached content")
	}
}

func conditionalMe(h *authHarness, method string, cookie *http.Cookie, authorization, validator string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "/api/v1/me", nil)
	request.Header.Set("X-Request-ID", "project-test")
	if cookie != nil {
		request.AddCookie(cookie)
	}
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	request.Header.Set("If-None-Match", validator)
	response := httptest.NewRecorder()
	h.handler.ServeHTTP(response, request)
	return response
}

func TestIdentityHTTPMeCacheTracksProfileContent(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.login(t, "cached-profile")
	initial := conditionalMe(h, http.MethodGet, cookie, "", "")
	user := decodeResponse[api.User](t, initial, http.StatusOK)
	etag := initial.Header().Get("ETag")
	if etag == "" {
		t.Fatal("initial profile omitted validator")
	}
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		unchanged := conditionalMe(h, method, cookie, "", etag)
		if unchanged.Code != http.StatusNotModified || unchanged.Body.Len() != 0 || unchanged.Header().Get("Daynight-User-ID") != user.ID || unchanged.Header().Get("Cache-Control") != "private, no-cache" {
			t.Fatalf("%s did not reuse authenticated content: %d", method, unchanged.Code)
		}
	}
	cookie = h.login(t, "cached-profile")
	if unchanged := conditionalMe(h, http.MethodGet, cookie, "", etag); unchanged.Code != http.StatusNotModified {
		t.Fatal("identical login invalidated profile content")
	}
	for _, change := range []struct {
		field string
		value any
	}{
		{"name", "Updated <&> 中文"},
		{"avatar_url", "data:image/png;base64," + strings.Repeat("AAAA", 60_000)},
		{"email", "changed@example.test"},
		{"email_verified", true},
		{"name", nil},
		{"avatar_url", nil},
		{"email", nil},
		{"email_verified", nil},
	} {
		if _, err := h.database.Pool.Exec(t.Context(), "UPDATE users SET "+change.field+"=$2 WHERE id=$1", user.ID, change.value); err != nil {
			t.Fatal(err)
		}
		response := conditionalMe(h, http.MethodGet, cookie, "", etag)
		decodeResponse[api.User](t, response, http.StatusOK)
		if next := response.Header().Get("ETag"); next == "" || next == etag {
			t.Fatalf("%s change did not invalidate content", change.field)
		} else {
			etag = next
		}
		if unchanged := conditionalMe(h, http.MethodGet, cookie, "", etag); unchanged.Code != http.StatusNotModified || unchanged.Body.Len() != 0 {
			t.Fatalf("%s unchanged profile was retransmitted", change.field)
		}
	}
}

func TestIdentityHTTPMeCacheNeverReplacesAuthentication(t *testing.T) {
	h := authTestHarness(t)
	aliceCookie := h.login(t, "cache-alice")
	aliceResponse := conditionalMe(h, http.MethodGet, aliceCookie, "", "")
	alice := decodeResponse[api.User](t, aliceResponse, http.StatusOK)
	aliceTag := aliceResponse.Header().Get("ETag")
	bobCookie := h.login(t, "cache-bob")
	bobResponse := conditionalMe(h, http.MethodGet, bobCookie, "", aliceTag)
	bob := decodeResponse[api.User](t, bobResponse, http.StatusOK)
	if bob.ID == alice.ID || bobResponse.Header().Get("ETag") == aliceTag || bobResponse.Header().Get("Daynight-User-ID") != bob.ID {
		t.Fatal("a replacement identity reused cached account content")
	}
	for _, response := range []*httptest.ResponseRecorder{
		conditionalMe(h, http.MethodGet, nil, "", aliceTag),
		conditionalMe(h, http.MethodGet, aliceCookie, "Bearer invalid", aliceTag),
	} {
		assertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
		if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("ETag") != "" {
			t.Fatal("authentication failure was cacheable")
		}
	}
	minted := decodeResponse[api.CreatedPersonalAccessToken](t, h.request(http.MethodPost, "/api/v1/me/tokens", `{"name":"cached-me","expiresAt":null}`, []*http.Cookie{aliceCookie}, nil, h.auth.origin), http.StatusCreated)
	bearer := "Bearer " + minted.Token
	if response := conditionalMe(h, http.MethodGet, bobCookie, bearer, aliceTag); response.Code != http.StatusNotModified || response.Header().Get("Daynight-User-ID") != alice.ID {
		t.Fatal("cache validation did not follow the authoritative bearer identity")
	}
	if response := h.request(http.MethodDelete, "/api/v1/me/tokens/"+minted.ID, "", []*http.Cookie{aliceCookie}, nil, h.auth.origin); response.Code != http.StatusNoContent {
		t.Fatalf("token revocation failed: %d", response.Code)
	}
	assertProjectError(t, conditionalMe(h, http.MethodGet, bobCookie, bearer, aliceTag), http.StatusUnauthorized, "unauthenticated")
	if _, err := h.database.Pool.Exec(t.Context(), `UPDATE sessions SET created_at=now()-interval '8 days',expires_at=now()-interval '1 second' WHERE user_id=$1`, alice.ID); err != nil {
		t.Fatal(err)
	}
	assertProjectError(t, conditionalMe(h, http.MethodGet, aliceCookie, "", aliceTag), http.StatusUnauthorized, "unauthenticated")
}

func TestIdentityHTTPMeCacheDoesNotHideUserReadFailure(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.login(t, "cache-read-failure")
	initial := conditionalMe(h, http.MethodGet, cookie, "", "")
	user := decodeResponse[api.User](t, initial, http.StatusOK)
	request := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	request.Header.Set("X-Request-ID", "project-test")
	request.Header.Set("If-None-Match", initial.Header().Get("ETag"))
	if _, err := h.database.Pool.Exec(t.Context(), "ALTER TABLE users RENAME TO unavailable_users"); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	RequestLogging(h.auth.logger, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.auth.me(w, r, model.Principal{UserID: user.ID})
	})).ServeHTTP(response, request)
	assertProjectError(t, response, http.StatusInternalServerError, "internal_error")
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("ETag") != "" {
		t.Fatal("a failed user read validated a cached profile")
	}
}
