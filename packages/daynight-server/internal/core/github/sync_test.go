package github

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"strings"
	"testing"
	"time"
)

func TestWorkKindPriorityAndAdmission(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	app, installation, repo := int64(1), int64(2), int64(3)
	hint := "hint"
	future := now.Add(time.Second)
	c := githubpr.Connection{Enabled: true, SyncEnabled: true, AppID: &app, InstallationID: &installation, RepositoryID: &repo, PollIntervalMinutes: 5, AccessState: "available", NextPollAt: &now}
	check := func(want string, pending bool) {
		t.Helper()
		if got := WorkKind(c, app, now, pending); got != want {
			t.Fatalf("work=%q want %q", got, want)
		}
	}
	check(WorkPoll, true)
	c.SyncEnabled = false
	check("", true)
	c.SyncEnabled = true
	c.AccessHintID = &hint
	check(WorkAccess, true)
	c.NextAccessCheckAt = &future
	check("", true)
	c.NextAccessCheckAt = &now
	check(WorkAccess, true)
	c.NextAccessCheckAt = nil
	c.AccessHintID = nil
	c.NextPollAt = &future
	check(WorkWebhook, true)
	check("", false)
	c.ClaimUntil = &future
	check("", true)
	c.ClaimUntil = &now
	c.NotBefore = &future
	check("", true)
	c.NotBefore = nil
	c.AccessState = "unavailable"
	c.NextAccessCheckAt = &now
	check(WorkAccess, true)
	c.NextAccessCheckAt = nil
	check("", true)
	if WorkKind(c, app+1, now, true) != WorkAccess {
		t.Fatal("changed app")
	}
	changed := "app_changed"
	c.AccessReason = &changed
	if WorkKind(c, app+1, now, true) != "" {
		t.Fatal("repeated app change")
	}
	c.AccessHintID, c.NextAccessCheckAt = &hint, &now
	if WorkKind(c, app, now, true) != "" {
		t.Fatal("reverted App configuration revived old connection")
	}
	c.Enabled = false
	check("", true)
}

func TestNormalizeCurrentFact(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	desc, seen := "内容\n", "poll"
	o := githubpr.Observation{Number: 1, GitHubID: 2, URL: "https://github.test/pull/1", BaseRepositoryID: 3, State: "open", BaseRef: "main", HeadSHA: "first", CreatedAt: now, UpdatedAt: now, Description: &desc, Draft: true}
	got, err := Normalize(o, "project", 3, now, &seen)
	if err != nil || got.State != "open" || got.SeenPollID == nil || *got.SeenPollID != seen || got.Description == nil || *got.Description != desc || !got.Draft || got.AuthorID != nil || got.HeadRepositoryID != nil {
		t.Fatalf("open: %+v %v", got, err)
	}
	o.HeadSHA = "second"
	got, err = Normalize(o, "project", 3, now, &seen)
	if err != nil || got.HeadSHA != "second" {
		t.Fatalf("same second head: %+v %v", got, err)
	}
	o.State = "closed"
	got, err = Normalize(o, "project", 3, now, &seen)
	if err != nil || got.State != "closed" || got.SeenPollID != nil {
		t.Fatalf("closed: %+v %v", got, err)
	}
	o.MergedAt = &now
	got, err = Normalize(o, "project", 3, now, &seen)
	if err != nil || got.State != "merged" {
		t.Fatalf("merged: %+v %v", got, err)
	}
	o.State = "open"
	o.MergedAt = nil
	got, err = Normalize(o, "project", 3, now, &seen)
	if err != nil || got.State != "open" {
		t.Fatalf("reopened: %+v %v", got, err)
	}
	if _, err = Normalize(o, "project", 4, now, &seen); err == nil {
		t.Fatal("wrong repo")
	}
	o.State = "private upstream content"
	if _, err = Normalize(o, "project", 3, now, &seen); err == nil || strings.Contains(err.Error(), o.State) {
		t.Fatalf("state leaked: %v", err)
	}
	o.State = "open"
	o.MergedAt = &now
	if _, err = Normalize(o, "project", 3, now, &seen); err == nil {
		t.Fatal("open merged")
	}
}

func TestRuntimeKeepsChannelsIndependent(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	old := now.Add(-time.Hour)
	code := "previous"
	c := githubpr.Connection{Revision: 4, Generation: 7, PollIntervalMinutes: 8, AccessState: "available", LastFullSuccessAt: &old, WebhookErrorCode: &code, PollErrorCode: &code}
	r := Runtime(c)
	if r.ExpectedRevision != 4 || r.Revision != 5 {
		t.Fatal("runtime version")
	}
	PollAttempt(&r, now)
	PollFailure(&r, now, Failure{Code: "github_rate_limited", RetryAt: now.Add(time.Minute)})
	if !r.NextPollAt.Equal(now.Add(time.Minute)) || !r.NotBefore.Equal(*r.NextPollAt) || !r.LastFullSuccessAt.Equal(old) || r.WebhookErrorCode != &code {
		t.Fatalf("poll failure: %+v", r)
	}
	PollSuccess(&r, c, now)
	if !r.NextPollAt.Equal(now.Add(8*time.Minute)) || r.PollErrorCode != nil || r.WebhookErrorCode != &code || *r.LastFullGeneration != 7 || r.NotBefore != nil {
		t.Fatalf("poll success: %+v", r)
	}
	WebhookAttempt(&r, now)
	WebhookFailure(&r, now, Failure{Code: "github_unavailable"})
	WebhookSuccess(&r, now, true)
	if r.WebhookErrorCode == nil || !r.LastFullSuccessAt.Equal(now) {
		t.Fatalf("pending: %+v", r)
	}
	WebhookSuccess(&r, now, false)
	if r.WebhookErrorCode != nil || r.LastWebhookSuccessAt == nil {
		t.Fatalf("success: %+v", r)
	}
	if got := RetryAt(now, Failure{}); !got.Equal(now.Add(30 * time.Second)) {
		t.Fatalf("retry: %s", got)
	}
}

func TestAccessRecoveryAndRepositoryNames(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	c := githubpr.Connection{PollIntervalMinutes: 5, AccessState: "available"}
	r := Runtime(c)
	AccessUnavailable(&r, c, now, "permission_denied", false)
	if r.NextPollAt != nil || !r.NextAccessCheckAt.Equal(now.Add(5*time.Minute)) {
		t.Fatalf("denial: %+v", r)
	}
	c.AccessState = "unavailable"
	AccessSuccess(&r, c, now)
	if r.AccessState != "available" || r.AccessReason != nil || !r.NextPollAt.Equal(now) {
		t.Fatalf("recovery: %+v", r)
	}
	AccessUnavailable(&r, c, now, "installation_missing", true)
	if r.NextAccessCheckAt != nil {
		t.Fatal("permanent removal scheduled recheck")
	}
	owner, repo, err := RepositoryParts("owner/name")
	if err != nil || owner != "owner" || repo != "name" {
		t.Fatal(owner, repo, err)
	}
	for _, name := range []string{"", "owner", "owner/", "../name", "owner/a/b"} {
		if _, _, err := RepositoryParts(name); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
}

func TestIntervalAfterFullRange(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	got := IntervalAfter(now, 2147483647)
	want := now.AddDate(0, 0, 2147483647/1440).Add(time.Duration(2147483647%1440) * time.Minute)
	if !got.Equal(want) || !got.After(now) {
		t.Fatalf("full interval: %s", got)
	}
}

func TestRemovedInstallationIgnoresDelayedAccessHint(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	app, installation, repo := int64(1), int64(2), int64(3)
	reason, hint := "installation_missing", "late"
	c := githubpr.Connection{Enabled: true, SyncEnabled: true, AppID: &app, InstallationID: &installation, RepositoryID: &repo, PollIntervalMinutes: 5, AccessState: "unavailable", AccessReason: &reason, AccessHintID: &hint, NextAccessCheckAt: &now}
	if got := WorkKind(c, app, now, true); got != "" {
		t.Fatalf("late hint revived removed installation: %q", got)
	}
	if got := WorkKind(c, app+1, now, true); got != WorkAccess {
		t.Fatalf("changed App was not reported: %q", got)
	}
	c.Generation++
	c.AccessState, c.AccessReason = "unknown", nil
	if got := WorkKind(c, app, now, true); got != WorkAccess {
		t.Fatalf("new connection did not recover: %q", got)
	}
}

func TestFailureMessagesAndWebhookRateLimit(t *testing.T) {
	for _, tc := range []struct{ code, want string }{
		{"github_rate_limited", "GitHub rate limit reached"},
		{"github_permission_denied", "GitHub access denied"},
		{"github_installation_missing", "GitHub installation unavailable"},
		{"github_repository_mismatch", "GitHub repository identity does not match"},
		{"app_changed", "GitHub App changed; reconnect is required"},
		{"github_unavailable", "GitHub synchronization failed"},
	} {
		t.Run(tc.code, func(t *testing.T) {
			if got := (Failure{Code: tc.code}).Message(); got != tc.want {
				t.Fatalf("message %q want %q", got, tc.want)
			}
		})
	}
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	pollError := "poll-error"
	c := githubpr.Connection{PollErrorCode: &pollError}
	r := Runtime(c)
	retry := now.Add(2 * time.Minute)
	WebhookFailure(&r, now, Failure{Code: "github_rate_limited", RetryAt: retry})
	if r.WebhookErrorCode == nil || *r.WebhookErrorCode != "github_rate_limited" || r.NotBefore == nil || !r.NotBefore.Equal(retry) || r.PollErrorCode == nil || *r.PollErrorCode != pollError {
		t.Fatalf("rate limit state: %+v", r)
	}
	r = Runtime(c)
	WebhookFailure(&r, now, Failure{Code: "github_rate_limited", RetryAt: now.Add(time.Second)})
	if r.NotBefore == nil || !r.NotBefore.Equal(now.Add(30*time.Second)) {
		t.Fatalf("minimum retry: %+v", r.NotBefore)
	}
}
