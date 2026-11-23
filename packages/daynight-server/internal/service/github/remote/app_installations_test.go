package remote

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

func TestFindInstallationByRepositoryAcrossPages(t *testing.T) {
	var base string
	c, s, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/installations":
			if len(strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")) != 3 {
				t.Error("App JWT required")
			}
			if r.URL.Query().Get("page") == "2" {
				fmt.Fprint(w, `[{"id":12,"account":{"login":"team"}}]`)
				return
			}
			w.Header().Set("Link", "<"+base+"/app/installations?page=2>; rel=\"next\"")
			fmt.Fprint(w, `[{"id":11,"account":{"login":"other"}}]`)
		case "/app/installations/11/access_tokens", "/app/installations/12/access_tokens":
			w.WriteHeader(http.StatusCreated)
			id := "11"
			if strings.Contains(r.URL.Path, "/12/") {
				id = "12"
			}
			fmt.Fprintf(w, `{"token":"token-%s","expires_at":"2099-01-01T00:00:00Z"}`, id)
		case "/installation/repositories":
			if r.Header.Get("Authorization") == "Bearer token-11" {
				fmt.Fprint(w, `{"repositories":[]}`)
				return
			}
			if r.Header.Get("Authorization") != "Bearer token-12" {
				t.Error("unexpected token")
			}
			if r.URL.Query().Get("page") == "2" {
				fmt.Fprint(w, `{"repositories":[{"id":7,"full_name":"team/renamed","private":true}]}`)
				return
			}
			w.Header().Set("Link", "<"+base+"/installation/repositories?page=2>; rel=\"next\"")
			fmt.Fprint(w, `{"repositories":[{"id":9,"full_name":"team/other","private":true}]}`)
		default:
			t.Errorf("unexpected %s", r.URL)
			http.NotFound(w, r)
		}
	})
	base = s.URL
	got, err := c.FindInstallationByRepository(context.Background(), 7)
	if err != nil || got != (githubpr.InstallationObservation{ID: 12, AccountLogin: "team"}) {
		t.Fatalf("found: %+v %v", got, err)
	}
}

func TestFindInstallationIncompleteScanIsNotAbsence(t *testing.T) {
	var mode atomic.Int32
	var base string
	c, s, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/installations":
			switch mode.Load() {
			case 0:
				w.Header().Set("Link", "<"+base+"/app/installations>; rel=\"next\"")
				fmt.Fprint(w, `[]`)
			case 1:
				fmt.Fprint(w, `null`)
			case 2:
				w.Header().Set("Retry-After", "60")
				w.WriteHeader(http.StatusTooManyRequests)
			case 3:
				fmt.Fprint(w, `[{"id":11,"account":{"login":"team"}}]`)
			default:
				fmt.Fprint(w, `[]`)
			}
		case "/app/installations/11/access_tokens":
			tokenResponse(w)
		case "/installation/repositories":
			http.NotFound(w, r)
		default:
			t.Errorf("unexpected %s", r.URL)
			http.NotFound(w, r)
		}
	})
	base = s.URL
	for _, m := range []int32{0, 1, 2, 3} {
		mode.Store(m)
		_, err := c.FindInstallationByRepository(context.Background(), 7)
		if err == nil {
			t.Fatalf("mode %d unexpectedly succeeded", m)
		}
		if m == 3 && strings.Contains(err.Error(), "repository absent from installation") {
			t.Fatal("HTTP 404 treated as complete repository list")
		}
	}
	mode.Store(4)
	_, err := c.FindInstallationByRepository(context.Background(), 7)
	if e, ok := err.(*Error); !ok || e.Code != "not_found" {
		t.Fatalf("complete empty scan: %v", err)
	}
}

func TestFindInstallationContinuesPastInaccessibleInstallation(t *testing.T) {
	c, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/installations":
			fmt.Fprint(w, `[{"id":11,"account":{"login":"suspended"}},{"id":12,"account":{"login":"team"}}]`)
		case "/app/installations/11/access_tokens":
			http.NotFound(w, r)
		case "/app/installations/12/access_tokens":
			tokenResponse(w)
		case "/installation/repositories":
			fmt.Fprint(w, `{"repositories":[{"id":7,"full_name":"team/renamed","private":true}]}`)
		default:
			t.Errorf("unexpected %s", r.URL)
			http.NotFound(w, r)
		}
	})
	got, err := c.FindInstallationByRepository(context.Background(), 7)
	if err != nil || got.ID != 12 {
		t.Fatalf("found after inaccessible installation: %+v %v", got, err)
	}
}
