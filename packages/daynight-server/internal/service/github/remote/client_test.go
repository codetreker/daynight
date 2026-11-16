package remote

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

func testClient(t *testing.T, h http.HandlerFunc) (*Client, *httptest.Server, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c, err := newClient(42, key, srv.URL, srv.Client().Transport)
	if err != nil {
		t.Fatal(err)
	}
	return c, srv, key
}
func tokenResponse(w http.ResponseWriter) {
	w.WriteHeader(http.StatusCreated)
	fmt.Fprintf(w, `{"token":"secret-token","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
}
func prJSON(sha, body string) string {
	return fmt.Sprintf(`{"id":11,"number":1,"html_url":"https://github.com/x/y/pull/1","title":"标题","state":"open","draft":false,"user":null,"base":{"ref":"main","repo":{"id":7}},"head":{"ref":"branch","sha":%q,"repo":null},"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:01Z","closed_at":null,"merged_at":null,"body":%s}`, sha, body)
}

func TestHTTPDiscoveryAndTokenProtocol(t *testing.T) {
	var key *rsa.PrivateKey
	var srv *httptest.Server
	var calls atomic.Int32
	c, s, k := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-GitHub-Api-Version") != apiVersion || r.Header.Get("Accept") != "application/vnd.github+json" {
			t.Error("missing protocol headers")
		}
		switch r.URL.Path {
		case "/repos/a/b/installation", "/app/installations/12/access_tokens":
			parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
			if len(parts) != 3 {
				t.Error("invalid JWT")
				return
			}
			sig, err := base64.RawURLEncoding.DecodeString(parts[2])
			if err != nil {
				t.Error(err)
				return
			}
			sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
			if err = rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, sum[:], sig); err != nil {
				t.Error(err)
			}
			data, _ := base64.RawURLEncoding.DecodeString(parts[1])
			var claims struct {
				Iss string `json:"iss"`
				Iat int64  `json:"iat"`
				Exp int64  `json:"exp"`
			}
			if json.Unmarshal(data, &claims) != nil || claims.Iss != "42" || claims.Iat > time.Now().Unix()-59 || claims.Exp < time.Now().Unix()+538 {
				t.Errorf("invalid claims: %s", data)
			}
			if strings.Contains(r.URL.Path, "access_tokens") {
				var b struct {
					Permissions map[string]string `json:"permissions"`
				}
				if json.NewDecoder(r.Body).Decode(&b) != nil || len(b.Permissions) != 1 || b.Permissions["pull_requests"] != "read" {
					t.Error("invalid permissions")
				}
				calls.Add(1)
				tokenResponse(w)
			} else {
				fmt.Fprint(w, `{"id":12,"account":{"login":"team"}}`)
			}
		case "/repos/a/b":
			if r.Header.Get("Authorization") != "Bearer secret-token" {
				t.Error("missing token")
			}
			fmt.Fprint(w, `{"id":7,"full_name":"a/b","private":true}`)
		case "/repos/a/b/pulls":
			if r.URL.Query().Get("per_page") != "1" {
				t.Error("not minimal")
			}
			fmt.Fprint(w, `[]`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
		}
	})
	srv = s
	_ = srv
	key = k
	ins, err := c.DiscoverInstallation(context.Background(), "a", "b")
	if err != nil || ins.ID != 12 || ins.AccountLogin != "team" {
		t.Fatalf("discovery: %+v %v", ins, err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			repo, err := c.VerifyAccess(context.Background(), 12, "a", "b")
			if err != nil || repo.ID != 7 {
				t.Errorf("verify: %+v %v", repo, err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("token calls=%d", calls.Load())
	}
}

func TestHTTPPaginationRedirectAndObservations(t *testing.T) {
	var base string
	body := strings.Repeat("汉🙂", 40000)
	encoded, _ := json.Marshal(body)
	var requests atomic.Int32
	c, s, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/app/installations/12/access_tokens":
			tokenResponse(w)
		case "/repos/a/b":
			http.Redirect(w, r, base+"/repos/a/renamed", http.StatusMovedPermanently)
		case "/repos/a/renamed":
			fmt.Fprint(w, `{"id":7,"full_name":"a/renamed","private":false}`)
		case "/installation/repositories":
			if r.URL.Query().Get("page") == "2" {
				fmt.Fprint(w, `{"repositories":[{"id":7,"full_name":"a/renamed","private":false}]}`)
			} else {
				w.Header().Set("Link", "<"+base+"/installation/repositories?page=2>; rel=\"next\"")
				fmt.Fprint(w, `{"repositories":[{"id":8,"full_name":"a/b","private":false}]}`)
			}
		case "/repos/a/renamed/pulls":
			if r.URL.Query().Get("page") == "2" {
				fmt.Fprint(w, "["+prJSON("head-two", "null")+"]")
			} else {
				if r.URL.Query().Get("state") != "open" || r.URL.Query().Get("per_page") != "100" || r.URL.Query().Get("direction") != "asc" || r.URL.Query().Get("sort") != "created" {
					t.Error("incorrect list query")
				}
				w.Header().Set("Link", "<"+base+"/repos/a/renamed/pulls?page=2>; rel=\"next\", <"+base+"/repos/a/renamed/pulls?page=9>; rel=\"last\"")
				fmt.Fprint(w, "["+prJSON("head-one", string(encoded))+"]")
			}
		case "/repos/a/renamed/pulls/1":
			requests.Add(1)
			fmt.Fprint(w, prJSON("changed-in-same-second", `"原文"`))
		default:
			t.Errorf("unexpected %s", r.URL.String())
			http.NotFound(w, r)
		}
	})
	base = s.URL
	repo, err := c.Repository(context.Background(), 12, "a", "b")
	if err != nil || repo.FullName != "a/renamed" {
		t.Fatalf("redirect: %+v %v", repo, err)
	}
	repo, err = c.ResolveRepository(context.Background(), 12, 7)
	if err != nil || repo.FullName != "a/renamed" {
		t.Fatalf("resolve: %+v %v", repo, err)
	}
	var got []string
	err = c.ListOpen(context.Background(), 12, "a", "renamed", func(page []githubpr.Observation) error {
		for _, p := range page {
			got = append(got, p.HeadSHA)
			if p.HeadSHA == "head-one" && (p.Description == nil || *p.Description != body) {
				t.Error("long body lost")
			}
			if p.HeadSHA == "head-two" && (p.Description != nil || p.AuthorID != nil || p.HeadRepositoryID != nil) {
				t.Error("nulls lost")
			}
		}
		return nil
	})
	if err != nil || strings.Join(got, ",") != "head-one,head-two" {
		t.Fatalf("pages %v %v", got, err)
	}
	pr, err := c.PullRequest(context.Background(), 12, "a", "renamed", 1)
	if err != nil || pr.HeadSHA != "changed-in-same-second" || requests.Load() != 1 {
		t.Fatalf("single: %+v %v", pr, err)
	}
}

func TestHTTPErrorsRetryAndCancellation(t *testing.T) {
	var tokenCount, reads atomic.Int32
	var mode atomic.Int32
	started := make(chan struct{}, 1)
	c, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "access_tokens") {
			n := tokenCount.Add(1)
			w.WriteHeader(http.StatusCreated)
			fmt.Fprintf(w, `{"token":"token-%d","expires_at":%q}`, n, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
			return
		}
		reads.Add(1)
		switch mode.Load() {
		case 0:
			if r.Header.Get("Authorization") == "Bearer token-1" {
				w.WriteHeader(401)
				return
			}
			fmt.Fprint(w, `{"id":7,"full_name":"a/b","private":false}`)
		case 1:
			w.WriteHeader(403)
			fmt.Fprint(w, `{"message":"private secret-token"}`)
		case 2:
			w.Header().Set("Retry-After", "120")
			w.WriteHeader(429)
			fmt.Fprint(w, `secret-token`)
		case 3:
			w.WriteHeader(403)
			fmt.Fprint(w, `{"message":"You have exceeded a secondary rate limit"}`)
		case 4:
			started <- struct{}{}
			<-r.Context().Done()
		case 5:
			w.WriteHeader(401)
		}
	})
	_, err := c.Repository(context.Background(), 12, "a", "b")
	if err != nil || tokenCount.Load() != 2 || reads.Load() != 2 {
		t.Fatalf("401 retry: %v tokens=%d reads=%d", err, tokenCount.Load(), reads.Load())
	}
	for _, tc := range []struct {
		mode  int32
		code  string
		retry bool
	}{{1, "permission_denied", false}, {2, "rate_limited", true}, {3, "rate_limited", true}, {5, "unauthorized", false}} {
		mode.Store(tc.mode)
		_, err = c.Repository(context.Background(), 12, "a", "b")
		var remoteErr *Error
		if !errors.As(err, &remoteErr) || remoteErr.Code != tc.code || (tc.retry && time.Until(remoteErr.RetryAt) < 55*time.Second) || strings.Contains(err.Error(), "secret-token") {
			t.Errorf("mode %d: %#v %v", tc.mode, remoteErr, err)
		}
	}
	mode.Store(4)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := c.Repository(ctx, 12, "a", "b"); done <- err }()
	<-started
	cancel()
	select {
	case err = <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("cancellation: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("request not cancelled")
	}
}

func TestHTTPTokenExpiryAndPaginationRefreshBudget(t *testing.T) {
	var base string
	var tokens atomic.Int32
	var mode atomic.Int32
	c, s, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "access_tokens") {
			n := tokens.Add(1)
			w.WriteHeader(201)
			fmt.Fprintf(w, `{"token":"token-%d","expires_at":%q}`, n, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
			return
		}
		if mode.Load() == 1 {
			if r.URL.Query().Get("page") == "2" {
				w.WriteHeader(401)
				return
			}
			if r.Header.Get("Authorization") == "Bearer token-2" {
				w.WriteHeader(401)
				return
			}
			w.Header().Set("Link", "<"+base+"/repos/a/b/pulls?page=2>; rel=\"next\"")
			fmt.Fprint(w, `[]`)
			return
		}
		fmt.Fprint(w, `{"id":7,"full_name":"a/b","private":false}`)
	})
	base = s.URL
	if _, err := c.Repository(context.Background(), 12, "a", "b"); err != nil {
		t.Fatal(err)
	}
	c.tokens.mu.Lock()
	c.tokens.entries[12].expires = time.Now().Add(59 * time.Second)
	c.tokens.mu.Unlock()
	if _, err := c.Repository(context.Background(), 12, "a", "b"); err != nil || tokens.Load() != 2 {
		t.Fatalf("expiry: %v tokens %d", err, tokens.Load())
	}
	mode.Store(1)
	err := c.ListOpen(context.Background(), 12, "a", "b", func([]githubpr.Observation) error { return nil })
	var e *Error
	if !errors.As(err, &e) || e.Code != "unauthorized" || tokens.Load() != 3 {
		t.Fatalf("budget: %v tokens %d", err, tokens.Load())
	}
}

func TestHTTPRejectsInvalidObservationsAndCrossOrigin(t *testing.T) {
	var mode atomic.Int32
	var foreignCalls atomic.Int32
	foreign := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { foreignCalls.Add(1) }))
	defer foreign.Close()
	c, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "access_tokens") {
			tokenResponse(w)
			return
		}
		switch mode.Load() {
		case 0:
			fmt.Fprint(w, `{"number":1,"id":1,"body":"sensitive"}`)
		case 1:
			http.Redirect(w, r, foreign.URL, http.StatusMovedPermanently)
		case 2:
			w.Header().Set("Link", "<"+foreign.URL+">; rel=\"next\"")
			fmt.Fprint(w, `[]`)
		}
	})
	_, err := c.PullRequest(context.Background(), 12, "a", "b", 1)
	if err == nil || strings.Contains(err.Error(), "sensitive") {
		t.Fatalf("invalid observation: %v", err)
	}
	mode.Store(1)
	if _, err = c.Repository(context.Background(), 12, "a", "b"); err == nil {
		t.Fatal("cross-origin redirect accepted")
	}
	mode.Store(2)
	if err = c.ListOpen(context.Background(), 12, "a", "b", func([]githubpr.Observation) error { return nil }); err == nil {
		t.Fatal("cross-origin next accepted")
	}
	if foreignCalls.Load() != 0 {
		t.Fatal("credentials sent to foreign origin")
	}
}

func TestHTTPRejectsIncompleteRepositoryAndMergeFacts(t *testing.T) {
	var mode atomic.Int32
	c, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "access_tokens") {
			tokenResponse(w)
			return
		}
		switch mode.Load() {
		case 0:
			fmt.Fprint(w, `{}`)
		case 1:
			fmt.Fprint(w, `{"repositories":null}`)
		case 2:
			fmt.Fprint(w, `{"repositories":[]}`)
		case 3:
			fmt.Fprint(w, strings.Replace(prJSON("head", "null"), `,"merged_at":null`, "", 1))
		case 4:
			fmt.Fprint(w, strings.Replace(prJSON("head", "null"), `,"closed_at":null`, "", 1))
		case 5:
			fmt.Fprint(w, prJSON("head", "null"))
		case 6:
			fmt.Fprint(w, strings.Replace(prJSON("head", "null"), `,"user":null`, "", 1))
		case 7:
			fmt.Fprint(w, strings.Replace(prJSON("head", "null"), `,"repo":null`, "", 1))
		case 8:
			fmt.Fprint(w, strings.Replace(prJSON("head", "null"), `"ref":"branch",`, "", 1))
		}
	})
	for _, m := range []int32{0, 1} {
		mode.Store(m)
		_, err := c.ResolveRepository(context.Background(), 12, 7)
		var e *Error
		if err == nil || errors.As(err, &e) {
			t.Fatalf("invalid repository page %d: %v", m, err)
		}
	}
	mode.Store(2)
	_, err := c.ResolveRepository(context.Background(), 12, 7)
	var e *Error
	if !errors.As(err, &e) || e.Code != "not_found" {
		t.Fatalf("empty page: %v", err)
	}
	for _, m := range []int32{3, 4, 6, 7, 8} {
		mode.Store(m)
		if _, err = c.PullRequest(context.Background(), 12, "a", "b", 1); err == nil {
			t.Fatalf("missing time field %d accepted", m)
		}
	}
	mode.Store(5)
	if _, err = c.PullRequest(context.Background(), 12, "a", "b", 1); err != nil {
		t.Fatalf("explicit nulls: %v", err)
	}
}

func TestHTTPBodyCancellation(t *testing.T) {
	for _, exchange := range []bool{false, true} {
		t.Run(fmt.Sprint(exchange), func(t *testing.T) {
			started := make(chan struct{}, 1)
			c, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
				if strings.Contains(r.URL.Path, "access_tokens") && !exchange {
					tokenResponse(w)
					return
				}
				if exchange {
					w.WriteHeader(http.StatusCreated)
				}
				fmt.Fprint(w, `{"partial":`)
				w.(http.Flusher).Flush()
				started <- struct{}{}
				<-r.Context().Done()
			})
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() { _, err := c.Repository(ctx, 12, "a", "b"); done <- err }()
			<-started
			cancel()
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("body cancellation: %v", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("body did not cancel")
			}
		})
	}
}

func TestHTTPPermissionBodyCancellation(t *testing.T) {
	started := make(chan struct{}, 1)
	c, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "access_tokens") {
			tokenResponse(w)
			return
		}
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"message":`)
		w.(http.Flusher).Flush()
		started <- struct{}{}
		<-r.Context().Done()
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := c.Repository(ctx, 12, "a", "b"); done <- err }()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("403 body cancellation: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("403 body did not cancel")
	}
}
