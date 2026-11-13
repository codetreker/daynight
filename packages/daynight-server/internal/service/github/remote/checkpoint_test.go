package remote

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

func TestCheckpointBeforeEveryRequest(t *testing.T) {
	var base string
	var checkpoints, requests atomic.Int32
	var reads atomic.Int32
	c, srv, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		n := requests.Add(1)
		if checkpoints.Load() != n {
			t.Errorf("request %d reached server with %d checkpoints", n, checkpoints.Load())
		}
		switch r.URL.Path {
		case "/app/installations/12/access_tokens":
			tokenResponse(w)
		case "/repos/a/b/pulls":
			if reads.Add(1) == 1 {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			http.Redirect(w, r, base+"/repos/a/renamed/pulls", http.StatusMovedPermanently)
		case "/repos/a/renamed/pulls":
			if r.URL.Query().Get("page") == "2" {
				fmt.Fprint(w, "["+prJSON("second", "null")+"]")
				return
			}
			w.Header().Set("Link", "<"+base+"/repos/a/renamed/pulls?page=2>; rel=\"next\"")
			fmt.Fprint(w, "["+prJSON("first", "null")+"]")
		default:
			t.Errorf("unexpected request %s", r.URL.String())
			http.NotFound(w, r)
		}
	})
	base = srv.URL
	ctx := WithRequestCheckpoint(context.Background(), func(context.Context) error {
		checkpoints.Add(1)
		return nil
	})
	var pages int
	err := c.ListOpen(ctx, 12, "a", "b", func(_ []githubpr.Observation) error { pages++; return nil })
	if err != nil || pages != 2 || requests.Load() != 6 || checkpoints.Load() != 6 {
		t.Fatalf("pages=%d requests=%d checkpoints=%d error=%v", pages, requests.Load(), checkpoints.Load(), err)
	}
}

func TestCheckpointRefusalAndCancellationStopRequests(t *testing.T) {
	var base string
	var requests atomic.Int32
	c, srv, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path == "/app/installations/12/access_tokens" {
			tokenResponse(w)
			return
		}
		http.Redirect(w, r, base+"/redirected", http.StatusMovedPermanently)
	})
	base = srv.URL
	refused := errors.New("claim lost")
	var checkpoints int
	ctx := WithRequestCheckpoint(context.Background(), func(context.Context) error {
		checkpoints++
		if checkpoints == 3 {
			return refused
		}
		return nil
	})
	_, err := c.Repository(ctx, 12, "a", "b")
	if !errors.Is(err, refused) || requests.Load() != 2 || checkpoints != 3 {
		t.Fatalf("error=%v requests=%d checkpoints=%d", err, requests.Load(), checkpoints)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	ctx = WithRequestCheckpoint(cancelled, func(context.Context) error { cancel(); return nil })
	_, err = c.Repository(ctx, 12, "a", "b")
	if !errors.Is(err, context.Canceled) || requests.Load() != 2 {
		t.Fatalf("cancellation error=%v requests=%d", err, requests.Load())
	}
}

func TestTokenWaiterRetriesAfterLeaderCheckpointFailure(t *testing.T) {
	var requests, waiterCheckpoints atomic.Int32
	c, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		switch r.URL.Path {
		case "/app/installations/12/access_tokens":
			tokenResponse(w)
		case "/repos/a/b":
			fmt.Fprint(w, `{"id":7,"full_name":"a/b","private":true}`)
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			http.NotFound(w, r)
		}
	})
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	started, release := make(chan struct{}), make(chan struct{})
	refused := errors.New("leader lease lost")
	leaderCtx := WithRequestCheckpoint(ctx, func(ctx context.Context) error {
		close(started)
		select {
		case <-release:
			return refused
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	leaderResult := make(chan error, 1)
	go func() { _, err := c.Repository(leaderCtx, 12, "a", "b"); leaderResult <- err }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("leader did not start its checkpoint")
	}
	waiting := &observedWaitContext{Context: ctx, waiting: make(chan struct{})}
	waiterCtx := WithRequestCheckpoint(waiting, func(context.Context) error { waiterCheckpoints.Add(1); return nil })
	type result struct {
		repo githubpr.RepositoryObservation
		err  error
	}
	waiterResult := make(chan result, 1)
	go func() { repo, err := c.Repository(waiterCtx, 12, "a", "b"); waiterResult <- result{repo, err} }()
	select {
	case <-waiting.waiting:
	case <-ctx.Done():
		t.Fatal("waiter did not join the token exchange")
	}
	close(release)
	select {
	case err := <-leaderResult:
		if !errors.Is(err, refused) {
			t.Fatalf("leader error = %v", err)
		}
	case <-ctx.Done():
		t.Fatal("leader did not exit")
	}
	select {
	case got := <-waiterResult:
		if got.err != nil || got.repo.ID != 7 {
			t.Fatalf("waiter result: %+v, %v", got.repo, got.err)
		}
	case <-ctx.Done():
		t.Fatal("waiter did not finish")
	}
	if requests.Load() != 2 || waiterCheckpoints.Load() != 2 {
		t.Fatalf("requests=%d waiter checkpoints=%d", requests.Load(), waiterCheckpoints.Load())
	}
}
