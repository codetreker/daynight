package github

import (
	"context"
	"errors"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
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
	r.log.InfoContext(ctx, "github open traversal", "phase", "fetch")
	err = r.e.remote.ListOpen(ctx, *r.connection.InstallationID, owner, name, func(page []githubpr.Observation) error {
		for start := 0; start < len(page); start += core.PublishLimit {
			end := min(start+core.PublishLimit, len(page))
			for _, o := range page[start:end] {
				if o.State != "open" {
					return errors.New("github open page contains non-open pull request")
				}
			}
			if e := r.publish(ctx, page[start:end], &r.lease.Token); e != nil {
				return e
			}
		}
		// One hint per page bounds the work stolen from the poll.
		hints, e := r.pending(ctx, 1)
		if e != nil {
			return e
		}
		if len(hints) > 0 {
			if e = r.hint(ctx, hints[0], owner, name); e != nil && (fatal(e) || fail(e).Code == "github_rate_limited") {
				return e
			}
		}
		return nil
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
			o, e := r.e.remote.PullRequest(ctx, *r.connection.InstallationID, owner, name, n)
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
			after = n
		}
	}
	return r.runtime(ctx, func(w *store.GitHubRuntimeWrite, c githubpr.Connection, now time.Time) {
		core.PollSuccess(w, c, now)
		w.ReleaseClaim = true
	})
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
	r.log.InfoContext(ctx, "github observation batch", "phase", "publish", "count", len(obs))
	items := make([]githubpr.PullRequest, 0, len(obs))
	for _, o := range obs {
		p, err := core.Normalize(o, r.project, *r.connection.RepositoryID, time.Time{}, pollID)
		if err != nil {
			return err
		}
		items = append(items, p)
	}
	c, e := r.tx(ctx, func(c context.Context, d store.GitHubWriteDAO) error {
		if _, e := d.Connection(c); e != nil {
			return e
		}
		now, e := d.ObservedAt(c)
		if e != nil {
			return e
		}
		for i := range items {
			items[i].ObservedAt = now
		}
		ok, e := d.Publish(c, r.lease, items)
		return require(ok, e)
	})
	if e = committed(c, e); e != nil {
		return e
	}
	return r.renew(ctx)
}
func (r *run) unseen(ctx context.Context, after int64) ([]int64, error) {
	var numbers []int64
	c, e := r.tx(ctx, func(c context.Context, d store.GitHubWriteDAO) error {
		var ok bool
		var e error
		numbers, ok, e = d.UnseenActive(c, r.lease, r.lease.Token, after, 100)
		return require(ok, e)
	})
	return numbers, committed(c, e)
}
