package preview

import (
	"context"
	"errors"
	"html"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestStartAfterLogin(t *testing.T) {
	const target = "https://daynight.test/auth/complete?callbackPath=%2Fcallback&returnPath=%2Fprojects%3Fview%3D1%23part"
	for _, fail := range []bool{false, true} {
		calls := 0
		h, _, _ := fixture(t, &operations{create: func(_ context.Context, got string) (model.PreviewSSOLogin, error) {
			calls++
			if got != target {
				t.Fatalf("lost completion target: %q", got)
			}
			if fail {
				return model.PreviewSSOLogin{}, errors.New("private storage failure")
			}
			return model.PreviewSSOLogin{ID: "42a412e3-7a2a-4c15-9350-d0ba7ea58e81"}, nil
		}}, true)
		w := httptest.NewRecorder()
		h.StartAfterLogin(w, httptest.NewRequest(http.MethodGet, "https://daynight.test/callback", nil), target)
		if calls != 1 || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("Referrer-Policy") != "no-referrer" {
			t.Fatalf("calls=%d headers=%v", calls, w.Header())
		}
		if fail {
			if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), "https://preview.daynight.test/auth/sso/start") || !strings.Contains(w.Body.String(), `href="`+html.EscapeString(target)+`"`) || strings.Contains(w.Body.String(), "private storage failure") {
				t.Fatalf("failure: %d %s", w.Code, w.Body.String())
			}
		} else if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "https://preview.daynight.test/auth/sso/start?login=42a412e3-7a2a-4c15-9350-d0ba7ea58e81" {
			t.Fatalf("redirect: %d %s", w.Code, w.Header().Get("Location"))
		}
	}
}

func TestLoginFailureNeverOffersExternalContinuation(t *testing.T) {
	h, _, _ := fixture(t, &operations{create: func(context.Context, string) (model.PreviewSSOLogin, error) {
		return model.PreviewSSOLogin{}, errors.New("outcome unknown")
	}}, true)
	for _, target := range []string{"https://other.example/auth/complete?returnPath=%2Fprojects", "https://daynight.test/auth/complete#fragment", "https://daynight.test/auth/sso/start"} {
		w := httptest.NewRecorder()
		h.StartAfterLogin(w, httptest.NewRequest(http.MethodGet, "https://daynight.test/callback", nil), target)
		if strings.Contains(w.Body.String(), "Continue to your original destination") || strings.Contains(w.Body.String(), "other.example") {
			t.Fatalf("unsafe continuation was offered: %s", w.Body.String())
		}
	}
}
