package auth

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
)

func TestCookieOriginPrecedesActivityForBothBrowserEntries(t *testing.T) {
	const origin = "https://daynight.test"
	for _, browserOnly := range []bool{false, true} {
		for _, tc := range []struct {
			name, method string
			origins      []string
			invalid      bool
			status       int
			active       bool
		}{
			{name: "missing", method: http.MethodPatch, status: 403},
			{name: "empty", method: http.MethodPatch, origins: []string{""}, status: 403},
			{name: "duplicate", method: http.MethodPatch, origins: []string{origin, origin}, status: 403},
			{name: "mismatched", method: http.MethodPatch, origins: []string{"https://other.test"}, status: 403},
			{name: "failed_authentication", method: http.MethodPatch, invalid: true, status: 401},
			{name: "valid", method: http.MethodPatch, origins: []string{origin}, status: 204, active: true},
			{name: "metadata_only_read", method: http.MethodGet, status: 204, active: true},
		} {
			t.Run(map[bool]string{true: "browser_only/", false: "general/"}[browserOnly]+tc.name, func(t *testing.T) {
				principal := model.Principal{Kind: model.SessionCredential, UserID: "10000000-0000-4000-8000-000000000001", CredentialID: "20000000-0000-4000-8000-000000000001"}
				reads, touches, business := 0, 0, 0
				h, err := NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) {
					reads++
					if tc.invalid {
						return model.Principal{}, Failure()
					}
					return principal, nil
				}, authconfig.AuthSettings{PublicOrigin: origin}, slog.Default())
				if err != nil {
					t.Fatal(err)
				}
				h.BindBrowserActivity(func(context.Context, string, string) (model.Principal, error) {
					touches++
					return principal, nil
				})
				next := func(w http.ResponseWriter, _ *http.Request, p model.Principal) {
					business++
					if p != principal {
						t.Fatal("principal changed")
					}
					w.WriteHeader(http.StatusNoContent)
				}
				handler := h.Require(next)
				if browserOnly {
					handler = h.RequireCredentialSession(next)
				}
				r := httptest.NewRequest(tc.method, origin+"/api/v2/me/tokens/description", nil)
				r.Pattern = tc.method + " /api/v2/me/tokens/description"
				for _, value := range tc.origins {
					r.Header.Add("Origin", value)
				}
				r.Header.Set("Sec-Fetch-Site", "same-origin")
				r.Header.Set("Sec-Fetch-Mode", "cors")
				r.Header.Set("Sec-Fetch-Dest", "empty")
				r.AddCookie(&http.Cookie{Name: h.SessionCookieName(), Value: "original"})
				w := httptest.NewRecorder()
				handler(w, r)
				if w.Code != tc.status || reads != map[bool]int{true: 0, false: 1}[tc.active] || touches != map[bool]int{true: 1, false: 0}[tc.active] || business != map[bool]int{true: 1, false: 0}[tc.active] {
					t.Fatalf("HTTP %d reads=%d touches=%d business=%d", w.Code, reads, touches, business)
				}
			})
		}
	}
}
