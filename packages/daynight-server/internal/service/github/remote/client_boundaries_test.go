package remote

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

func TestReadOperationsRejectIncompleteOrFailedResponses(t *testing.T) {
	var mode atomic.Int32
	var base string
	c, s, key := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "access_tokens") {
			tokenResponse(w)
			return
		}
		switch mode.Load() {
		case 0:
			w.WriteHeader(http.StatusBadGateway)
		case 1:
			fmt.Fprint(w, `{`)
		case 2:
			fmt.Fprint(w, `{}`)
		case 3:
			fmt.Fprint(w, `{"repositories":[{}]}`)
		case 4:
			w.Header().Set("Link", "<"+base+r.URL.RequestURI()+">; rel=\"next\"")
			if strings.Contains(r.URL.Path, "repositories") {
				fmt.Fprint(w, `{"repositories":[]}`)
			} else {
				fmt.Fprint(w, `[]`)
			}
		case 5:
			if strings.HasSuffix(r.URL.Path, "/pulls") {
				fmt.Fprint(w, `[{}]`)
			} else {
				fmt.Fprint(w, `{"id":7,"full_name":"a/b","private":false}`)
			}
		case 6:
			if strings.HasSuffix(r.URL.Path, "/pulls") {
				fmt.Fprint(w, `null`)
			} else {
				fmt.Fprint(w, `{"id":7,"full_name":"a/b","private":false}`)
			}
		case 7:
			fmt.Fprint(w, `[]`)
		case 8:
			w.Header().Set("Link", "<https://elsewhere.invalid/>; rel=\"next\"")
			fmt.Fprint(w, `{"repositories":[]}`)
		}
	})
	base = s.URL
	ctx := context.Background()
	if _, err := c.DiscoverInstallation(ctx, "", "b"); err == nil {
		t.Fatal("invalid discovery path")
	}
	mode.Store(0)
	if _, err := c.DiscoverInstallation(ctx, "a", "b"); err == nil {
		t.Fatal("discovery upstream failure")
	}
	c.tokens.key = nil
	if _, err := c.DiscoverInstallation(ctx, "a", "b"); err == nil {
		t.Fatal("invalid app credentials")
	}
	if _, err := c.Repository(ctx, 12, "a", "b"); err == nil {
		t.Fatal("invalid token credentials")
	}
	if _, err := c.ResolveRepository(ctx, 12, 7); err == nil {
		t.Fatal("invalid credentials for resolve")
	}
	if _, err := c.PullRequest(ctx, 12, "a", "b", 1); err == nil {
		t.Fatal("invalid credentials for PR")
	}
	if _, err := c.VerifyAccess(ctx, 12, "a", "b"); err == nil {
		t.Fatal("invalid credentials for access")
	}
	if err := c.ListOpen(ctx, 12, "a", "b", func([]githubpr.Observation) error { return nil }); err == nil {
		t.Fatal("invalid credentials for list")
	}
	c.tokens.key = key
	if _, err := c.ResolveRepository(ctx, 12, 0); err == nil {
		t.Fatal("invalid repository ID")
	}
	if _, err := c.PullRequest(ctx, 12, "a", "b", 0); err == nil {
		t.Fatal("invalid PR number")
	}
	if _, err := c.PullRequest(ctx, 12, "/", "b", 1); err == nil {
		t.Fatal("invalid PR path")
	}
	if _, err := c.VerifyAccess(ctx, 12, "/", "b"); err == nil {
		t.Fatal("invalid verify path")
	}
	if err := c.ListOpen(ctx, 12, "a", "b", nil); err == nil {
		t.Fatal("nil visitor")
	}
	if err := c.ListOpen(ctx, 12, "/", "b", func([]githubpr.Observation) error { return nil }); err == nil {
		t.Fatal("invalid list path")
	}
	for _, m := range []int32{0, 1, 2, 3, 4, 8} {
		mode.Store(m)
		if _, err := c.ResolveRepository(ctx, 12, 7); err == nil {
			t.Fatalf("resolve mode %d", m)
		}
	}
	for _, m := range []int32{0, 1, 2} {
		mode.Store(m)
		if _, err := c.PullRequest(ctx, 12, "a", "b", 1); err == nil {
			t.Fatalf("PR mode %d", m)
		}
	}
	for _, m := range []int32{0, 1, 2, 5, 6} {
		mode.Store(m)
		if _, err := c.VerifyAccess(ctx, 12, "a", "b"); err == nil {
			t.Fatalf("access mode %d", m)
		}
	}
	for _, m := range []int32{0, 1, 2, 4, 5, 6} {
		mode.Store(m)
		if err := c.ListOpen(ctx, 12, "a", "b", func([]githubpr.Observation) error { return nil }); err == nil {
			t.Fatalf("list mode %d", m)
		}
	}
	sentinel := errors.New("visitor stopped")
	mode.Store(7)
	if err := c.ListOpen(ctx, 12, "a", "b", func([]githubpr.Observation) error { return sentinel }); !errors.Is(err, sentinel) {
		t.Fatalf("visitor: %v", err)
	}
}
