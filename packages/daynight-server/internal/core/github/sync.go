// Package github owns the business rules for synchronizing Project PR facts.
package github

import (
	"errors"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const (
	LeaseDuration    = 5 * time.Minute
	OperationTimeout = 15 * time.Second
	RetryDelay       = 30 * time.Second
	PublishLimit     = 25
	PendingLimit     = 100
	WorkAccess       = "access"
	WorkPoll         = "poll"
	WorkWebhook      = "webhook"
)

// WorkKind selects the highest-priority work after locking the connection.
// pendingDue must describe a due hint, not merely a nonempty pending set. The
// stored App ID may differ from appID: the caller must then record app_changed
// without contacting the old installation.
func WorkKind(c githubpr.Connection, appID int64, now time.Time, pendingDue bool) string {
	if !c.Enabled || c.AppID == nil || c.InstallationID == nil || c.RepositoryID == nil || c.PollIntervalMinutes < 1 ||
		c.NotBefore != nil && c.NotBefore.After(now) || c.ClaimUntil != nil && c.ClaimUntil.After(now) {
		return ""
	}
	// A changed App requires an explicit reconnect even if configuration later
	// returns to the previous App ID.
	if c.AccessState == "unavailable" && c.AccessReason != nil && *c.AccessReason == "app_changed" {
		return ""
	}
	if *c.AppID != appID {
		return WorkAccess
	}
	// A removed installation cannot be revived by a delayed access signal.
	// Only a new connection generation may resume synchronization.
	if c.AccessState == "unavailable" && c.AccessReason != nil && *c.AccessReason == "installation_missing" {
		return ""
	}
	if c.AccessHintID != nil {
		if c.NextAccessCheckAt == nil || due(c.NextAccessCheckAt, now) {
			return WorkAccess
		}
		return ""
	}
	if due(c.NextAccessCheckAt, now) {
		return WorkAccess
	}
	if c.AccessState != "available" {
		return ""
	}
	if due(c.NextPollAt, now) {
		return WorkPoll
	}
	if pendingDue {
		return WorkWebhook
	}
	return ""
}

func due(at *time.Time, now time.Time) bool { return at != nil && !at.After(now) }

// Normalize verifies the stable base identity and maps GitHub's state without
// using updated_at as an ordering token. pollID is supplied only by full polls.
func Normalize(o githubpr.Observation, projectID string, repositoryID int64, observedAt time.Time, pollID *string) (githubpr.PullRequest, error) {
	if o.BaseRepositoryID != repositoryID || repositoryID <= 0 {
		return githubpr.PullRequest{}, errors.New("github pull request base repository mismatch")
	}
	if projectID == "" || o.Number <= 0 || o.GitHubID <= 0 || o.URL == "" || o.BaseRef == "" || o.HeadSHA == "" || o.CreatedAt.IsZero() || o.UpdatedAt.IsZero() {
		return githubpr.PullRequest{}, errors.New("invalid github pull request observation")
	}
	state := o.State
	switch state {
	case "open":
		if o.MergedAt != nil {
			return githubpr.PullRequest{}, errors.New("open github pull request has merge time")
		}
	case "closed":
		if o.MergedAt != nil {
			state = "merged"
		}
	default:
		return githubpr.PullRequest{}, errors.New("invalid github pull request state")
	}
	// Closed facts do not count as an open item seen during the poll.
	if state != "open" {
		pollID = nil
	}
	return githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{
		ProjectID: projectID, Number: o.Number, GitHubID: o.GitHubID, URL: o.URL, Title: o.Title,
		AuthorID: o.AuthorID, AuthorLogin: o.AuthorLogin, State: state, Draft: o.Draft, BaseRef: o.BaseRef,
		HeadRepositoryID: o.HeadRepositoryID, HeadRepositoryFullName: o.HeadRepositoryFullName,
		HeadRef: o.HeadRef, HeadSHA: o.HeadSHA, GitHubCreatedAt: o.CreatedAt, GitHubUpdatedAt: o.UpdatedAt,
		GitHubClosedAt: o.ClosedAt, GitHubMergedAt: o.MergedAt, ObservedAt: observedAt, SeenPollID: pollID,
	}, Description: o.Description}, nil
}

// RepositoryParts parses the canonical GitHub full name, never substituting a
// different repository when the original path was reused.
func RepositoryParts(fullName string) (string, string, error) {
	parts := strings.Split(fullName, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || parts[0] == "." || parts[1] == "." || parts[0] == ".." || parts[1] == ".." {
		return "", "", errors.New("invalid github repository full name")
	}
	return parts[0], parts[1], nil
}

// Runtime copies all worker-owned facts before changing a specific channel.
// Call on the connection reread under the Project lock immediately before save.
func Runtime(c githubpr.Connection) store.GitHubRuntimeWrite {
	return store.GitHubRuntimeWrite{
		ExpectedRevision: c.Revision, Revision: c.Revision + 1,
		AccessState: c.AccessState, AccessReason: c.AccessReason, AccessCheckedAt: c.AccessCheckedAt,
		NextAccessCheckAt: c.NextAccessCheckAt, NextPollAt: c.NextPollAt, NotBefore: c.NotBefore,
		LastPollAttemptAt: c.LastPollAttemptAt, LastFullSuccessAt: c.LastFullSuccessAt,
		LastFullGeneration: c.LastFullGeneration, PollErrorCode: c.PollErrorCode, PollErrorMessage: c.PollErrorMessage,
		PollErrorAt: c.PollErrorAt, LastWebhookAttemptAt: c.LastWebhookAttemptAt,
		LastWebhookSuccessAt: c.LastWebhookSuccessAt, WebhookErrorCode: c.WebhookErrorCode,
		WebhookErrorMessage: c.WebhookErrorMessage, WebhookErrorAt: c.WebhookErrorAt,
	}
}

// Failure describes a classified error; Message is deliberately generated from
// the stable code rather than an upstream error that may contain private data.
type Failure struct {
	Code    string
	RetryAt time.Time
}

func (f Failure) Message() string {
	switch f.Code {
	case "github_rate_limited":
		return "GitHub rate limit reached"
	case "github_permission_denied":
		return "GitHub access denied"
	case "github_installation_missing":
		return "GitHub installation unavailable"
	case "github_repository_mismatch":
		return "GitHub repository identity does not match"
	case "app_changed":
		return "GitHub App changed; reconnect is required"
	default:
		return "GitHub synchronization failed"
	}
}

// RetryAt applies both the local recovery delay and any upstream rate limit.
func RetryAt(now time.Time, f Failure) time.Time {
	next := now.Add(RetryDelay)
	if f.RetryAt.After(next) {
		next = f.RetryAt
	}
	return next
}

// IntervalAfter supports the full positive int32 minute range without overflowing
// time.Duration, whose range is shorter than the supported configuration.
func IntervalAfter(now time.Time, minutes int32) time.Time {
	return now.UTC().AddDate(0, 0, int(minutes/1440)).Add(time.Duration(minutes%1440) * time.Minute)
}

func str(v string) *string           { return &v }
func instant(v time.Time) *time.Time { return &v }

func PollAttempt(r *store.GitHubRuntimeWrite, now time.Time) { r.LastPollAttemptAt = instant(now) }

// PollSuccess is valid only after all pages and known absences are confirmed.
func PollSuccess(r *store.GitHubRuntimeWrite, c githubpr.Connection, now time.Time) {
	r.LastFullSuccessAt = instant(now)
	generation := c.Generation
	r.LastFullGeneration = &generation
	next := IntervalAfter(now, c.PollIntervalMinutes)
	r.NextPollAt = &next
	r.PollErrorCode, r.PollErrorMessage, r.PollErrorAt = nil, nil, nil
	r.NotBefore = nil
}

func PollFailure(r *store.GitHubRuntimeWrite, now time.Time, f Failure) {
	next := RetryAt(now, f)
	r.NextPollAt = &next
	r.PollErrorCode, r.PollErrorMessage, r.PollErrorAt = str(f.Code), str(f.Message()), instant(now)
	if f.Code == "github_rate_limited" {
		r.NotBefore = &next
	}
}

func WebhookAttempt(r *store.GitHubRuntimeWrite, now time.Time) {
	r.LastWebhookAttemptAt = instant(now)
}

// WebhookSuccess clears the channel error only after the pending set is empty.
func WebhookSuccess(r *store.GitHubRuntimeWrite, now time.Time, pending bool) {
	r.LastWebhookSuccessAt = instant(now)
	if !pending {
		r.WebhookErrorCode, r.WebhookErrorMessage, r.WebhookErrorAt = nil, nil, nil
	}
}

func WebhookFailure(r *store.GitHubRuntimeWrite, now time.Time, f Failure) {
	r.WebhookErrorCode, r.WebhookErrorMessage, r.WebhookErrorAt = str(f.Code), str(f.Message()), instant(now)
	if f.Code == "github_rate_limited" {
		next := RetryAt(now, f)
		r.NotBefore = &next
	}
}

// AccessSuccess schedules a full reconciliation on recovery. A successful
// access check never clears either independent channel's error.
func AccessSuccess(r *store.GitHubRuntimeWrite, c githubpr.Connection, now time.Time) {
	r.AccessState, r.AccessReason, r.AccessCheckedAt, r.NextAccessCheckAt = "available", nil, instant(now), nil
	r.NotBefore = nil
	if c.AccessState != "available" {
		r.NextPollAt = instant(now)
	}
}

// AccessUnavailable is only for confirmed denial. Permanent removal or App
// change requires reconnect; recoverable denial rechecks at the poll interval.
func AccessUnavailable(r *store.GitHubRuntimeWrite, c githubpr.Connection, now time.Time, reason string, permanent bool) {
	r.AccessState, r.AccessReason, r.AccessCheckedAt = "unavailable", str(reason), instant(now)
	r.NextPollAt = nil
	if permanent {
		r.NextAccessCheckAt = nil
	} else {
		next := IntervalAfter(now, c.PollIntervalMinutes)
		r.NextAccessCheckAt = &next
	}
}
