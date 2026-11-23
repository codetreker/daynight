package preview

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestPreviewActivitySourceMatrix(t *testing.T) {
	for _, tc := range []struct {
		name, method, site, mode, dest, user, origin string
		active                                       bool
	}{
		{name: "same_origin_fetch", method: "GET", site: "same-origin", mode: "cors", dest: "empty", active: true},
		{name: "same_origin_image", method: "GET", site: "same-origin", mode: "no-cors", dest: "image", active: true},
		{name: "same_origin_head", method: "HEAD", site: "same-origin", mode: "cors", dest: "empty", active: true},
		{name: "same_site_iframe", method: "GET", site: "same-site", mode: "navigate", dest: "iframe", active: true},
		{name: "same_site_image", method: "GET", site: "same-site", mode: "no-cors", dest: "image"},
		{name: "cross_site_iframe", method: "GET", site: "cross-site", mode: "navigate", dest: "iframe"},
		{name: "cross_site_automatic", method: "GET", site: "cross-site", mode: "navigate", dest: "document"},
		{name: "cross_site_user", method: "GET", site: "cross-site", mode: "navigate", dest: "document", user: "?1", active: true},
		{name: "direct_user", method: "GET", site: "none", mode: "navigate", dest: "document", user: "?1", active: true},
		{name: "same_site_user", method: "GET", site: "same-site", mode: "navigate", dest: "document", user: "?1", active: true},
		{name: "missing_metadata", method: "GET"},
		{name: "incomplete_metadata", method: "GET", site: "same-origin", mode: "cors"},
		{name: "wrong_origin", method: "GET", site: "same-origin", mode: "cors", dest: "empty", origin: "https://evil.test"},
		{name: "null_origin", method: "GET", site: "same-origin", mode: "cors", dest: "empty", origin: "null"},
		{name: "invalid_destination", method: "GET", site: "same-origin", mode: "no-cors", dest: "banana"},
		{name: "cors_image", method: "GET", site: "same-origin", mode: "cors", dest: "image", active: true},
		{name: "cors_script", method: "GET", site: "same-origin", mode: "cors", dest: "script", active: true},
		{name: "same_origin_worker", method: "GET", site: "same-origin", mode: "same-origin", dest: "worker", active: true},
		{name: "contradictory_mode_destination", method: "GET", site: "same-origin", mode: "cors", dest: "document"},
		{name: "same_site_user_iframe", method: "GET", site: "same-site", mode: "navigate", dest: "iframe", user: "?1", active: true},
		{name: "contradictory_user_fetch", method: "GET", site: "same-origin", mode: "cors", dest: "empty", user: "?1"},
		{name: "head_navigation", method: "HEAD", site: "same-site", mode: "navigate", dest: "iframe"},
		{name: "invalid_user", method: "GET", site: "cross-site", mode: "navigate", dest: "document", user: "?0"},
		{name: "post_refusal", method: "POST", site: "same-origin", mode: "cors", dest: "empty"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			principal := model.Principal{Kind: model.SessionCredential, UserID: "account", CredentialID: "session"}
			renewed := 0
			ops := &operations{authenticate: func(context.Context, string) (model.Principal, time.Time, error) { return principal, time.Time{}, nil }, renew: func(_ context.Context, value string, p model.Principal) error {
				renewed++
				if value != "original" || p != principal {
					t.Fatal("renewal lost credential")
				}
				return nil
			}}
			var routes *Routes
			routes, handler := taskFixture(t, ops, func(w http.ResponseWriter, r *http.Request, p model.Principal) {
				if err := routes.RenewAuthorized(r, p); err != nil {
					t.Fatal(err)
				}
				w.WriteHeader(http.StatusOK)
			})
			r := httptest.NewRequest(tc.method, taskOrigin+taskPath, nil)
			r.AddCookie(&http.Cookie{Name: routes.SessionCookieName(), Value: "original"})
			for key, value := range map[string]string{"Sec-Fetch-Site": tc.site, "Sec-Fetch-Mode": tc.mode, "Sec-Fetch-Dest": tc.dest, "Sec-Fetch-User": tc.user, "Origin": tc.origin} {
				if value != "" {
					r.Header.Set(key, value)
				}
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			want := http.StatusOK
			if tc.method == "POST" {
				want = http.StatusMethodNotAllowed
			}
			if w.Code != want || renewed != map[bool]int{true: 1, false: 0}[tc.active] || len(w.Result().Cookies()) != 0 {
				t.Fatalf("status=%d renewed=%d cookies=%v", w.Code, renewed, w.Result().Cookies())
			}
		})
	}
}

func TestPreviewActivityRetainsOriginalCredentialAndErrors(t *testing.T) {
	principal := model.Principal{Kind: model.SessionCredential, UserID: "account", CredentialID: "session"}
	cause := errors.New("renewal commit unavailable")
	ops := &operations{authenticate: func(context.Context, string) (model.Principal, time.Time, error) { return principal, time.Time{}, nil }, renew: func(_ context.Context, value string, p model.Principal) error {
		if value != "original" || p != principal {
			t.Fatal("renewal lost originally authenticated secret")
		}
		return cause
	}}
	var routes *Routes
	routes, handler := taskFixture(t, ops, func(w http.ResponseWriter, r *http.Request, p model.Principal) {
		r.Header.Set("Cookie", routes.SessionCookieName()+"=replacement")
		if err := routes.RenewAuthorized(r, p); err != cause {
			t.Fatalf("renewal error=%v", err)
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	r := httptest.NewRequest("GET", taskOrigin+taskPath, nil)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	r.Header.Set("Sec-Fetch-Mode", "cors")
	r.Header.Set("Sec-Fetch-Dest", "empty")
	r.AddCookie(&http.Cookie{Name: routes.SessionCookieName(), Value: "original"})
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d", w.Code)
	}
}

func TestPreviewActivityRejectsDuplicateMetadata(t *testing.T) {
	h, _, _ := fixture(t, &operations{}, false)
	for _, name := range []string{"Origin", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest", "Sec-Fetch-User"} {
		r := httptest.NewRequest("GET", taskOrigin+taskPath, nil)
		r.SetPathValue("taskId", taskID)
		r.Header.Set("Sec-Fetch-Site", "same-origin")
		r.Header.Set("Sec-Fetch-Mode", "cors")
		r.Header.Set("Sec-Fetch-Dest", "empty")
		r.Header.Set(name, "same-origin")
		r.Header.Add(name, "same-origin")
		if h.admitsActivity(r) {
			t.Fatalf("accepted duplicate %s", name)
		}
	}
}
