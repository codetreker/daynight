package preview

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestErrorPagesAllowConfiguredMainAndTaskAncestors(t *testing.T) {
	for _, tc := range []struct{ main, preview, ancestors string }{
		{"https://daynight.example", "https://preview.daynight.example", "'self' https://daynight.example https://*.preview.daynight.example"},
		{"http://daynight.test:8080", "http://preview.daynight.test:8081", "'self' http://daynight.test:8080 http://*.preview.daynight.test:8081"},
		{"http://127.0.0.1:8080", "http://127.0.0.1:8081", "'self' http://127.0.0.1:8080"},
		{"http://[::1]:8080", "http://[::1]:8081", "'self' http://[::1]:8080"},
	} {
		t.Run(tc.preview, func(t *testing.T) {
			h, err := New(&operations{}, func(*http.Request) (model.Principal, error) {
				t.Fatal("unexpected authentication")
				return model.Principal{}, nil
			}, tc.main, tc.preview, slog.New(slog.NewTextHandler(io.Discard, nil)))
			if err != nil {
				t.Fatal(err)
			}
			for _, page := range []string{"sso", "document"} {
				w := httptest.NewRecorder()
				r := httptest.NewRequest("GET", tc.preview+"/failure", nil)
				if page == "sso" {
					h.failure(w, r, "callback", http.StatusUnauthorized, "unauthenticated", "")
				} else {
					h.documentError(w, r, http.StatusForbidden)
				}
				var directive string
				for _, item := range strings.Split(w.Header().Get("Content-Security-Policy"), ";") {
					item = strings.TrimSpace(item)
					if strings.HasPrefix(item, "frame-ancestors ") {
						directive = strings.TrimPrefix(item, "frame-ancestors ")
					}
				}
				if directive != tc.ancestors {
					t.Fatalf("%s ancestor sources = %q, want %q", page, directive, tc.ancestors)
				}
			}
		})
	}
}
