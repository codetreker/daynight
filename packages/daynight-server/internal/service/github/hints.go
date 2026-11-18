package github

import (
	"context"
	"errors"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func (r *run) pending(ctx context.Context, limit int) ([]store.GitHubPendingPR, error) {
	var hints []store.GitHubPendingPR
	c, e := r.tx(ctx, func(c context.Context, d store.GitHubWorkDAO) error {
		if _, e := d.Connection(c); e != nil {
			return e
		}
		now, e := d.ObservedAt(c)
		if e != nil {
			return e
		}
		var ok bool
		hints, ok, e = d.Pending(c, r.lease, now, limit)
		return require(ok, e)
	})
	return hints, committed(c, e)
}
func (r *run) hints(ctx context.Context) error {
	hints, err := r.pending(ctx, core.PendingLimit)
	if err != nil {
		return err
	}
	if len(hints) == 0 {
		return r.release(ctx)
	}
	repo, err := r.repository(ctx)
	if err != nil {
		if fatal(err) {
			return err
		}
		c, e := r.tx(ctx, func(ctx context.Context, d store.GitHubWorkDAO) error {
			if _, e := d.Connection(ctx); e != nil {
				return e
			}
			now, e := d.ObservedAt(ctx)
			if e != nil {
				return e
			}
			for _, h := range hints {
				if _, e = d.ReschedulePending(ctx, r.lease, h.Number, h.RequestID, core.RetryAt(now, fail(err))); e != nil {
					return e
				}
			}
			valid, e := d.ValidLease(ctx, r.lease)
			return require(valid, e)
		})
		if e = committed(c, e); e != nil {
			return errors.Join(err, e)
		}
		return r.accessFailure(ctx, err)
	}
	if err = r.publishRepository(ctx, repo); err != nil {
		return err
	}
	owner, name, err := core.RepositoryParts(repo.FullName)
	if err != nil {
		return err
	}
	var failures error
	for _, h := range hints {
		if e := r.hint(ctx, h, owner, name, nil); e != nil {
			failures = errors.Join(failures, e)
			if fatal(e) {
				return failures
			}
			if fail(e).Code == "github_rate_limited" {
				return errors.Join(failures, r.release(ctx))
			}
		}
	}
	return errors.Join(failures, r.release(ctx))
}
func (r *run) hint(ctx context.Context, h store.GitHubPendingPR, owner, name string, pollID *string) error {
	// Each hint retains its own context through fetch, publication and acknowledgement.
	job := *r
	job.log = r.log.With("hint_id", h.RequestID, "delivery_id", h.DeliveryID)
	r = &job
	defer func() { delete(r.confirmed, h.Number) }()
	ctx = r.checkpointContext(ctx)
	r.log.InfoContext(ctx, "github hint fetch", "phase", "fetch")
	if err := r.runtime(ctx, func(w *store.GitHubRuntimeWrite, _ githubpr.Connection, now time.Time) { core.WebhookAttempt(w, now) }); err != nil {
		return err
	}
	o, err := r.checkedDetail(ctx, owner, name, h.Number, nil)
	if err == nil && o.Number != h.Number {
		err = errors.New("github pull request number mismatch")
	}
	if err != nil {
		if failure := r.hintFailure(ctx, h, err); fatal(failure) {
			return failure
		}
		if accessErr := r.confirmPRFailure(ctx, err); accessErr != nil {
			return accessErr
		}
		return err
	}
	p, err := core.Normalize(o, r.project, *r.connection.RepositoryID, time.Time{}, pollID)
	if err != nil {
		return r.hintFailure(ctx, h, err)
	}
	c, e := r.tx(ctx, func(c context.Context, d store.GitHubWorkDAO) error {
		_, e := d.Connection(c)
		if e != nil {
			return e
		}
		now, e := d.ObservedAt(c)
		if e != nil {
			return e
		}
		facts, valid, e := d.PublicationFacts(c, r.lease, *r.connection.RepositoryID, p.Number, terminalAt(p))
		if e = require(valid, e); e != nil {
			return e
		}
		if core.StaleObservation(p, facts) || r.changedSinceConfirmation(p, facts) {
			return errObservationConflict
		}
		if core.EligibleFirstPublication(p, facts) {
			p.ObservedAt = now
			ok, e := d.Publish(c, r.lease, []githubpr.PullRequest{p})
			if e = require(ok, e); e != nil {
				return e
			}
		}
		// A false ack can mean a newer request replaced this one; it must survive.
		if _, e = d.AckPending(c, r.lease, h.Number, h.RequestID); e != nil {
			return e
		}
		pending, valid, e := d.HasPending(c, r.lease)
		if e = require(valid, e); e != nil {
			return e
		}
		conn, e := d.Connection(c)
		if e != nil {
			return e
		}
		w := core.Runtime(conn)
		core.WebhookSuccess(&w, now, pending)
		ok, e := d.SaveRuntime(c, r.lease, w)
		return require(ok, e)
	})
	if c.Outcome == store.TransactionNotCommitted && errors.Is(e, errObservationConflict) {
		return r.hintFailure(ctx, h, e)
	}
	if e = committed(c, e); e != nil {
		return e
	}
	return r.renew(ctx)
}
func (r *run) hintFailure(ctx context.Context, h store.GitHubPendingPR, cause error) error {
	if fatal(cause) {
		return cause
	}
	c, e := r.tx(ctx, func(c context.Context, d store.GitHubWorkDAO) error {
		conn, e := d.Connection(c)
		if e != nil {
			return e
		}
		now, e := d.ObservedAt(c)
		if e != nil {
			return e
		}
		f := fail(cause)
		if _, e = d.ReschedulePending(c, r.lease, h.Number, h.RequestID, core.RetryAt(now, f)); e != nil {
			return e
		}
		w := core.Runtime(conn)
		core.WebhookFailure(&w, now, f)
		ok, e := d.SaveRuntime(c, r.lease, w)
		return require(ok, e)
	})
	return errors.Join(cause, committed(c, e))
}
