// Package remote reads GitHub App installation and pull request facts.
package remote

import (
	"bytes"
	"context"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

const apiOrigin = "https://api.github.com"
const apiVersion = "2026-03-10"

// Error contains safe upstream metadata; it never includes response bodies or credentials.
type Error struct {
	Code      string
	Status    int
	RequestID string
	RetryAt   time.Time
}

func (e *Error) Error() string { return fmt.Sprintf("github %s (HTTP %d)", e.Code, e.Status) }

// Client owns installation token caching and an HTTP transport. Calls are safe concurrently.
type Client struct {
	base   *url.URL
	http   *http.Client
	tokens *tokenSource
}

// NewClient creates a client for the fixed GitHub API origin.
func NewClient(appID int64, key *rsa.PrivateKey) (*Client, error) {
	return newClient(appID, key, apiOrigin, http.DefaultTransport)
}

func newClient(appID int64, key *rsa.PrivateKey, origin string, transport http.RoundTripper) (*Client, error) {
	if appID <= 0 || key == nil {
		return nil, errors.New("github app ID and RSA key are required")
	}
	base, err := url.Parse(origin)
	if err != nil || base.Scheme == "" || base.Host == "" || base.User != nil || base.Path != "" || base.RawQuery != "" || base.Fragment != "" {
		return nil, errors.New("invalid github API origin")
	}
	c := &Client{base: base}
	c.http = &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 || !c.sameOrigin(req.URL) {
			return errors.New("github redirect outside API origin or too many redirects")
		}
		return nil
	}}
	c.tokens = newTokenSource(appID, key, c.exchange)
	return c, nil
}
func (c *Client) sameOrigin(u *url.URL) bool {
	return u != nil && u.User == nil && strings.EqualFold(u.Scheme, c.base.Scheme) && strings.EqualFold(u.Host, c.base.Host)
}
func (c *Client) endpoint(path string) *url.URL { return c.base.ResolveReference(&url.URL{Path: path}) }
func repoPath(owner, repo string) (string, error) {
	if owner == "" || repo == "" || strings.ContainsAny(owner, "/\\") || strings.ContainsAny(repo, "/\\") || owner == "." || owner == ".." || repo == "." || repo == ".." {
		return "", errors.New("invalid repository name")
	}
	return "/repos/" + owner + "/" + repo, nil
}

func (c *Client) request(ctx context.Context, method string, target *url.URL, auth string, body []byte) (*http.Response, error) {
	if !c.sameOrigin(target) {
		return nil, errors.New("github URL outside API origin")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	req, err := http.NewRequestWithContext(ctx, method, target.String(), bytes.NewReader(body))
	if err != nil {
		cancel()
		return nil, errors.New("invalid github request")
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", apiVersion)
	req.Header.Set("Authorization", "Bearer "+auth)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		cause := ctx.Err()
		cancel()
		if cause != nil {
			return nil, cause
		}
		return nil, errors.New("github request failed")
	}
	resp.Body = &cancelBody{ReadCloser: resp.Body, cancel: cancel}
	return resp, nil
}

type cancelBody struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (b *cancelBody) Close() error { defer b.cancel(); return b.ReadCloser.Close() }

func responseError(resp *http.Response) error {
	e := &Error{Code: "unavailable", Status: resp.StatusCode, RequestID: resp.Header.Get("X-GitHub-Request-Id")}
	switch resp.StatusCode {
	case 401:
		e.Code = "unauthorized"
	case 404:
		e.Code = "not_found"
	case 403, 429:
		e.Code = "permission_denied"
		now := time.Now()
		retry := resp.Header.Get("Retry-After")
		if seconds, err := strconv.ParseInt(retry, 10, 64); err == nil && seconds >= 0 {
			e.RetryAt = now.Add(time.Duration(seconds) * time.Second)
		} else if t, err := http.ParseTime(retry); err == nil {
			e.RetryAt = t
		}
		if resp.Header.Get("X-RateLimit-Remaining") == "0" {
			if sec, err := strconv.ParseInt(resp.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil {
				t := time.Unix(sec, 0)
				if t.After(e.RetryAt) {
					e.RetryAt = t
				}
			}
			e.Code = "rate_limited"
		}
		if resp.StatusCode == 429 || retry != "" {
			e.Code = "rate_limited"
		}
		if resp.StatusCode == 403 && e.Code != "rate_limited" {
			var data struct {
				Message string `json:"message"`
			}
			if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&data); err != nil {
				if cause := resp.Request.Context().Err(); cause != nil {
					return cause
				}
				e.Code = "unavailable"
				return e
			}
			if strings.Contains(strings.ToLower(data.Message), "secondary rate limit") || strings.Contains(strings.ToLower(data.Message), "abuse detection") {
				e.Code = "rate_limited"
			}
		}
		if e.Code == "rate_limited" && e.RetryAt.IsZero() {
			e.RetryAt = now.Add(time.Minute)
		}
	}
	return e
}
func (c *Client) exchange(ctx context.Context, id int64, jwt string) (string, time.Time, error) {
	body := []byte(`{"permissions":{"pull_requests":"read"}}`)
	resp, err := c.request(ctx, http.MethodPost, c.endpoint(fmt.Sprintf("/app/installations/%d/access_tokens", id)), jwt, body)
	if err != nil {
		return "", time.Time{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		return "", time.Time{}, responseError(resp)
	}
	var result struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if err = json.NewDecoder(resp.Body).Decode(&result); err != nil {
		if cause := resp.Request.Context().Err(); cause != nil {
			return "", time.Time{}, cause
		}
		return "", time.Time{}, errors.New("invalid github installation token response")
	}
	if result.Token == "" || !result.ExpiresAt.After(time.Now()) {
		return "", time.Time{}, errors.New("invalid github installation token response")
	}
	return result.Token, result.ExpiresAt, nil
}
func (c *Client) appGet(ctx context.Context, target *url.URL) (*http.Response, error) {
	jwt, err := c.tokens.jwt()
	if err != nil {
		return nil, err
	}
	return c.request(ctx, http.MethodGet, target, jwt, nil)
}
func (c *Client) installationGet(ctx context.Context, id int64, target *url.URL, refreshed *bool) (*http.Response, error) {
	if id <= 0 {
		return nil, errors.New("invalid installation ID")
	}
	for attempt := 0; attempt < 2; attempt++ {
		token, err := c.tokens.token(ctx, id)
		if err != nil {
			return nil, err
		}
		resp, err := c.request(ctx, http.MethodGet, target, token, nil)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusUnauthorized || attempt == 1 || *refreshed {
			return resp, nil
		}
		*refreshed = true
		resp.Body.Close()
		c.tokens.invalidate(id, token)
	}
	panic("unreachable")
}
func readJSON(resp *http.Response, v any) error {
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return responseError(resp)
	}
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		if cause := resp.Request.Context().Err(); cause != nil {
			return cause
		}
		return errors.New("invalid github response")
	}
	return nil
}

// DiscoverInstallation finds the App installation for a repository without inspecting a user identity.
func (c *Client) DiscoverInstallation(ctx context.Context, owner, repo string) (githubpr.InstallationObservation, error) {
	p, err := repoPath(owner, repo)
	if err != nil {
		return githubpr.InstallationObservation{}, err
	}
	resp, err := c.appGet(ctx, c.endpoint(p+"/installation"))
	if err != nil {
		return githubpr.InstallationObservation{}, err
	}
	var raw json.RawMessage
	if err = readJSON(resp, &raw); err != nil {
		return githubpr.InstallationObservation{}, err
	}
	return decodeInstallation(raw)
}

// Repository reads the installation's current repository identity.
func (c *Client) Repository(ctx context.Context, installationID int64, owner, repo string) (githubpr.RepositoryObservation, error) {
	p, err := repoPath(owner, repo)
	if err != nil {
		return githubpr.RepositoryObservation{}, err
	}
	refreshed := false
	resp, err := c.installationGet(ctx, installationID, c.endpoint(p), &refreshed)
	if err != nil {
		return githubpr.RepositoryObservation{}, err
	}
	var raw json.RawMessage
	if err = readJSON(resp, &raw); err != nil {
		return githubpr.RepositoryObservation{}, err
	}
	return decodeRepository(raw)
}

// ResolveRepository locates an immutable repository ID across all installation pages.
func (c *Client) ResolveRepository(ctx context.Context, installationID, repositoryID int64) (githubpr.RepositoryObservation, error) {
	if repositoryID <= 0 {
		return githubpr.RepositoryObservation{}, errors.New("invalid repository ID")
	}
	target := c.endpoint("/installation/repositories")
	target.RawQuery = "per_page=100"
	seen := map[string]bool{}
	refreshed := false
	for target != nil {
		if seen[target.String()] {
			return githubpr.RepositoryObservation{}, errors.New("github pagination cycle")
		}
		seen[target.String()] = true
		resp, err := c.installationGet(ctx, installationID, target, &refreshed)
		if err != nil {
			return githubpr.RepositoryObservation{}, err
		}
		if resp.StatusCode != http.StatusOK {
			err := responseError(resp)
			resp.Body.Close()
			return githubpr.RepositoryObservation{}, err
		}
		next, err := c.next(resp)
		if err != nil {
			resp.Body.Close()
			return githubpr.RepositoryObservation{}, err
		}
		var page struct {
			Repositories []json.RawMessage `json:"repositories"`
		}
		if err = readJSON(resp, &page); err != nil {
			return githubpr.RepositoryObservation{}, err
		}
		if page.Repositories == nil {
			return githubpr.RepositoryObservation{}, errors.New("invalid github repository page")
		}
		for _, raw := range page.Repositories {
			item, err := decodeRepository(raw)
			if err != nil {
				return githubpr.RepositoryObservation{}, err
			}
			if item.ID == repositoryID {
				return item, nil
			}
		}
		target = next
	}
	return githubpr.RepositoryObservation{}, &Error{Code: "not_found", Status: http.StatusNotFound}
}

// ListOpen visits each complete page without retaining the whole repository in memory.
func (c *Client) ListOpen(ctx context.Context, installationID int64, owner, repo string, visit func([]githubpr.Observation) error) error {
	if visit == nil {
		return errors.New("missing page visitor")
	}
	p, err := repoPath(owner, repo)
	if err != nil {
		return err
	}
	target := c.endpoint(p + "/pulls")
	target.RawQuery = "state=open&sort=created&direction=asc&per_page=100"
	seen := map[string]bool{}
	refreshed := false
	for target != nil {
		if seen[target.String()] {
			return errors.New("github pagination cycle")
		}
		seen[target.String()] = true
		resp, err := c.installationGet(ctx, installationID, target, &refreshed)
		if err != nil {
			return err
		}
		if resp.StatusCode != http.StatusOK {
			err := responseError(resp)
			resp.Body.Close()
			return err
		}
		next, err := c.next(resp)
		if err != nil {
			resp.Body.Close()
			return err
		}
		var raw []json.RawMessage
		if err = readJSON(resp, &raw); err != nil {
			return err
		}
		if raw == nil {
			return errors.New("invalid github pull request page")
		}
		items := make([]githubpr.Observation, 0, len(raw))
		for _, v := range raw {
			item, err := decodePullRequest(v)
			if err != nil {
				return err
			}
			items = append(items, item)
		}
		if err = visit(items); err != nil {
			return err
		}
		target = next
	}
	return nil
}

// PullRequest reads the current fact for one number, including closed requests.
func (c *Client) PullRequest(ctx context.Context, installationID int64, owner, repo string, number int64) (githubpr.Observation, error) {
	p, err := repoPath(owner, repo)
	if err != nil {
		return githubpr.Observation{}, err
	}
	if number <= 0 {
		return githubpr.Observation{}, errors.New("invalid pull request number")
	}
	refreshed := false
	resp, err := c.installationGet(ctx, installationID, c.endpoint(fmt.Sprintf("%s/pulls/%d", p, number)), &refreshed)
	if err != nil {
		return githubpr.Observation{}, err
	}
	var raw json.RawMessage
	if err = readJSON(resp, &raw); err != nil {
		return githubpr.Observation{}, err
	}
	return decodePullRequest(raw)
}
func (c *Client) next(resp *http.Response) (*url.URL, error) {
	var next *url.URL
	for _, header := range resp.Header.Values("Link") {
		for _, part := range strings.Split(header, ",") {
			pieces := strings.Split(part, ";")
			if len(pieces) < 2 {
				continue
			}
			rel := false
			for _, p := range pieces[1:] {
				p = strings.TrimSpace(p)
				if strings.HasPrefix(p, "rel=") {
					for _, v := range strings.Fields(strings.Trim(strings.TrimPrefix(p, "rel="), "\"")) {
						if v == "next" {
							rel = true
						}
					}
				}
			}
			if !rel {
				continue
			}
			s := strings.TrimSpace(pieces[0])
			if len(s) < 2 || s[0] != '<' || s[len(s)-1] != '>' || next != nil {
				return nil, errors.New("invalid github next link")
			}
			u, err := url.Parse(s[1 : len(s)-1])
			if err != nil {
				return nil, errors.New("invalid github next link")
			}
			u = resp.Request.URL.ResolveReference(u)
			if !c.sameOrigin(u) || u.Fragment != "" {
				return nil, errors.New("github next link outside API origin")
			}
			next = u
		}
	}
	return next, nil
}

// VerifyAccess reads both repository identity and a minimal open pull request page.
// A successful identity read alone does not prove pull request permission.
func (c *Client) VerifyAccess(ctx context.Context, installationID int64, owner, repo string) (githubpr.RepositoryObservation, error) {
	p, err := repoPath(owner, repo)
	if err != nil {
		return githubpr.RepositoryObservation{}, err
	}
	refreshed := false
	resp, err := c.installationGet(ctx, installationID, c.endpoint(p), &refreshed)
	if err != nil {
		return githubpr.RepositoryObservation{}, err
	}
	var raw json.RawMessage
	if err = readJSON(resp, &raw); err != nil {
		return githubpr.RepositoryObservation{}, err
	}
	repository, err := decodeRepository(raw)
	if err != nil {
		return githubpr.RepositoryObservation{}, err
	}
	target := c.endpoint(p + "/pulls")
	target.RawQuery = "state=open&per_page=1"
	resp, err = c.installationGet(ctx, installationID, target, &refreshed)
	if err != nil {
		return githubpr.RepositoryObservation{}, err
	}
	var page []json.RawMessage
	if err = readJSON(resp, &page); err != nil {
		return githubpr.RepositoryObservation{}, err
	}
	if page == nil {
		return githubpr.RepositoryObservation{}, errors.New("invalid github pull request page")
	}
	for _, item := range page {
		if _, err = decodePullRequest(item); err != nil {
			return githubpr.RepositoryObservation{}, err
		}
	}
	return repository, nil
}
