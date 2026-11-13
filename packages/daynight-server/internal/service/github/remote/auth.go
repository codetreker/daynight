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
	"strconv"
	"sync"
	"time"
)

type exchangeToken func(context.Context, int64, string) (string, time.Time, error)
type cachedToken struct {
	token   string
	expires time.Time
	done    chan struct{}
	err     error
}
type tokenSource struct {
	appID    int64
	key      *rsa.PrivateKey
	exchange exchangeToken
	now      func() time.Time
	mu       sync.Mutex
	entries  map[int64]*cachedToken
}

func newTokenSource(appID int64, key *rsa.PrivateKey, exchange exchangeToken) *tokenSource {
	return &tokenSource{appID: appID, key: key, exchange: exchange, now: time.Now, entries: make(map[int64]*cachedToken)}
}
func (s *tokenSource) jwt() (string, error) {
	if s.appID <= 0 || s.key == nil {
		return "", errors.New("invalid GitHub App credentials")
	}
	now := s.now()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	payload, err := json.Marshal(struct {
		Iss string `json:"iss"`
		Iat int64  `json:"iat"`
		Exp int64  `json:"exp"`
	}{strconv.FormatInt(s.appID, 10), now.Add(-time.Minute).Unix(), now.Add(9 * time.Minute).Unix()})
	if err != nil {
		return "", errors.New("cannot encode GitHub App JWT")
	}
	message := header + "." + base64.RawURLEncoding.EncodeToString(payload)
	digest := sha256.Sum256([]byte(message))
	signature, err := rsa.SignPKCS1v15(rand.Reader, s.key, crypto.SHA256, digest[:])
	if err != nil {
		return "", errors.New("cannot sign GitHub App JWT")
	}
	return message + "." + base64.RawURLEncoding.EncodeToString(signature), nil
}

// token serializes refreshes per installation; waiting callers may cancel independently.
func (s *tokenSource) token(ctx context.Context, installationID int64) (string, error) {
	if installationID <= 0 {
		return "", errors.New("invalid GitHub installation ID")
	}
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		s.mu.Lock()
		entry := s.entries[installationID]
		if entry != nil && entry.done != nil {
			done := entry.done
			s.mu.Unlock()
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-done:
				if entry.err != nil {
					var checkpoint *checkpointError
					if errors.As(entry.err, &checkpoint) || errors.Is(entry.err, context.Canceled) || errors.Is(entry.err, context.DeadlineExceeded) {
						continue
					}
					return "", entry.err
				}
				continue
			}
		}
		if entry != nil && entry.token != "" && s.now().Before(entry.expires.Add(-time.Minute)) {
			result := entry.token
			s.mu.Unlock()
			return result, nil
		}
		entry = &cachedToken{done: make(chan struct{})}
		s.entries[installationID] = entry
		s.mu.Unlock()
		jwt, err := s.jwt()
		var token string
		var expires time.Time
		if err == nil {
			token, expires, err = s.exchange(ctx, installationID, jwt)
		}
		if err == nil && (token == "" || !s.now().Before(expires.Add(-time.Minute))) {
			err = errors.New("GitHub returned an invalid installation token")
		}
		s.mu.Lock()
		entry.err = err
		if err == nil {
			entry.token = token
			entry.expires = expires
		}
		done := entry.done
		entry.done = nil
		close(done)
		s.mu.Unlock()
		if err != nil {
			return "", err
		}
		return token, nil
	}
}

// invalidate removes only the token that actually failed so an old 401 cannot discard a newer one.
func (s *tokenSource) invalidate(installationID int64, usedToken string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if entry := s.entries[installationID]; entry != nil && entry.done == nil && entry.token == usedToken {
		delete(s.entries, installationID)
	}
}
