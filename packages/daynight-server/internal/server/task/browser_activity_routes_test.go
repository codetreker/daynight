package task

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
)

func TestLegacyTaskSearchActivityDistinguishesMethodRefusals(t *testing.T) {
	principal := model.Principal{Kind: model.SessionCredential, UserID: "account", CredentialID: "session"}
	reads, touches, searches := 0, 0, 0
	auth, err := authhttp.NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) {
		reads++
		return principal, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.test"}, slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	auth.BindBrowserActivity(func(context.Context, string, string) (model.Principal, error) {
		touches++
		return principal, nil
	})
	mux := http.NewServeMux()
	TaskSearchRoutes(mux, func(_ context.Context, p model.Principal, project string, input tasksearch.Request) (tasksearch.Page, error) {
		searches++
		if p != principal || project != searchTestID || input.Query != "active" {
			t.Fatal("search lost authenticated input")
		}
		return tasksearch.Page{ProjectID: project, Items: []tasksearch.Item{}}, nil
	}, auth, slog.Default())
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPatch, http.MethodDelete, http.MethodPost} {
		r := httptest.NewRequest(method, "https://daynight.test/api/v1/projects/"+searchTestID+"/tasks/search", strings.NewReader(`{"query":"active"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Origin", auth.Origin())
		r.Header.Set("Sec-Fetch-Site", "same-origin")
		r.Header.Set("Sec-Fetch-Mode", "cors")
		r.Header.Set("Sec-Fetch-Dest", "empty")
		r.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: "original"})
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		want := http.StatusMethodNotAllowed
		if method == http.MethodPost {
			want = http.StatusOK
		}
		if w.Code != want {
			t.Fatalf("%s: HTTP %d: %s", method, w.Code, w.Body)
		}
	}
	if reads != 4 || touches != 1 || searches != 1 {
		t.Fatalf("reads=%d touches=%d searches=%d", reads, touches, searches)
	}
}
