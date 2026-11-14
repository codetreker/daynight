// Package github adapts GitHub integration operations to HTTP.
package github

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type ReadOperations interface {
	Get(context.Context, model.Principal, string) (coregithub.Status, error)
	List(context.Context, model.Principal, string, coregithub.ListRequest) (coregithub.Page, error)
	Detail(context.Context, model.Principal, string, int64) (coregithub.Detail, error)
}
type RouteAuthentication interface {
	Require(httpx.AuthenticatedHandler) http.HandlerFunc
}
type handler struct {
	reader ReadOperations
	logger *slog.Logger
}

// RegisterReadRoutes mounts authenticated read-only project GitHub resources.
func RegisterReadRoutes(mux *http.ServeMux, reader ReadOperations, auth RouteAuthentication, logger *slog.Logger) {
	h := &handler{reader: reader, logger: logger}
	mux.HandleFunc("GET /api/v1/projects/{projectId}/github", auth.Require(h.status))
	mux.HandleFunc("GET /api/v1/projects/{projectId}/pull-requests", auth.Require(h.list))
	mux.HandleFunc("GET /api/v1/projects/{projectId}/pull-requests/{number}", auth.Require(h.detail))
	mux.HandleFunc("/api/v1/projects/{projectId}/github", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc("/api/v1/projects/{projectId}/pull-requests", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc("/api/v1/projects/{projectId}/pull-requests/{number}", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
}
func (h *handler) run(w http.ResponseWriter, r *http.Request, p model.Principal, phase string, fn func(string) (any, error)) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", p.UserID)
	id, err := model.CanonicalID(r.PathValue("projectId"))
	if err != nil {
		httpx.WriteError(w, r, logger, "github", phase, err)
		return
	}
	value, err := fn(id)
	if err != nil {
		httpx.WriteError(w, r, logger.With("project_id", id), "github", phase, err)
		return
	}
	httpx.WriteJSON(w, r, logger, http.StatusOK, value)
}
func (h *handler) status(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "status", func(id string) (any, error) {
		if _, err := query(r); err != nil {
			return nil, err
		}
		result, err := h.reader.Get(r.Context(), p, id)
		if err != nil {
			return nil, err
		}
		return statusResponse(result)
	})
}
func (h *handler) list(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "list", func(id string) (any, error) {
		v, err := query(r, "state", "q", "limit", "cursor")
		if err != nil {
			return nil, err
		}
		input := coregithub.ListRequest{State: "active", Limit: 20}
		if x, ok := v["state"]; ok {
			input.State = x[0]
		}
		if x, ok := v["q"]; ok {
			input.Query = x[0]
		}
		if x, ok := v["cursor"]; ok {
			input.Cursor = x[0]
		}
		if x, ok := v["limit"]; ok {
			n, e := strconv.Atoi(x[0])
			if e != nil || n < 1 || n > 100 || strconv.Itoa(n) != x[0] {
				return nil, httpx.InvalidInput("limit must be an integer from 1 to 100")
			}
			input.Limit = n
		}
		if input.State != "active" && input.State != "closed" && input.State != "merged" && input.State != "all" {
			return nil, httpx.InvalidInput("state must be active, closed, merged or all")
		}
		if !utf8.ValidString(input.Query) || strings.ContainsRune(input.Query, 0) || len(input.Query) > 1024 {
			return nil, httpx.InvalidInput("q must be valid UTF-8 without NUL and at most 1024 bytes")
		}
		result, err := h.reader.List(r.Context(), p, id, input)
		if err != nil {
			return nil, err
		}
		return pageResponse(result)
	})
}
func (h *handler) detail(w http.ResponseWriter, r *http.Request, p model.Principal) {
	h.run(w, r, p, "detail", func(id string) (any, error) {
		if _, err := query(r); err != nil {
			return nil, err
		}
		s := r.PathValue("number")
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil || n <= 0 || strconv.FormatInt(n, 10) != s {
			return nil, httpx.InvalidInput("number must be a positive decimal integer")
		}
		result, err := h.reader.Detail(r.Context(), p, id, n)
		if err != nil {
			return nil, err
		}
		summary, err := summaryResponse(result.Connection, result.PullRequest.PullRequestSummary)
		if err != nil {
			return nil, err
		}
		return api.PullRequestDetail{PullRequestSummary: summary, Description: result.PullRequest.Description}, nil
	})
}
func query(r *http.Request, allowed ...string) (url.Values, error) {
	if len(r.URL.RawQuery) > transport.MaxRawQueryBytes {
		return nil, &httpx.URITooLongError{}
	}
	v, err := url.ParseQuery(r.URL.RawQuery)
	if err != nil {
		return nil, httpx.InvalidInput("query parameters must be valid URL encoding")
	}
	for k, values := range v {
		valid := false
		for _, a := range allowed {
			if k == a {
				valid = true
				break
			}
		}
		if !valid || len(values) != 1 || (values[0] == "" && k != "q") {
			return nil, httpx.InvalidInput("invalid query parameter")
		}
	}
	return v, nil
}
func decimal(v int64) string { return strconv.FormatInt(v, 10) }
func optionalDecimal(v *int64) *string {
	if v == nil {
		return nil
	}
	s := decimal(*v)
	return &s
}
func utc(t *time.Time) *time.Time {
	if t == nil {
		return nil
	}
	v := t.UTC()
	return &v
}
func syncError(code, message *string, at *time.Time) (*api.GitHubSyncError, error) {
	if code == nil && message == nil && at == nil {
		return nil, nil
	}
	if code == nil || message == nil || at == nil {
		return nil, fmt.Errorf("incomplete persisted GitHub synchronization error")
	}
	return &api.GitHubSyncError{Code: *code, Message: *message, At: utc(at)}, nil
}
func statusResponse(s coregithub.Status) (api.GitHubStatus, error) {
	c := s.Connection
	out := api.GitHubStatus{ProjectID: c.ProjectID, Version: decimal(c.Version), Revision: decimal(c.Revision), ServiceAvailable: s.ServiceAvailable, SyncEnabled: c.SyncEnabled, Connection: "not_connected", PollIntervalMinutes: c.PollIntervalMinutes}
	if c.InstallationID != nil {
		if c.InstallationAccountLogin == nil {
			return out, fmt.Errorf("incomplete persisted GitHub installation")
		}
		out.Installation = &api.GitHubInstallation{ID: decimal(*c.InstallationID), AccountLogin: *c.InstallationAccountLogin}
		out.Connection = "disconnected"
		if c.Enabled {
			out.Connection = "connected"
			if c.AccessState == "unavailable" {
				out.Connection = "unavailable"
			}
		}
	}
	if c.RepositoryID != nil {
		if c.RepositoryFullName == nil {
			return out, fmt.Errorf("incomplete persisted GitHub repository")
		}
		out.Repository = &api.GitHubRepository{ID: decimal(*c.RepositoryID), FullName: *c.RepositoryFullName, Private: c.RepositoryPrivate}
	}
	out.Initializing = c.Enabled && c.SyncEnabled && (c.LastFullGeneration == nil || *c.LastFullGeneration != c.Generation)
	pollErr, err := syncError(c.PollErrorCode, c.PollErrorMessage, c.PollErrorAt)
	if err != nil {
		return out, err
	}
	hookErr, err := syncError(c.WebhookErrorCode, c.WebhookErrorMessage, c.WebhookErrorAt)
	if err != nil {
		return out, err
	}
	out.Poll = api.GitHubPollStatus{Running: c.SyncEnabled && c.ClaimKind != nil && *c.ClaimKind == "poll", LastAttemptAt: utc(c.LastPollAttemptAt), LastSuccessAt: utc(c.LastFullSuccessAt), NextAttemptAt: nextAttempt(c), Error: pollErr}
	out.Webhook = api.GitHubWebhookStatus{Running: c.SyncEnabled && c.ClaimKind != nil && *c.ClaimKind == "webhook", LastReceivedAt: utc(c.LastWebhookReceivedAt), LastAttemptAt: utc(c.LastWebhookAttemptAt), LastSuccessAt: utc(c.LastWebhookSuccessAt), Error: hookErr}
	return out, nil
}

// nextAttempt preserves the selected persisted schedule while honoring a later
// remote-request deadline. A deadline alone does not schedule an operation.
func nextAttempt(c githubpr.Connection) *time.Time {
	if !c.SyncEnabled {
		return nil
	}
	planned := c.NextPollAt
	if c.AccessState == "unavailable" {
		planned = c.NextAccessCheckAt
	}
	if planned == nil {
		return nil
	}
	if c.NotBefore != nil && c.NotBefore.After(*planned) {
		return utc(c.NotBefore)
	}
	return utc(planned)
}
func summaryResponse(c githubpr.Connection, p githubpr.PullRequestSummary) (api.PullRequestSummary, error) {
	var out api.PullRequestSummary
	if c.RepositoryID == nil || c.RepositoryFullName == nil {
		return out, fmt.Errorf("missing persisted GitHub base repository")
	}
	if (p.AuthorID == nil) != (p.AuthorLogin == nil) {
		return out, fmt.Errorf("incomplete persisted GitHub author")
	}
	if p.AuthorID != nil {
		out.Author = &api.PullRequestAuthor{ID: decimal(*p.AuthorID), Login: *p.AuthorLogin}
	}
	out.Number = decimal(p.Number)
	out.ID = decimal(p.GitHubID)
	out.URL = p.URL
	out.Title = p.Title
	out.State = p.State
	out.Draft = p.Draft
	out.Base = api.PullRequestBase{RepositoryID: decimal(*c.RepositoryID), RepositoryFullName: *c.RepositoryFullName, Ref: p.BaseRef}
	out.Head = api.PullRequestHead{RepositoryID: optionalDecimal(p.HeadRepositoryID), RepositoryFullName: p.HeadRepositoryFullName, Ref: p.HeadRef, SHA: p.HeadSHA}
	out.CreatedAt = p.GitHubCreatedAt.UTC()
	out.UpdatedAt = p.GitHubUpdatedAt.UTC()
	out.ClosedAt = utc(p.GitHubClosedAt)
	out.MergedAt = utc(p.GitHubMergedAt)
	out.ObservedAt = p.ObservedAt.UTC()
	out.Revision = decimal(p.Revision)
	return out, nil
}
func pageResponse(p coregithub.Page) (api.PullRequestPage, error) {
	out := api.PullRequestPage{ProjectID: p.Connection.ProjectID, Revision: decimal(p.Connection.Revision), Items: make([]api.PullRequestSummary, 0, len(p.Items)), Total: decimal(p.Total), Counts: api.PullRequestCounts{Active: decimal(p.Counts.Active), Closed: decimal(p.Counts.Closed), Merged: decimal(p.Counts.Merged), All: decimal(p.Counts.All)}, NextCursor: p.NextCursor, PreviousCursor: p.PreviousCursor}
	for _, item := range p.Items {
		v, err := summaryResponse(p.Connection, item)
		if err != nil {
			return out, err
		}
		out.Items = append(out.Items, v)
	}
	return out, nil
}
