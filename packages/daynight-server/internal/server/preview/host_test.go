package preview

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestHostNamespaceIsReservedBeforeMainMux(t *testing.T) {
	_, _, handler := fixture(t, &operations{}, false)
	for _, host := range []string{"preview.daynight.test.", "PREVIEW.daynight.test", "preview.daynight.test:80", "preview.daynight.test:invalid", "task.preview.daynight.test", "a.b.preview.daynight.test", "task.preview.daynight.test.:81", "[preview.daynight.test]:80", "[preview.daynight.test]", "[preview.daynight.test", "preview.daynight.test]:invalid"} {
		r := httptest.NewRequest("GET", "http://main.test/api/v1/me", nil)
		r.Host = host
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 404 {
			t.Fatalf("preview host %s escaped namespace with %d", host, w.Code)
		}
	}
	for _, host := range []string{"daynight.test", "127.0.0.1:8787", "localhost:8787", "outside.test"} {
		r := httptest.NewRequest("GET", "http://main.test/healthz", nil)
		r.Host = host
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 202 {
			t.Fatalf("non-preview %s = %d", host, w.Code)
		}
	}
}

func TestNumericLoopbackCallbackUsesHostOnlyTestCookie(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "[::1]"} {
		state := secret.Random("")
		ops := &operations{redeem: func(context.Context, string, string, string) (identity.PreviewSSORedemption, error) {
			return identity.PreviewSSORedemption{LoginID: "id", Secret: secret.Random("dnpv_"), ExpiresAt: time.Now().Add(time.Hour)}, nil
		}}
		h, err := New(ops, func(*http.Request) (model.Principal, error) {
			t.Fatal("unexpected authentication")
			return model.Principal{}, nil
		}, "http://"+host+":8080", "http://"+host+":8081", slog.New(slog.NewTextHandler(io.Discard, nil)))
		if err != nil {
			t.Fatal(err)
		}
		w := request(h.Wrap(http.NotFoundHandler()), "GET", "http://"+host+":8081"+CallbackPath+"?code=code&state="+state, &http.Cookie{Name: h.bindingCookieName(state), Value: state})
		if w.Code != http.StatusSeeOther || len(w.Result().Cookies()) != 2 || w.Result().Cookies()[0].Domain != "" {
			t.Fatalf("numeric callback %s: %d %v", host, w.Code, w.Header())
		}
	}
}

func TestIPv6PreviewAuthorityDispatchAndRefusal(t *testing.T) {
	h, err := New(&operations{}, func(*http.Request) (model.Principal, error) {
		t.Fatal("unexpected authentication")
		return model.Principal{}, nil
	}, "http://[::1]:8080", "http://[::1]:8081", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	handler := h.Wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusAccepted) }))
	for _, test := range []struct {
		host, path string
		status     int
	}{
		{"[::1]:8080", "/healthz", http.StatusAccepted},
		{"[::1]:8081", CompletePath + "?login=id", http.StatusUnauthorized},
		{"[::1]:8081", "/api/v1/me", http.StatusNotFound},
		{"[::1]:invalid", "/api/v1/me", http.StatusNotFound},
		{"[::1]:", "/api/v1/me", http.StatusNotFound},
		{"[::1]", "/api/v1/me", http.StatusNotFound},
		{"::1", "/api/v1/me", http.StatusNotFound},
		{"[::1", "/api/v1/me", http.StatusNotFound},
		{"[::1].:8081", "/api/v1/me", http.StatusNotFound},
		{"[0:0:0:0:0:0:0:1]:8081", "/api/v1/me", http.StatusNotFound},
		{"[::2]:8081", "/healthz", http.StatusAccepted},
	} {
		r := httptest.NewRequest("GET", "http://main.test"+test.path, nil)
		r.Host = test.host
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != test.status {
			t.Fatalf("%s%s returned %d, want %d", test.host, test.path, w.Code, test.status)
		}
	}
}

func TestExplicitLoopbackOriginsKeepMainAndPreviewPortsSeparate(t *testing.T) {
	h, err := New(&operations{}, func(*http.Request) (model.Principal, error) {
		t.Fatal("unexpected authentication")
		return model.Principal{}, nil
	}, "http://127.0.0.1:8787", "http://127.0.0.1:8788", slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	handler := h.Wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusAccepted) }))
	for _, target := range []struct {
		url    string
		status int
	}{
		{"http://127.0.0.1:8787/healthz", http.StatusAccepted},
		{"http://127.0.0.1:8788/healthz", http.StatusNotFound},
	} {
		w := request(handler, "GET", target.url)
		if w.Code != target.status {
			t.Fatalf("%s returned %d", target.url, w.Code)
		}
	}
}

func TestLoopbackHealthCallersSelectMainNamespace(t *testing.T) {
	for _, host := range []string{"127.0.0.1", "[::1]"} {
		t.Run(host, func(t *testing.T) {
			h, err := New(&operations{}, func(*http.Request) (model.Principal, error) {
				t.Fatal("unexpected authentication")
				return model.Principal{}, nil
			}, "http://"+host+":32000", "http://"+host+":8787", slog.New(slog.NewTextHandler(io.Discard, nil)))
			if err != nil {
				t.Fatal(err)
			}
			delegated := 0
			handler := h.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				delegated++
				if r.Host != "localhost" {
					t.Fatalf("probe authority changed: %q", r.Host)
				}
				w.Header().Set("Probe-Method", r.Method)
				w.WriteHeader(http.StatusAccepted)
			}))
			for _, method := range []string{http.MethodGet, http.MethodHead} {
				for _, path := range []string{"/healthz", "/readyz"} {
					r := httptest.NewRequest(method, "http://"+host+":8787"+path, nil)
					r.Host = "localhost"
					before := delegated
					w := httptest.NewRecorder()
					handler.ServeHTTP(w, r)
					if w.Code != http.StatusAccepted || delegated != before+1 || w.Header().Get("Probe-Method") != method {
						t.Fatalf("main probe %s%s = %d", method, path, w.Code)
					}
					w = request(handler, method, "http://"+host+":8787"+path)
					if w.Code != http.StatusNotFound || delegated != before+1 {
						t.Fatalf("preview probe %s%s escaped to main: %d", method, path, w.Code)
					}
				}
			}
		})
	}
}
