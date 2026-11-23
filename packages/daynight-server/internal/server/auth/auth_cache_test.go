package auth

import (
	"bytes"
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
	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	"github.com/jackc/pgx/v5/pgconn"
)

func conditionalMe(h *strictAuthHTTP, method string, cookie *http.Cookie, authorization, validator string, pending ...authRequestCall) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "/api/v1/me", nil)
	if cookie != nil {
		request.AddCookie(cookie)
	}
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	request.Header.Set("If-None-Match", validator)
	return h.serve(request, pending...)
}

func requireMeProfile(t *testing.T, response *httptest.ResponseRecorder, user model.User) string {
	t.Helper()
	payload, err := json.Marshal(api.User{
		ID: user.ID, Email: user.Email, EmailVerified: user.EmailVerified, Name: user.Name, AvatarURL: user.AvatarURL,
		PersonalTeam: api.TeamRef{ID: user.PersonalTeam.ID, Kind: user.PersonalTeam.Kind, Name: user.PersonalTeam.Name},
	})
	if err != nil {
		t.Fatal(err)
	}
	payload = append(payload, '\n')
	digest := sha256.Sum256(payload)
	etag := `"` + hex.EncodeToString(digest[:]) + `"`
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), payload) ||
		response.Header().Get("Daynight-User-ID") != user.ID || response.Header().Get("Cache-Control") != "private, no-cache" ||
		response.Header().Get("Content-Type") != "application/json" || response.Header().Get("Content-Length") != strconv.Itoa(len(payload)) ||
		response.Header().Get("ETag") != etag {
		t.Fatalf("incorrect profile response for %q: status=%d headers=%v body bytes=%d want %d", user.ID, response.Code, response.Header(), response.Body.Len(), len(payload))
	}
	return etag
}

func requireUnchangedMe(t *testing.T, response *httptest.ResponseRecorder, userID, etag string) {
	t.Helper()
	if response.Code != http.StatusNotModified || response.Body.Len() != 0 ||
		response.Header().Get("Daynight-User-ID") != userID || response.Header().Get("Cache-Control") != "private, no-cache" ||
		response.Header().Get("ETag") != etag {
		t.Fatalf("incorrect unchanged profile response: status=%d headers=%v body bytes=%d", response.Code, response.Header(), response.Body.Len())
	}
}

func requireUncacheableMeError(t *testing.T, response *httptest.ResponseRecorder, status int, code, admittedUserID string) {
	t.Helper()
	testsupport.AssertProjectError(t, response, status, code)
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("ETag") != "" ||
		response.Header().Get("Daynight-User-ID") != admittedUserID {
		t.Fatalf("profile error has incorrect cache or identity headers: %v", response.Header())
	}
}

func TestIdentityHTTPMeCacheTracksProfileContent(t *testing.T) {
	h := newStrictAuthHTTP(t)
	actor, profile := authRequestAccount(1)
	cookie := h.cookie(authAliceCookie)
	initial := conditionalMe(h, http.MethodGet, cookie, "", "", expectAuthentication(actor, cookie.Value), expectUser(actor, profile))
	etag := requireMeProfile(t, initial, profile)
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		unchanged := conditionalMe(h, method, cookie, "", etag, expectAuthentication(actor, cookie.Value), expectUser(actor, profile))
		requireUnchangedMe(t, unchanged, actor.UserID, etag)
	}

	cookie = h.cookie(authReplacementCookie)
	actor.CredentialID = "20000000-0000-4000-8000-000000000099"
	admit := expectAuthentication(actor, cookie.Value)
	unchanged := conditionalMe(h, http.MethodGet, cookie, "", etag, admit, expectUser(actor, profile))
	requireUnchangedMe(t, unchanged, actor.UserID, etag)

	name := "Updated <&> 中文"
	avatar := "data:image/png;base64," + strings.Repeat("AAAA", 60_000)
	email := "changed@example.test"
	verified := true
	for _, change := range []struct {
		field  string
		mutate func(*model.User)
	}{
		{"name", func(u *model.User) { u.Name = &name }},
		{"avatar_url", func(u *model.User) { u.AvatarURL = &avatar }},
		{"email", func(u *model.User) { u.Email = &email }},
		{"email_verified", func(u *model.User) { u.EmailVerified = &verified }},
		{"name to null", func(u *model.User) { u.Name = nil }},
		{"avatar_url to null", func(u *model.User) { u.AvatarURL = nil }},
		{"email to null", func(u *model.User) { u.Email = nil }},
		{"email_verified to null", func(u *model.User) { u.EmailVerified = nil }},
	} {
		change.mutate(&profile)
		response := conditionalMe(h, http.MethodGet, cookie, "", etag, admit, expectUser(actor, profile))
		next := requireMeProfile(t, response, profile)
		if next == etag {
			t.Fatalf("%s change did not invalidate content", change.field)
		}
		etag = next
		unchanged := conditionalMe(h, http.MethodGet, cookie, "", etag, admit, expectUser(actor, profile))
		requireUnchangedMe(t, unchanged, actor.UserID, etag)
	}
}

func TestIdentityHTTPMeCacheNeverReplacesAuthentication(t *testing.T) {
	h := newStrictAuthHTTP(t)
	alice, aliceProfile := authRequestAccount(1)
	bob, bobProfile := authRequestAccount(2)
	aliceCookie, bobCookie := h.cookie(authAliceCookie), h.cookie(authBobCookie)
	aliceAdmission := expectAuthentication(alice, aliceCookie.Value)
	aliceResponse := conditionalMe(h, http.MethodGet, aliceCookie, "", "", aliceAdmission, expectUser(alice, aliceProfile))
	aliceTag := requireMeProfile(t, aliceResponse, aliceProfile)
	bobResponse := conditionalMe(h, http.MethodGet, bobCookie, "", aliceTag, expectAuthentication(bob, bobCookie.Value), expectUser(bob, bobProfile))
	if bobTag := requireMeProfile(t, bobResponse, bobProfile); bobTag == aliceTag {
		t.Fatal("a replacement identity reused cached account content")
	}
	for _, response := range []*httptest.ResponseRecorder{
		conditionalMe(h, http.MethodGet, nil, "", aliceTag),
		conditionalMe(h, http.MethodGet, aliceCookie, "Bearer invalid", aliceTag, expectRejectedCredential(model.PATCredential, "invalid")),
	} {
		requireUncacheableMeError(t, response, http.StatusUnauthorized, "unauthenticated", "")
	}

	mintedFact := authRequestMintedPAT(alice, "cached-me")
	minted := testsupport.DecodeResponse[api.CreatedPersonalAccessToken](t,
		h.request(http.MethodPost, "/api/v1/me/tokens", `{"name":"cached-me","expiresAt":null}`, []*http.Cookie{aliceCookie}, nil, authRequestOrigin,
			aliceAdmission, authRequestCall{name: "CreatePAT", args: []any{alice, identitycore.CreatePAT{Name: "cached-me"}}, result: mintedFact}),
		http.StatusCreated)
	if minted.ID != mintedFact.Credential.ID || minted.Token != mintedFact.Secret {
		t.Fatal("mint response changed the PAT")
	}
	pat := model.Principal{Kind: model.PATCredential, UserID: alice.UserID, CredentialID: minted.ID}
	bearer := "Bearer " + minted.Token
	unchanged := conditionalMe(h, http.MethodGet, bobCookie, bearer, aliceTag, expectAuthentication(pat, minted.Token), expectUser(pat, aliceProfile))
	requireUnchangedMe(t, unchanged, alice.UserID, aliceTag)
	revoked := h.request(http.MethodDelete, "/api/v1/me/tokens/"+minted.ID, "", []*http.Cookie{aliceCookie}, nil, authRequestOrigin,
		aliceAdmission, authRequestCall{name: "RevokePAT", args: []any{alice, minted.ID}})
	if revoked.Code != http.StatusNoContent || revoked.Body.Len() != 0 || revoked.Header().Get("Daynight-User-ID") != alice.UserID {
		t.Fatalf("token revocation response: status=%d headers=%v", revoked.Code, revoked.Header())
	}
	refused := conditionalMe(h, http.MethodGet, bobCookie, bearer, aliceTag, expectRejectedCredential(model.PATCredential, minted.Token))
	requireUncacheableMeError(t, refused, http.StatusUnauthorized, "unauthenticated", "")
	expired := conditionalMe(h, http.MethodGet, aliceCookie, "", aliceTag, expectRejectedCredential(model.SessionCredential, aliceCookie.Value))
	requireUncacheableMeError(t, expired, http.StatusUnauthorized, "unauthenticated", "")
}

func TestIdentityHTTPMeCacheDoesNotHideUserReadFailure(t *testing.T) {
	h := newStrictAuthHTTP(t)
	actor, profile := authRequestAccount(1)
	cookie := h.cookie(authAliceCookie)
	admit := expectAuthentication(actor, cookie.Value)
	initial := conditionalMe(h, http.MethodGet, cookie, "", "", admit, expectUser(actor, profile))
	etag := requireMeProfile(t, initial, profile)
	cause := &store.Error{
		Phase: "read user", DatabaseFailure: true, SQLState: "42P01",
		Cause: &pgconn.PgError{Code: "42P01", Message: "user relation is missing"},
	}
	response := conditionalMe(h, http.MethodGet, cookie, "", etag, admit,
		authRequestCall{name: "User", args: []any{actor}, err: cause})
	requireUncacheableMeError(t, response, http.StatusInternalServerError, "internal_error", actor.UserID)
	if !strings.Contains(h.logs.String(), `"cause":"database"`) {
		t.Fatal("User read failure lost its operational classification")
	}
}

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
	auth := &Authentication{RequestAuthentication: &RequestAuthentication{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}}
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
