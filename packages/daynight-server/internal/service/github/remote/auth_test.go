package remote

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestTokenSourceJWTAndCache(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/installations/42/access_tokens" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
		if len(parts) != 3 {
			t.Error("JWT parts")
			w.WriteHeader(400)
			return
		}
		digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
		sig, err := base64.RawURLEncoding.DecodeString(parts[2])
		if err != nil || rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], sig) != nil {
			t.Error("JWT signature")
		}
		payload, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			t.Error(err)
		}
		var claims struct {
			Iss      string `json:"iss"`
			Iat, Exp int64
		}
		if err = json.Unmarshal(payload, &claims); err != nil || claims.Iss != "123" || claims.Iat != now.Add(-time.Minute).Unix() || claims.Exp != now.Add(9*time.Minute).Unix() {
			t.Errorf("JWT claims: %+v %v", claims, err)
		}
		fmt.Fprintf(w, `{"token":"token-%d","expires_at":%q}`, calls.Load(), now.Add(time.Hour).Format(time.RFC3339))
	}))
	defer server.Close()
	exchange := func(ctx context.Context, id int64, jwt string) (string, time.Time, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, fmt.Sprintf("%s/installations/%d/access_tokens", server.URL, id), nil)
		if err != nil {
			return "", time.Time{}, err
		}
		req.Header.Set("Authorization", "Bearer "+jwt)
		resp, err := server.Client().Do(req)
		if err != nil {
			return "", time.Time{}, err
		}
		defer resp.Body.Close()
		var body struct {
			Token   string    `json:"token"`
			Expires time.Time `json:"expires_at"`
		}
		err = json.NewDecoder(resp.Body).Decode(&body)
		return body.Token, body.Expires, err
	}
	source := newTokenSource(123, key, exchange)
	source.now = func() time.Time { return now }
	var wg sync.WaitGroup
	start := make(chan struct{})
	for range 24 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			tok, err := source.token(context.Background(), 42)
			if err != nil || tok != "token-1" {
				t.Errorf("token: %q %v", tok, err)
			}
		}()
	}
	close(start)
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("concurrent requests made %d exchanges", calls.Load())
	}
	source.invalidate(42, "old-token")
	if tok, err := source.token(context.Background(), 42); err != nil || tok != "token-1" {
		t.Fatalf("stale invalidation: %q %v", tok, err)
	}
	source.invalidate(42, "token-1")
	if tok, err := source.token(context.Background(), 42); err != nil || tok != "token-2" {
		t.Fatalf("invalidation: %q %v", tok, err)
	}
	now = now.Add(59 * time.Minute)
	if tok, err := source.token(context.Background(), 42); err != nil || tok != "token-3" {
		t.Fatalf("expiry: %q %v", tok, err)
	}
}

func TestTokenSourceWaitCancellationAndFailure(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	source := newTokenSource(1, key, func(ctx context.Context, _ int64, _ string) (string, time.Time, error) {
		close(started)
		<-release
		return "", time.Time{}, fmt.Errorf("exchange failed")
	})
	result := make(chan error, 1)
	go func() { _, err := source.token(context.Background(), 9); result <- err }()
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := source.token(ctx, 9); err != context.DeadlineExceeded {
		t.Fatalf("wait cancellation: %v", err)
	}
	close(release)
	if err := <-result; err == nil || err.Error() != "exchange failed" {
		t.Fatalf("failure: %v", err)
	}
	source.exchange = func(context.Context, int64, string) (string, time.Time, error) {
		return "", time.Now().Add(time.Hour), nil
	}
	if _, err = source.token(context.Background(), 9); err == nil {
		t.Fatal("empty token accepted")
	}
	source.exchange = func(context.Context, int64, string) (string, time.Time, error) {
		return "value", time.Now().Add(time.Minute), nil
	}
	if _, err = source.token(context.Background(), 9); err == nil {
		t.Fatal("expired token accepted")
	}
}

type observedWaitContext struct {
	context.Context
	waiting chan struct{}
	once    sync.Once
}

func (c *observedWaitContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}

func TestTokenSourceLeaderCancellationDoesNotCancelOtherCaller(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	var count atomic.Int32
	source := newTokenSource(1, key, func(ctx context.Context, _ int64, _ string) (string, time.Time, error) {
		if count.Add(1) == 1 {
			close(started)
			<-ctx.Done()
			return "", time.Time{}, ctx.Err()
		}
		return "new-token", time.Now().Add(time.Hour), nil
	})
	leader, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() { _, err := source.token(leader, 1); first <- err }()
	<-started
	second := make(chan string, 1)
	waiting := &observedWaitContext{Context: context.Background(), waiting: make(chan struct{})}
	go func() {
		tok, err := source.token(waiting, 1)
		if err != nil {
			t.Errorf("waiting caller: %v", err)
		}
		second <- tok
	}()
	<-waiting.waiting
	cancel()
	if err := <-first; err != context.Canceled {
		t.Fatalf("leader: %v", err)
	}
	if tok := <-second; tok != "new-token" {
		t.Fatalf("waiting caller token: %q", tok)
	}
}
