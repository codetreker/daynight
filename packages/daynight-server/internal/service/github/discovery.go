package github

import (
	"context"
	"errors"
	"log/slog"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

func terminalAt(p githubpr.PullRequest) *time.Time {
	if p.State == "merged" {
		return p.GitHubMergedAt
	}
	if p.State == "closed" {
		return p.GitHubClosedAt
	}
	return nil
}

func (r *run) publicationFacts(ctx context.Context, p githubpr.PullRequest) (store.GitHubPublicationFacts, error) {
	var facts store.GitHubPublicationFacts
	c, err := r.tx(ctx, func(ctx context.Context, d store.GitHubWorkDAO) error {
		if _, err := d.Connection(ctx); err != nil {
			return err
		}
		var valid bool
		var err error
		facts, valid, err = d.PublicationFacts(ctx, r.lease, *r.connection.RepositoryID, p.Number, terminalAt(p))
		return require(valid, err)
	})
	return facts, committed(c, err)
}

func summaryPull(s remote.PullSummary) githubpr.PullRequest {
	state := s.State
	if s.MergedAt != nil {
		state = "merged"
	}
	return githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{Number: s.Number, State: state, GitHubUpdatedAt: s.UpdatedAt, GitHubClosedAt: s.ClosedAt, GitHubMergedAt: s.MergedAt}}
}

// discover collects all pages before selecting candidates so an older duplicate
// cannot exclude a newer in-coverage observation of the same number.
func (r *run) discover(ctx context.Context, owner, name string) error {
	byNumber := map[int64][]remote.PullSummary{}
	order := []int64{}
	progress := discoveryProgress{}
	listStage := "list"
	repositoryID := *r.connection.RepositoryID
	truncated, err := r.remote.ListAll(ctx, *r.connection.InstallationID, repositoryID, owner, name, func(page []remote.PullSummary) error {
		for _, s := range page {
			if s.RepositoryID != repositoryID {
				return errors.New("github pull request base repository mismatch")
			}
			if _, ok := byNumber[s.Number]; !ok {
				order = append(order, s.Number)
			}
			byNumber[s.Number] = append(byNumber[s.Number], s)
		}
		progress.pages++
		listStage = "hint"
		if err := r.withDiscoveryProgress(progress).pollHint(ctx, owner, name); err != nil {
			return err
		}
		listStage = "list"
		return nil
	})
	if err != nil {
		r.discoveryFailure(ctx, progress, listStage, 0, err)
		return err
	}
	for _, n := range order {
		summaries := byNumber[n]
		eligible := false
		known := false
		for _, s := range summaries {
			p := summaryPull(s)
			facts, e := r.publicationFacts(ctx, p)
			if e != nil {
				r.discoveryFailure(ctx, progress, "selection", n, e)
				return e
			}
			if facts.Current != nil {
				known = true
				break
			}
			if core.EligibleFirstPublication(p, facts) {
				eligible = true
			}
		}
		if known || !eligible {
			continue
		}
		progress.candidates++
		o, e := r.checkedDetailWithLog(ctx, owner, name, n, summaries, r.withDiscoveryProgress(progress).log)
		if e != nil {
			return e
		}
		count, e := r.publishCount(ctx, []githubpr.Observation{o}, &r.lease.Token)
		progress.published += count
		if e != nil {
			r.discoveryFailure(ctx, progress, "publish", n, e)
			return e
		}
		if e = r.withDiscoveryProgress(progress).pollHint(ctx, owner, name); e != nil {
			r.discoveryFailure(ctx, progress, "hint", 0, e)
			return e
		}
	}
	result := "natural_end"
	if truncated {
		result = "truncated"
	}
	r.withDiscoveryProgress(progress).log.InfoContext(ctx, "github all-state discovery", "phase", "discovery", "result", result)
	return nil
}

func observationState(o githubpr.Observation) string {
	if o.MergedAt != nil {
		return "merged"
	}
	return o.State
}
func sameTerminalTime(a, b *time.Time) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && a.Equal(*b))
}
func (r *run) rememberFacts(number int64, facts store.GitHubPublicationFacts) {
	if r.confirmed == nil {
		r.confirmed = make(map[int64]*githubpr.PullRequest)
	}
	r.confirmed[number] = facts.Current
}

func (r *run) changedSinceConfirmation(p githubpr.PullRequest, facts store.GitHubPublicationFacts) bool {
	before, observed := r.confirmed[p.Number]
	if !observed {
		return false
	}
	now := facts.Current
	if now == nil {
		return before != nil
	}
	if !currentConflicts(*now, p) || (p.State == "merged" && now.State != "merged") {
		return false
	}
	if before == nil {
		return true
	}
	return before.GitHubID != now.GitHubID || before.State != now.State || !before.ObservedAt.Equal(now.ObservedAt) || !before.GitHubUpdatedAt.Equal(now.GitHubUpdatedAt) || !sameTerminalTime(before.GitHubClosedAt, now.GitHubClosedAt) || !sameTerminalTime(before.GitHubMergedAt, now.GitHubMergedAt)
}

func currentConflicts(current, incoming githubpr.PullRequest) bool {
	return current.State != incoming.State || !sameTerminalTime(current.GitHubClosedAt, incoming.GitHubClosedAt) || !sameTerminalTime(current.GitHubMergedAt, incoming.GitHubMergedAt)
}
func sameDetail(a, b githubpr.Observation) bool {
	return a.Number == b.Number && a.BaseRepositoryID == b.BaseRepositoryID && a.GitHubID == b.GitHubID && observationState(a) == observationState(b) && a.UpdatedAt.Equal(b.UpdatedAt) && sameTerminalTime(a.ClosedAt, b.ClosedAt) && sameTerminalTime(a.MergedAt, b.MergedAt)
}

// checkedDetail fences the stored fact before fetching. On a same-second
// conflict it confirms the current-detail endpoint twice; that endpoint's
// current-fact contract does not detect identical stale upstream responses.
func (r *run) checkedDetail(ctx context.Context, owner, name string, n int64, summaries []remote.PullSummary) (githubpr.Observation, error) {
	return r.checkedDetailWithLog(ctx, owner, name, n, summaries, r.log)
}

func (r *run) checkedDetailWithLog(ctx context.Context, owner, name string, n int64, summaries []remote.PullSummary, logger *slog.Logger) (result githubpr.Observation, failure error) {
	stage := "initial"
	defer func() {
		attrs := []any{"phase", "detail", "stage", stage, "number", n}
		if failure != nil {
			attrs = append(attrs, "result", "failed")
			attrs = append(attrs, appErrorAttributes(failure)...)
			logger.WarnContext(ctx, "github detail check", attrs...)
			return
		}
		logger.InfoContext(ctx, "github detail check", append(attrs, "result", "success")...)
	}()
	read := func() (githubpr.Observation, error) {
		o, err := r.remote.PullRequest(ctx, *r.connection.InstallationID, owner, name, n)
		if err != nil {
			return o, err
		}
		if o.Number != n || o.BaseRepositoryID != *r.connection.RepositoryID {
			return o, errors.New("github pull request identity mismatch")
		}
		return o, nil
	}
	before, err := r.publicationFacts(ctx, githubpr.PullRequest{PullRequestSummary: githubpr.PullRequestSummary{Number: n}})
	if err != nil {
		return githubpr.Observation{}, err
	}
	r.rememberFacts(n, before)
	o, err := read()
	if err != nil {
		return o, err
	}
	p, err := core.Normalize(o, r.project, *r.connection.RepositoryID, time.Time{}, nil)
	if err != nil {
		return o, err
	}
	facts, err := r.publicationFacts(ctx, p)
	if err != nil {
		return o, err
	}
	if r.changedSinceConfirmation(p, facts) {
		return o, errObservationConflict
	}
	retry := facts.Current != nil && currentConflicts(*facts.Current, p) && !facts.Current.GitHubUpdatedAt.Before(p.GitHubUpdatedAt)
	for _, s := range summaries {
		sp := summaryPull(s)
		if sp.State == "merged" && p.State != "merged" {
			retry = true
		}
		if s.UpdatedAt.After(o.UpdatedAt) || (s.UpdatedAt.Equal(o.UpdatedAt) && (sp.State != p.State || !sameTerminalTime(s.ClosedAt, o.ClosedAt) || !sameTerminalTime(s.MergedAt, o.MergedAt))) {
			retry = true
		}
	}
	if retry {
		stage = "recheck"
		again, e := read()
		if e != nil {
			return again, e
		}
		if !sameDetail(o, again) {
			return again, errors.New("github detail observations conflict")
		}
		o = again
		if facts.Current != nil && currentConflicts(*facts.Current, p) && !(p.State == "merged" && facts.Current.State != "merged") && facts.Current.GitHubUpdatedAt.After(p.GitHubUpdatedAt) {
			return o, errors.New("github detail older than confirmed state")
		}
		for _, s := range summaries {
			if s.MergedAt != nil && p.State != "merged" {
				return o, errors.New("github merged summary regressed")
			}
			if p.State == "merged" && s.MergedAt == nil {
				continue
			}
			if s.UpdatedAt.After(o.UpdatedAt) && (summaryPull(s).State != p.State || !sameTerminalTime(s.ClosedAt, o.ClosedAt) || !sameTerminalTime(s.MergedAt, o.MergedAt)) {
				return o, errors.New("github detail conflicts with current summary")
			}
		}
	}
	if core.StaleObservation(p, facts) {
		return o, errors.New("github detail older than confirmed state")
	}
	r.rememberFacts(n, facts)
	return o, nil
}
