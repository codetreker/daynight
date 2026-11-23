package bot_test

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	bothttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/bot"
)

func TestBotDetailDispatchedBrowserActivity(t *testing.T) {
	for _, method := range []string{"GET", "HEAD", "DELETE", "POST", "PATCH", "OPTIONS"} {
		t.Run(method, func(t *testing.T) {
			p := defaultHTTPPrincipal()
			p.Kind = model.SessionCredential
			f := &botDefinitionsFixture{t: t, principal: p}
			reads, touches := 0, 0
			verify := func(ctx context.Context, secret string) (model.Principal, error) {
				f.authCalls++
				f.requestContext = ctx
				if secret != "original" {
					t.Fatal("credential changed")
				}
				return p, nil
			}
			auth, err := authhttp.NewRequestAuthentication(func(ctx context.Context, kind model.CredentialKind, secret string) (model.Principal, error) {
				reads++
				if kind != model.SessionCredential {
					t.Fatal("credential kind changed")
				}
				return verify(ctx, secret)
			}, authconfig.AuthSettings{PublicOrigin: botExpiryOrigin}, slog.Default())
			if err != nil {
				t.Fatal(err)
			}
			auth.BindBrowserActivity(func(ctx context.Context, secret, expected string) (model.Principal, error) {
				touches++
				if expected != "" {
					t.Fatal("unexpected account binding")
				}
				return verify(ctx, secret)
			})
			active := method == "GET" || method == "HEAD" || method == "DELETE"
			body := ""
			status := http.StatusMethodNotAllowed
			if active {
				status = http.StatusNotFound
				f.want = &botDefinitionCall{method: "Get", id: botDefinitionsID, err: &model.Fault{Code: "not_found", Message: "Bot not found."}}
				if method == "DELETE" {
					body = `{"ifVersion":"1","deletionId":"` + botDefinitionsIntent + `"}`
					f.want = &botDefinitionCall{method: "DeleteBot", id: botDefinitionsID, input: store.DeleteBot{Version: 1, DeletionID: botDefinitionsIntent}, err: &model.Fault{Code: "not_found", Message: "Bot not found."}}
				}
			}
			mux := http.NewServeMux()
			bothttp.RegisterRoutes(mux, f, f, &authhttp.Authentication{RequestAuthentication: auth}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			r := httptest.NewRequest(method, botExpiryOrigin+botDefinitionsPath, strings.NewReader(body))
			r = r.WithContext(context.WithValue(r.Context(), botDefinitionRequestKey{}, f))
			r.Header.Set("Origin", auth.Origin())
			r.Header.Set("Sec-Fetch-Site", "same-origin")
			r.Header.Set("Sec-Fetch-Mode", "cors")
			r.Header.Set("Sec-Fetch-Dest", "empty")
			r.Header.Set("Content-Type", "application/json")
			r.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: "original"})
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			want := map[bool]int{true: 1, false: 0}[active]
			if w.Code != status || touches != want || reads != 1-want || f.want != nil || len(w.Result().Cookies()) != 0 {
				t.Fatalf("HTTP %d reads=%d touches=%d pending=%v body=%s", w.Code, reads, touches, f.want, w.Body)
			}
		})
	}
}
