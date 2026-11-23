package github

import (
	"context"
	"errors"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

func (r *run) poll(ctx context.Context) error {
	if err := r.runtime(ctx, func(w *store.GitHubRuntimeWrite, _ githubpr.Connection, now time.Time) { core.PollAttempt(w, now) }); err != nil {
		return err
	}
	repo, err := r.repository(ctx)
	if err != nil {
		return r.accessFailure(ctx, err)
	}
	if err = r.publishRepository(ctx, repo); err != nil {
		return err
	}
	owner, name, err := core.RepositoryParts(repo.FullName)
	if err != nil {
		return r.pollFailure(ctx, err)
	}
	if err = r.discover(ctx, owner, name); err != nil {
		if fatal(err) {
			return err
		}
		if accessErr := r.confirmPRFailure(ctx, err); accessErr != nil {
			return accessErr
		}
		return r.pollFailure(ctx, err)
	}
	r.log.InfoContext(ctx, "github open traversal", "phase", "fetch")
	err = r.remote.ListOpen(ctx, *r.connection.InstallationID, owner, name, func(page []githubpr.Observation) error {
		var knownOpen []githubpr.Observation
		batchSeen := map[int64]bool{}
		flush := func() error {
			if len(knownOpen) == 0 {
				return nil
			}
			err := r.publish(ctx, knownOpen, &r.lease.Token)
			knownOpen = nil
			batchSeen = map[int64]bool{}
			return err
		}
		for _, o := range page {
			if o.State != "open" {
				return errors.New("github open page contains non-open pull request")
			}
			p, e := core.Normalize(o, r.project, *r.connection.RepositoryID, time.Time{}, &r.lease.Token)
			if e != nil {
				return e
			}
			facts, e := r.publicationFacts(ctx, p)
			if e != nil {
				return e
			}
			if facts.Current != nil && facts.Current.State == "open" {
				if batchSeen[o.Number] {
					if e = flush(); e != nil {
						return e
					}
				}
				r.rememberFacts(p.Number, facts)
				knownOpen = append(knownOpen, o)
				batchSeen[o.Number] = true
				if len(knownOpen) == core.PublishLimit {
					if e = flush(); e != nil {
						return e
					}
				}
				continue
			}
			if e = flush(); e != nil {
				return e
			}
			checked, e := r.checkedDetail(ctx, owner, name, o.Number, []remote.PullSummary{{Number: o.Number, RepositoryID: o.BaseRepositoryID, State: o.State, UpdatedAt: o.UpdatedAt, ClosedAt: o.ClosedAt, MergedAt: o.MergedAt}})
			if e != nil {
				return e
			}
			if e = r.publish(ctx, []githubpr.Observation{checked}, &r.lease.Token); e != nil {
				return e
			}
			if e = r.pollHint(ctx, owner, name); e != nil {
				return e
			}
		}
		if e := flush(); e != nil {
			return e
		}
		return r.pollHint(ctx, owner, name)
	})
	if err != nil {
		if fatal(err) {
			return err
		}
		if accessErr := r.confirmPRFailure(ctx, err); accessErr != nil {
			return accessErr
		}
		return r.pollFailure(ctx, err)
	}
	var after int64
	for {
		numbers, e := r.unseen(ctx, after)
		if e != nil {
			return e
		}
		if len(numbers) == 0 {
			break
		}
		for _, n := range numbers {
			o, e := r.checkedDetail(ctx, owner, name, n, nil)
			if e != nil {
				if accessErr := r.confirmPRFailure(ctx, e); accessErr != nil {
					return accessErr
				}
				return r.pollFailure(ctx, e)
			}
			if o.Number != n {
				return r.pollFailure(ctx, errors.New("github pull request number mismatch"))
			}
			if e = r.publish(ctx, []githubpr.Observation{o}, &r.lease.Token); e != nil {
				return r.pollFailure(ctx, e)
			}
			if e = r.pollHint(ctx, owner, name); e != nil {
				if fatal(e) {
					return e
				}
				if accessErr := r.confirmPRFailure(ctx, e); accessErr != nil {
					return accessErr
				}
				return r.pollFailure(ctx, e)
			}
			after = n
		}
	}
	return r.runtime(ctx, func(w *store.GitHubRuntimeWrite, c githubpr.Connection, now time.Time) {
		core.PollSuccess(w, c, now)
		w.ReleaseClaim = true
	})
}

// A single hint at each publication boundary keeps both sources progressing.
func (r *run) pollHint(ctx context.Context, owner, name string) error {
	hints, err := r.pending(ctx, 1)
	if err != nil {
		return err
	}
	if len(hints) > 0 {
		if err = r.hint(ctx, hints[0], owner, name, &r.lease.Token); err != nil && (fatal(err) || fail(err).Code == "github_rate_limited") {
			return err
		}
	}
	return nil
}

func (r *run) pollFailure(ctx context.Context, cause error) error {
	if fatal(cause) {
		return cause
	}
	err := r.runtime(ctx, func(w *store.GitHubRuntimeWrite, _ githubpr.Connection, now time.Time) {
		core.PollFailure(w, now, fail(cause))
		w.ReleaseClaim = true
	})
	return errors.Join(cause, err)
}
func (r *run) publish(ctx context.Context, obs []githubpr.Observation, pollID *string) error {
	_, err := r.publishCount(ctx, obs, pollID)
	return err
}

func (r *run) publishCount(ctx context.Context, obs []githubpr.Observation, pollID *string) (int, error) {
	defer func() {
		for _, o := range obs {
			delete(r.confirmed, o.Number)
		}
	}()
	r.log.InfoContext(ctx, "github observation batch", "phase", "publish", "count", len(obs))
	items := make([]githubpr.PullRequest, 0, len(obs))
	for _, o := range obs {
		p, err := core.Normalize(o, r.project, *r.connection.RepositoryID, time.Time{}, pollID)
		if err != nil {
			return 0, err
		}
		items = append(items, p)
	}
	count := 0
	c, e := r.tx(ctx, func(c context.Context, d store.GitHubWorkDAO) error {
		if _, e := d.Connection(c); e != nil {
			return e
		}
		now, e := d.ObservedAt(c)
		if e != nil {
			return e
		}
		eligible := make([]githubpr.PullRequest, 0, len(items))
		for i := range items {
			items[i].ObservedAt = now
			facts, valid, err := d.PublicationFacts(c, r.lease, *r.connection.RepositoryID, items[i].Number, terminalAt(items[i]))
			if err = require(valid, err); err != nil {
				return err
			}
			if core.StaleObservation(items[i], facts) || r.changedSinceConfirmation(items[i], facts) {
				return errObservationConflict
			}
			if core.EligibleFirstPublication(items[i], facts) {
				eligible = append(eligible, items[i])
			}
		}
		if len(eligible) == 0 {
			return nil
		}
		ok, e := d.Publish(c, r.lease, eligible)
		if err := require(ok, e); err != nil {
			return err
		}
		count = len(eligible)
		return nil
	})
	if c.Outcome == store.TransactionNotCommitted && errors.Is(e, errObservationConflict) {
		return 0, e
	}
	if e = committed(c, e); e != nil {
		return 0, e
	}
	return count, r.renew(ctx)
}
func (r *run) unseen(ctx context.Context, after int64) ([]int64, error) {
	var numbers []int64
	c, e := r.tx(ctx, func(c context.Context, d store.GitHubWorkDAO) error {
		var ok bool
		var e error
		numbers, ok, e = d.UnseenActive(c, r.lease, r.lease.Token, after, 100)
		return require(ok, e)
	})
	return numbers, committed(c, e)
}
