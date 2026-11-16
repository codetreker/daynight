package remote

import (
	"context"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
)

// ErrAppCredentialsInvalid means GitHub rejected the App JWT or returned a
// different App identity. Transport and upstream failures do not imply this.
var ErrAppCredentialsInvalid = errors.New("github app credentials invalid")

// AppIdentity is the public identity returned for authenticated App credentials.
type AppIdentity struct {
	ID   int64
	Name string
	Slug string
}

// VerifyApp proves the supplied App ID and key against GitHub's authenticated
// App endpoint. The caller must bound the entire operation, including input and
// persistence; this call also caps its own network work at 45 seconds.
func VerifyApp(ctx context.Context, appID int64, key *rsa.PrivateKey) (AppIdentity, error) {
	c, err := NewClient(appID, key)
	if err != nil {
		return AppIdentity{}, ErrAppCredentialsInvalid
	}
	defer c.CloseIdleConnections()
	// The caller's total deadline covers this request, rather than the shorter
	// per-hop timeout used for background synchronization.
	c.http.Transport = c.http.Transport.(checkpointTransport).base
	return c.verifyApp(ctx, appID)
}

func (c *Client) verifyApp(ctx context.Context, appID int64) (AppIdentity, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	resp, err := c.appGet(ctx, c.endpoint("/app"))
	if err != nil {
		return AppIdentity{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		return AppIdentity{}, ErrAppCredentialsInvalid
	}
	if resp.StatusCode != http.StatusOK {
		return AppIdentity{}, responseError(resp)
	}
	const maxResponse = 1024 * 1024
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse+1))
	if err != nil {
		if cause := ctx.Err(); cause != nil {
			return AppIdentity{}, cause
		}
		return AppIdentity{}, errors.New("invalid github app response")
	}
	var raw struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
		Slug string `json:"slug"`
	}
	if len(body) > maxResponse || json.Unmarshal(body, &raw) != nil || raw.ID <= 0 || raw.Name == "" || raw.Slug == "" || strings.ContainsRune(raw.Name, 0) || strings.ContainsRune(raw.Slug, 0) {
		return AppIdentity{}, errors.New("invalid github app response")
	}
	if raw.ID != appID {
		return AppIdentity{}, ErrAppCredentialsInvalid
	}
	return AppIdentity{ID: raw.ID, Name: raw.Name, Slug: raw.Slug}, nil
}
