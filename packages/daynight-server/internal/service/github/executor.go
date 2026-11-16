// Package github coordinates one Project's GitHub synchronization.
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

// Remote supplies current GitHub facts. Each actual request must invoke the
// checkpoint bound to its context by remote.WithRequestCheckpoint.
type Remote interface {
	Installation(context.Context, int64) (remote.InstallationStatus, error)
	VerifyAccess(context.Context, int64, string, string) (githubpr.RepositoryObservation, error)
	ResolveRepository(context.Context, int64, int64) (githubpr.RepositoryObservation, error)
	ListOpen(context.Context, int64, string, string, func([]githubpr.Observation) error) error
	PullRequest(context.Context, int64, string, string, int64) (githubpr.Observation, error)
}

var errLease = errors.New("github sync lease lost")
var errUnknown = errors.New("github sync transaction outcome unknown")
var errTransaction = errors.New("github sync transaction failed")
var errCheckpoint = errors.New("github sync checkpoint failed")
var errAccessStop = errors.New("github access check stopped work")

type run struct {
	remote     Remote
	appID      int64
	snapshot   store.SnapshotReader
	write      func(context.Context, func(context.Context, store.GitHubWorkDAO) error) (store.Completion, error)
	project    string
	lease      store.GitHubLease
	connection githubpr.Connection
	kind       string
	log        *slog.Logger
}

func (r *run) tx(ctx context.Context, fn func(context.Context, store.GitHubWorkDAO) error) (store.Completion, error) {
	c, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	started := time.Now()
	completion, err := r.write(c, fn)
	r.log.DebugContext(ctx, "github project transaction", "phase", "publish", "result_code", string(completion.Outcome), "duration_ms", time.Since(started).Milliseconds())
	return completion, err
}
func committed(c store.Completion, err error) error {
	if c.Outcome == store.TransactionUnknown {
		return errors.Join(errUnknown, err)
	}
	if err != nil {
		return errors.Join(errTransaction, err)
	}
	if c.Outcome != store.TransactionCommitted {
		return errors.Join(errTransaction, errors.New("github sync transaction not committed"))
	}
	return nil
}
func (r *run) renew(ctx context.Context) error {
	c, e := r.tx(ctx, func(c context.Context, d store.GitHubWorkDAO) error {
		if _, e := d.Connection(c); e != nil {
			return e
		}
		now, e := d.ObservedAt(c)
		if e != nil {
			return e
		}
		ok, e := d.Renew(c, r.lease, now.Add(core.LeaseDuration))
		if e != nil {
			return e
		}
		if !ok {
			return errLease
		}
		return nil
	})
	return committed(c, e)
}
func (r *run) runtime(ctx context.Context, change func(*store.GitHubRuntimeWrite, githubpr.Connection, time.Time)) error {
	c, e := r.tx(ctx, func(c context.Context, d store.GitHubWorkDAO) error {
		conn, e := d.Connection(c)
		if e != nil {
			return e
		}
		now, e := d.ObservedAt(c)
		if e != nil {
			return e
		}
		w := core.Runtime(conn)
		change(&w, conn, now)
		ok, e := d.SaveRuntime(c, r.lease, w)
		if e != nil {
			return e
		}
		if !ok {
			return errLease
		}
		return nil
	})
	return committed(c, e)
}
func (r *run) execute(ctx context.Context) error {
	ctx = r.checkpointContext(ctx)
	if *r.connection.AppID != r.appID {
		return r.runtime(ctx, func(w *store.GitHubRuntimeWrite, c githubpr.Connection, now time.Time) {
			core.AccessUnavailable(w, c, now, "app_changed", true)
			w.ReleaseClaim = true
		})
	}
	if r.kind == core.WorkAccess {
		return r.access(ctx)
	}
	if r.kind == core.WorkPoll {
		return r.poll(ctx)
	}
	return r.hints(ctx)
}
func (r *run) checkpointContext(ctx context.Context) context.Context {
	return remote.WithRequestCheckpoint(ctx, func(ctx context.Context) error {
		r.log.DebugContext(ctx, "github request checkpoint", "phase", "fetch")
		if err := r.renew(ctx); err != nil {
			return errors.Join(errCheckpoint, err)
		}
		return nil
	})
}
func (r *run) release(ctx context.Context) error {
	return r.runtime(ctx, func(w *store.GitHubRuntimeWrite, _ githubpr.Connection, _ time.Time) { w.ReleaseClaim = true })
}
func fail(err error) core.Failure {
	f := core.Failure{Code: "github_unavailable"}
	var re *remote.Error
	if errors.As(err, &re) {
		switch re.Code {
		case "rate_limited":
			f.Code = "github_rate_limited"
			f.RetryAt = re.RetryAt
		case "permission_denied", "unauthorized":
			f.Code = "github_permission_denied"
		case "not_found":
			f.Code = "github_not_found"
		}
	}
	return f
}
func fatal(err error) bool {
	return errors.Is(err, errLease) || errors.Is(err, errUnknown) || errors.Is(err, errTransaction) || errors.Is(err, errCheckpoint) || errors.Is(err, errAccessStop) || errors.Is(err, context.Canceled)
}
func require(ok bool, err error) error {
	if err != nil {
		return err
	}
	if !ok {
		return errLease
	}
	return nil
}
