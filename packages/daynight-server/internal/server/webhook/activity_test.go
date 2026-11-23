package webhook

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
)

func TestWebhookDispatchedBrowserActivity(t *testing.T) {
	base := "/api/v1/me/webhooks/" + endpointID
	redelivery := fmt.Sprintf(`{"operationId":"%s","issuedAt":"2026-11-07T08:00:00.123400Z","expectedUserId":"%s","ifVersion":"1","ifGeneration":"4"}`, operationID, userID)
	for _, tc := range []struct {
		method, path, body string
		status             int
		active             bool
	}{
		{"GET", base, "", 200, true}, {"HEAD", base, "", 200, true},
		{"GET", base + "/signing-secret", "", 200, true}, {"HEAD", base + "/signing-secret", "", 200, true},
		{"GET", "/api/v1/me/webhooks/operations/" + operationID, "", 200, true},
		{"GET", base + "/deliveries", "", 200, true}, {"HEAD", base + "/deliveries", "", 200, true},
		{"GET", base + "/deliveries/" + deliveryID, "", 200, true},
		{"GET", base + "/deliveries/" + deliveryID + "/attempts", "", 200, true},
		{"GET", base + "/deliveries/" + deliveryID + "/payload", "", 200, true},
		{"POST", base + "/deliveries/" + deliveryID + "/redeliveries", redelivery, 202, true},
		{"POST", base, "", 405, false}, {"POST", base + "/signing-secret", "", 405, false},
		{"POST", base + "/deliveries", "", 405, false},
		{"HEAD", base + "/deliveries/" + deliveryID + "/redeliveries", "", 405, false},
		{"GET", base + "/signing-secret/rotations", "", 405, false},
	} {
		t.Run(tc.method+tc.path, func(t *testing.T) {
			reads, touches := 0, 0
			p := model.Principal{Kind: model.SessionCredential, UserID: userID, CredentialID: operationID}
			auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, secret string) (model.Principal, error) {
				reads++
				if kind != model.SessionCredential || secret != "original" {
					t.Fatal("read credential changed")
				}
				return p, nil
			}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, slog.Default())
			if err != nil {
				t.Fatal(err)
			}
			auth.BindBrowserActivity(func(_ context.Context, secret, expected string) (model.Principal, error) {
				touches++
				if secret != "original" || expected != "" {
					t.Fatal("activity credential changed")
				}
				return p, nil
			})
			s := &historyFake{}
			mux := http.NewServeMux()
			(&Routes{service: s, auth: auth, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}).RegisterRoutes(mux)
			r := httptest.NewRequest(tc.method, "https://daynight.example"+tc.path, strings.NewReader(tc.body))
			r.Header.Set("Origin", auth.Origin())
			r.Header.Set("Sec-Fetch-Site", "same-origin")
			r.Header.Set("Sec-Fetch-Mode", "cors")
			r.Header.Set("Sec-Fetch-Dest", "empty")
			r.Header.Set("Content-Type", "application/json")
			r.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: "original"})
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			want := map[bool]int{true: 1, false: 0}[tc.active]
			if w.Code != tc.status || touches != want || reads != 1-want || s.calls != want || len(w.Result().Cookies()) != 0 {
				t.Fatalf("HTTP %d reads=%d touches=%d business=%d body=%s", w.Code, reads, touches, s.calls, w.Body)
			}
		})
	}
}
