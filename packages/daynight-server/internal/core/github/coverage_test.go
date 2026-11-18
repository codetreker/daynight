package github

import (
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestFirstPublicationCoverageBoundaries(t *testing.T) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	end := start.Add(time.Minute)
	period := &store.GitHubCoveragePeriod{StartedAt: start, EndedAt: &end}
	for _, tc := range []struct {
		name, state string
		at          *time.Time
		known, want bool
	}{
		{"open", "open", nil, false, true},
		{"known old closed", "closed", nil, true, true},
		{"start included", "closed", &start, false, true},
		{"end excluded", "closed", &end, false, false},
		{"missing close", "closed", nil, false, false},
		{"merge within", "merged", &start, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{State: tc.state}}
			if tc.state == "merged" {
				p.GitHubMergedAt = tc.at
			} else {
				p.GitHubClosedAt = tc.at
			}
			facts := store.GitHubPublicationFacts{Period: period}
			if tc.known {
				facts.Current = &githubpr.PullRequest{}
			}
			if got := EligibleFirstPublication(p, facts); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
	if !StaleObservation(githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{State: "open"}}, store.GitHubPublicationFacts{Current: &githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{State: "merged"}}}) {
		t.Fatal("merged observation regressed")
	}
	old := start.Add(-time.Minute)
	current := &githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{State: "closed", GitHubClosedAt: &start, GitHubUpdatedAt: start}}
	stale := githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{State: "closed", GitHubClosedAt: &old, GitHubUpdatedAt: old}}
	if !StaleObservation(stale, store.GitHubPublicationFacts{Current: current}) {
		t.Fatal("older conflicting close replaced newer close")
	}
	merged := githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{State: "merged", GitHubClosedAt: &old, GitHubMergedAt: &old, GitHubUpdatedAt: old}}
	if StaleObservation(merged, store.GitHubPublicationFacts{Current: current}) {
		t.Fatal("irreversible merge was rejected")
	}
	current.State, current.GitHubMergedAt = "merged", &start
	if !StaleObservation(merged, store.GitHubPublicationFacts{Current: current}) {
		t.Fatal("older conflicting merge replaced newer merge")
	}
}
