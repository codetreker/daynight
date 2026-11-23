package auth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
)

func createHTTPPAT(t *testing.T, h *authHarness, cookie *http.Cookie, expiry *time.Time) api.CreatedPersonalAccessToken {
	t.Helper()
	return testsupport.DecodeResponse[api.CreatedPersonalAccessToken](t, createScopedHTTPPAT(t, h, cookie, "Editable token", expiry), 201)
}

func TestTokenExpiryHTTPCreateEditAndCurrentBearer(t *testing.T) {
	h := authTestHarness(t)
	cookie := h.Login(t, "editable-user")
	cookies := []*http.Cookie{cookie}
	user := testsupport.DecodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", cookies, nil, ""), 200)
	minted := createHTTPPAT(t, h, cookie, nil)
	if minted.ExpiresAt != nil {
		t.Fatal("manual token did not default to explicit no expiration")
	}
	deadline := time.Now().UTC().Add(time.Hour).Truncate(time.Microsecond)
	body := testsupport.JSONBody(t, map[string]any{"expiresAt": deadline, "expectedExpiresAt": nil, "expectedUserId": user.ID})
	response := h.Request("PATCH", "/api/v1/me/tokens/"+minted.ID, body, cookies, nil, h.Origin)
	changed := testsupport.DecodeResponse[api.PersonalAccessToken](t, response, 200)
	if changed.ID != minted.ID || changed.Name != minted.Name || changed.ExpiresAt == nil || !changed.ExpiresAt.Equal(deadline) || !changed.CreatedAt.Equal(minted.CreatedAt) {
		t.Fatal("expiry edit changed token identity or metadata")
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Daynight-User-ID") != user.ID {
		t.Fatal("token mutation lost cache or actual-principal boundary")
	}
	if !strings.Contains(response.Body.String(), `"expiresAt":"`+deadline.Format(time.RFC3339Nano)+`"`) {
		t.Fatal("token expiry response was not UTC")
	}
	bearer := []string{"Bearer " + minted.Token}
	if actual := testsupport.DecodeResponse[api.User](t, h.Request("GET", "/api/v1/me", "", nil, bearer, ""), 200); actual.ID != user.ID {
		t.Fatal("expiry edit invalidated original bearer")
	}
	var stored []byte
	if err := h.Database.Pool.QueryRow(context.Background(), `SELECT token_hash FROM personal_access_tokens WHERE id=$1`, minted.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	expectedHash := sha256.Sum256([]byte(minted.Token))
	if !bytes.Equal(stored, expectedHash[:]) {
		t.Fatal("expiry mutation changed secret hash")
	}
	testsupport.AssertProjectError(t, h.Request("PATCH", "/api/v1/me/tokens/"+minted.ID, body, cookies, nil, h.Origin), 409, "version_conflict")
	body = testsupport.JSONBody(t, map[string]any{"expiresAt": nil, "expectedExpiresAt": deadline, "expectedUserId": user.ID})
	removed := testsupport.DecodeResponse[api.PersonalAccessToken](t, h.Request("PATCH", "/api/v1/me/tokens/"+minted.ID, body, cookies, nil, h.Origin), 200)
	if removed.ExpiresAt != nil {
		t.Fatal("expiry removal failed")
	}
	noop := testsupport.JSONBody(t, map[string]any{"expiresAt": nil, "expectedExpiresAt": nil, "expectedUserId": user.ID})
	testsupport.DecodeResponse[api.PersonalAccessToken](t, h.Request("PATCH", "/api/v1/me/tokens/"+minted.ID, noop, cookies, nil, h.Origin), 200)
	finite := createHTTPPAT(t, h, cookie, &deadline)
	if finite.ExpiresAt == nil || !finite.ExpiresAt.Equal(deadline) {
		t.Fatal("finite token creation did not preserve selected future expiry")
	}
	listed := testsupport.DecodeResponse[api.PersonalAccessTokenList](t, h.Request("GET", "/api/v1/me/tokens", "", cookies, nil, ""), 200)
	if len(listed.Items) != 2 {
		t.Fatal("finite or nonexpiring token missing from management")
	}
	if strings.Contains(h.Logs.String(), minted.Token) || strings.Contains(h.Logs.String(), finite.Token) {
		t.Fatal("expiry management logged token secret")
	}
}

func expectPATExpiry(actor model.Principal, tokenID string, input identitycore.UpdatePATExpiry, result model.PersonalAccessToken, err error) authRequestCall {
	return authRequestCall{name: "UpdatePATExpiry", args: []any{actor, tokenID, input}, result: result, err: err}
}

func TestTokenExpiryResponseIncludesUsageTime(t *testing.T) {
	h := newStrictAuthHTTP(t)
	actor, _ := authRequestAccount(1)
	cookie := h.cookie(authAliceCookie)
	token := authRequestMintedPAT(actor, "Editable token").Credential
	zone := time.FixedZone("token storage", 2*60*60)
	used := time.Date(2026, 1, 2, 3, 4, 5, 654321000, zone)
	expiry := used.Add(time.Hour).UTC()
	token.CreatedAt = used.Add(-time.Hour)
	token.LastUsedAt = &used
	savedExpiry := expiry.In(zone)
	token.ExpiresAt = &savedExpiry
	input := identitycore.UpdatePATExpiry{ExpiresAt: &expiry, ExpectedUserID: actor.UserID}
	body := testsupport.JSONBody(t, map[string]any{"expiresAt": expiry, "expectedExpiresAt": nil, "expectedUserId": actor.UserID})
	patch := h.request("PATCH", "/api/v1/me/tokens/"+token.ID, body, []*http.Cookie{cookie}, nil, authRequestOrigin,
		expectAuthentication(actor, cookie.Value), expectPATExpiry(actor, token.ID, input, token, nil))
	var changed map[string]json.RawMessage
	if patch.Code != http.StatusOK || json.Unmarshal(patch.Body.Bytes(), &changed) != nil {
		t.Fatalf("patch: %d %s", patch.Code, patch.Body)
	}
	want := map[string]string{
		"id":         `"` + token.ID + `"`,
		"name":       `"` + token.Name + `"`,
		"createdAt":  `"` + token.CreatedAt.UTC().Format(time.RFC3339Nano) + `"`,
		"expiresAt":  `"` + expiry.Format(time.RFC3339Nano) + `"`,
		"lastUsedAt": `"` + used.UTC().Format(time.RFC3339Nano) + `"`,
	}
	if len(changed) != len(want) {
		t.Fatalf("unexpected metadata fields: %v", changed)
	}
	for field, value := range want {
		if string(changed[field]) != value {
			t.Fatalf("expiry response field %s=%s, want %s", field, changed[field], value)
		}
	}
	if patch.Header().Get("Cache-Control") != "no-store" || patch.Header().Get("Daynight-User-ID") != actor.UserID {
		t.Fatalf("expiry response cache or admission headers: %v", patch.Header())
	}
}

func TestTokenExpiryHTTPValidationOwnershipAndAccountSwitch(t *testing.T) {
	h := newStrictAuthHTTP(t)
	alice, _ := authRequestAccount(1)
	bob, _ := authRequestAccount(2)
	aliceCookie, bobCookie := h.cookie(authAliceCookie), h.cookie(authBobCookie)
	aliceCookies, bobCookies := []*http.Cookie{aliceCookie}, []*http.Cookie{bobCookie}
	aliceSession, bobSession := expectAuthentication(alice, aliceCookie.Value), expectAuthentication(bob, bobCookie.Value)
	minted := authRequestMintedPAT(alice, "Editable token")
	tokenID := minted.Credential.ID
	path := "/api/v1/me/tokens/" + tokenID
	future := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	input := identitycore.UpdatePATExpiry{ExpiresAt: &future, ExpectedUserID: alice.UserID}
	body := testsupport.JSONBody(t, map[string]any{"expiresAt": future, "expectedExpiresAt": nil, "expectedUserId": alice.UserID})
	switched := &model.Fault{Code: "forbidden", Message: "The signed-in account changed. Review the token again."}
	response := h.request("PATCH", path, body, bobCookies, nil, authRequestOrigin, bobSession,
		expectPATExpiry(bob, tokenID, input, model.PersonalAccessToken{}, switched))
	testsupport.AssertProjectError(t, response, http.StatusForbidden, "forbidden")
	if response.Header().Get("Daynight-User-ID") != bob.UserID {
		t.Fatal("account-switch rejection lost the admitted principal")
	}

	listed := testsupport.DecodeResponse[api.PersonalAccessTokenList](t,
		h.request("GET", "/api/v1/me/tokens", "", aliceCookies, nil, "", aliceSession,
			authRequestCall{name: "ListPATs", args: []any{alice}, result: []model.PersonalAccessToken{minted.Credential}}),
		http.StatusOK)
	if len(listed.Items) != 1 || listed.Items[0].ID != tokenID || listed.Items[0].ExpiresAt != nil {
		t.Fatal("changed account mutated reviewed credential")
	}

	for _, origin := range []string{"", "https://foreign.example"} {
		response := h.request("PATCH", path, body, aliceCookies, nil, origin, aliceSession)
		testsupport.AssertProjectError(t, response, http.StatusForbidden, "forbidden")
		if response.Header().Get("Daynight-User-ID") != "" {
			t.Fatal("rejected Origin advertised a principal")
		}
	}
	response = h.request("PATCH", path, body, nil, nil, authRequestOrigin)
	testsupport.AssertProjectError(t, response, http.StatusUnauthorized, "unauthenticated")
	pat := model.Principal{Kind: model.PATCredential, UserID: alice.UserID, CredentialID: tokenID}
	patRefusal := &model.Fault{Code: "forbidden", Message: "A main-site browser session is required for this operation."}
	response = h.request("PATCH", path, body, nil, []string{"Bearer " + minted.Secret}, "",
		expectAuthentication(pat, minted.Secret), expectPATExpiry(pat, tokenID, input, model.PersonalAccessToken{}, patRefusal))
	testsupport.AssertProjectError(t, response, http.StatusForbidden, "forbidden")

	notFound := &model.Fault{Code: "not_found", Message: "Active token was not found.", Cause: model.ErrNotFound}
	bodyOther := testsupport.JSONBody(t, map[string]any{"expiresAt": future, "expectedExpiresAt": nil, "expectedUserId": bob.UserID})
	response = h.request("PATCH", path, bodyOther, bobCookies, nil, authRequestOrigin, bobSession,
		expectPATExpiry(bob, tokenID, identitycore.UpdatePATExpiry{ExpiresAt: &future, ExpectedUserID: bob.UserID}, model.PersonalAccessToken{}, notFound))
	testsupport.AssertProjectError(t, response, http.StatusNotFound, "not_found")

	past := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	invalidInput := &model.Fault{Code: "invalid_input", Message: "Invalid token expiry input."}
	for _, test := range []struct {
		body      string
		delegated *identitycore.UpdatePATExpiry
	}{
		{body: `{}`},
		{body: `{"expiresAt":null}`},
		{body: `{"expiresAt":null,"expectedExpiresAt":null}`},
		{body: `{"expiresAt":null,"expectedExpiresAt":null,"expectedUserId":null}`},
		{body: `{"expiresAt":null,"expectedExpiresAt":null,"expectedUserId":"bad"}`, delegated: &identitycore.UpdatePATExpiry{ExpectedUserID: "bad"}},
		{body: `{"expiresAt":null,"expectedExpiresAt":7,"expectedUserId":"` + alice.UserID + `"}`},
		{body: `{"expiresAt":false,"expectedExpiresAt":null,"expectedUserId":"` + alice.UserID + `"}`},
		{body: `{"expiresAt":"invalidZ","expectedExpiresAt":null,"expectedUserId":"` + alice.UserID + `"}`},
		{body: `{"expiresAt":"2030-01-01T00:00:00+00:00","expectedExpiresAt":null,"expectedUserId":"` + alice.UserID + `"}`},
		{body: `{"expiresAt":"2020-01-01T00:00:00Z","expectedExpiresAt":null,"expectedUserId":"` + alice.UserID + `"}`,
			delegated: &identitycore.UpdatePATExpiry{ExpiresAt: &past, ExpectedUserID: alice.UserID}},
		{body: `{"expiresAt":null,"expectedExpiresAt":null,"expectedUserId":"` + alice.UserID + `","extra":true}`},
	} {
		calls := []authRequestCall{aliceSession}
		if test.delegated != nil {
			calls = append(calls, expectPATExpiry(alice, tokenID, *test.delegated, model.PersonalAccessToken{}, invalidInput))
		}
		response := h.request("PATCH", path, test.body, aliceCookies, nil, authRequestOrigin, calls...)
		testsupport.AssertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	}
	for _, test := range []struct {
		body      string
		delegated *identitycore.CreatePAT
	}{
		{body: `{"name":"missing"}`},
		{body: `{"name":"legacy","days":30}`},
		{body: `{"name":"bad","expiresAt":7}`},
		{body: `{"name":"bad","expiresAt":"2020-01-01T00:00:00Z"}`, delegated: &identitycore.CreatePAT{Name: "bad", ExpiresAt: &past}},
		{body: `{"name":"bad","expiresAt":"2030-01-01T00:00:00+08:00"}`},
	} {
		calls := []authRequestCall{aliceSession}
		if test.delegated != nil {
			calls = append(calls, authRequestCall{name: "CreatePAT", args: []any{alice, *test.delegated}, err: invalidInput})
		}
		response := h.request("POST", "/api/v1/me/tokens", test.body, aliceCookies, nil, authRequestOrigin, calls...)
		testsupport.AssertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	}

	response = h.request("PATCH", "/api/v1/me/tokens/invalid", body, aliceCookies, nil, authRequestOrigin, aliceSession,
		expectPATExpiry(alice, "invalid", input, model.PersonalAccessToken{}, invalidInput))
	testsupport.AssertProjectError(t, response, http.StatusBadRequest, "invalid_input")
	const missingID = "40000000-0000-4000-8000-000000000099"
	response = h.request("PATCH", "/api/v1/me/tokens/"+missingID, body, aliceCookies, nil, authRequestOrigin, aliceSession,
		expectPATExpiry(alice, missingID, input, model.PersonalAccessToken{}, notFound))
	testsupport.AssertProjectError(t, response, http.StatusNotFound, "not_found")

	response = h.request("GET", path, "", aliceCookies, nil, "", aliceSession)
	if response.Code != http.StatusMethodNotAllowed || response.Header().Get("Allow") != "PATCH, DELETE" {
		t.Fatal("token metadata method contract changed")
	}
	response = h.request("DELETE", path, "", aliceCookies, nil, authRequestOrigin, aliceSession,
		authRequestCall{name: "RevokePAT", args: []any{alice, tokenID}})
	if response.Code != http.StatusNoContent || response.Body.Len() != 0 || response.Header().Get("Daynight-User-ID") != alice.UserID {
		t.Fatalf("token revocation response: status=%d headers=%v", response.Code, response.Header())
	}
	response = h.request("PATCH", path, body, aliceCookies, nil, authRequestOrigin, aliceSession,
		expectPATExpiry(alice, tokenID, input, model.PersonalAccessToken{}, notFound))
	testsupport.AssertProjectError(t, response, http.StatusNotFound, "not_found")
}

func TestTokenExpiryHTTPExpiredAndOperationalFailure(t *testing.T) {
	h := newStrictAuthHTTP(t)
	actor, _ := authRequestAccount(1)
	cookie := h.cookie(authAliceCookie)
	cookies := []*http.Cookie{cookie}
	admit := expectAuthentication(actor, cookie.Value)
	tokenID := authRequestMintedPAT(actor, "Editable token").Credential.ID
	path := "/api/v1/me/tokens/" + tokenID
	input := identitycore.UpdatePATExpiry{ExpectedUserID: actor.UserID}
	body := testsupport.JSONBody(t, map[string]any{"expiresAt": nil, "expectedExpiresAt": nil, "expectedUserId": actor.UserID})
	expired := &model.Fault{Code: "not_found", Message: "Active token was not found.", Cause: model.ErrNotFound}
	response := h.request("PATCH", path, body, cookies, nil, authRequestOrigin, admit,
		expectPATExpiry(actor, tokenID, input, model.PersonalAccessToken{}, expired))
	testsupport.AssertProjectError(t, response, http.StatusNotFound, "not_found")

	h.logs.Reset()
	response = h.request("PATCH", path, body, cookies, nil, authRequestOrigin, admit,
		expectPATExpiry(actor, tokenID, input, model.PersonalAccessToken{}, authMissingRelation("lock active token")))
	testsupport.AssertProjectError(t, response, http.StatusInternalServerError, "internal_error")
	if !strings.Contains(h.logs.String(), `"cause":"database"`) || response.Header().Get("Daynight-User-ID") != actor.UserID ||
		response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("operational expiry failure lost classification or admission headers: %v", response.Header())
	}
}
