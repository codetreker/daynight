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
	"github.com/google/uuid"
)

// Store supplies independent snapshots and live Project write transactions.
type Store interface {
	store.ProjectWriter
	store.SnapshotReader
}

// Remote supplies current GitHub facts. Each actual request must invoke the
// checkpoint bound to its context by remote.WithRequestCheckpoint.
type Remote interface {
	Installation(context.Context, int64) (remote.InstallationStatus, error)
	VerifyAccess(context.Context, int64, string, string) (githubpr.RepositoryObservation, error)
	ResolveRepository(context.Context, int64, int64) (githubpr.RepositoryObservation, error)
	ListOpen(context.Context, int64, string, string, func([]githubpr.Observation) error) error
	PullRequest(context.Context, int64, string, string, int64) (githubpr.Observation, error)
}

type Executor struct {
	db     Store
	remote Remote
	appID  int64
	log    *slog.Logger
}

func NewExecutor(db Store, r Remote, appID int64, logger *slog.Logger) (*Executor, error) {
	if db == nil || r == nil || appID <= 0 {
		return nil, errors.New("github executor requires store, remote and app ID")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Executor{db, r, appID, logger}, nil
}

var errLease = errors.New("github sync lease lost")
var errUnknown = errors.New("github sync transaction outcome unknown")
var errTransaction = errors.New("github sync transaction failed")
var errCheckpoint = errors.New("github sync checkpoint failed")
var errAccessStop = errors.New("github access check stopped work")

type run struct {
	e          *Executor
	project    string
	lease      store.GitHubLease
	connection githubpr.Connection
	kind       string
	log        *slog.Logger
}

// Execute attempts one bounded access or hint job, or one complete poll. The
// caller owns its context and may call it again after the persisted next time.
func (e *Executor) Execute(ctx context.Context, project string) error {
	return e.ExecuteWithClaimContext(ctx, ctx, project)
}

// ExecuteWithClaimContext cancels admission independently from already claimed
// work, allowing shutdown to stop new claims before draining existing work.
func (e *Executor) ExecuteWithClaimContext(ctx, claimCtx context.Context, project string) error {
	if project == "" {
		return errors.New("github project ID is required")
	}
	r := &run{e: e, project: project, lease: store.GitHubLease{Token: uuid.NewString()}}
	r.log = e.log.With("component", "github_sync", "project_id", project, "sync_id", r.lease.Token)
	claimed, err := r.claim(claimCtx)
	if err != nil || !claimed {
		return err
	}
	r.log = e.log.With("component", "github_sync", "project_id", project, "sync_id", r.lease.Token, "generation", r.lease.Generation, "installation_id", *r.connection.InstallationID, "repository_id", *r.connection.RepositoryID, "trigger", r.kind)
	if r.kind == core.WorkAccess && r.connection.AccessHintID != nil {
		r.log = r.log.With("hint_id", *r.connection.AccessHintID)
		if r.connection.AccessDeliveryID != nil {
			r.log = r.log.With("delivery_id", *r.connection.AccessDeliveryID)
		}
	}
	started := time.Now()
	r.log.InfoContext(ctx, "github sync started", "phase", "claim")
	err = r.execute(ctx)
	if err != nil {
		var re *remote.Error
		attrs := []any{"phase", "stop", "result_code", fail(err).Code, "duration_ms", time.Since(started).Milliseconds()}
		if errors.As(err, &re) {
			attrs = append(attrs, "remote_status", re.Status, "github_request_id", re.RequestID)
		}
		r.log.WarnContext(ctx, "github sync stopped", attrs...)
	} else {
		r.log.InfoContext(ctx, "github sync completed", "phase", "finish", "duration_ms", time.Since(started).Milliseconds())
	}
	return err
}
func (r *run) tx(ctx context.Context, fn func(context.Context, store.GitHubWriteDAO) error) (store.Completion, error) {
	c, cancel := context.WithTimeout(ctx, core.OperationTimeout)
	defer cancel()
	started := time.Now()
	completion, err := r.e.db.WriteProject(c, r.project, func(s store.ProjectWriteScope) error { return fn(c, s.GitHubDAO()) })
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
func (r *run) claim(ctx context.Context) (bool, error) {
	var selected bool
	completion, err := r.tx(ctx, func(c context.Context, d store.GitHubWriteDAO) error {
		conn, e := d.Connection(c)
		if e != nil {
			return e
		}
		now, e := d.ObservedAt(c)
		if e != nil {
			return e
		}
		pendingDue, e := d.HasDuePending(c, now)
		if e != nil {
			return e
		}
		kind := core.WorkKind(conn, r.e.appID, now, pendingDue)
		if kind == "" {
			return nil
		}
		r.connection = conn
		r.kind = kind
		r.lease.Generation = conn.Generation
		ok, e := d.Claim(c, store.GitHubClaim{AppID: *conn.AppID, Generation: conn.Generation, Token: r.lease.Token, Kind: kind, Until: now.Add(core.LeaseDuration)})
		selected = ok
		return e
	})
	if completion.Outcome == store.TransactionUnknown && selected {
		// Only an observation of this exact claim permits continuing an uncertain claim.
		c, cancel := context.WithTimeout(ctx, core.OperationTimeout)
		defer cancel()
		var valid bool
		readErr := r.e.db.ReadSnapshot(c, func(s store.SnapshotScope) error {
			conn, e := s.GitHubDAO().Connection(c, r.project)
			if e != nil {
				return e
			}
			now, e := s.ObservedAt(c)
			if e != nil {
				return e
			}
			valid = conn.Enabled && conn.SyncEnabled && conn.Generation == r.lease.Generation && conn.ClaimToken != nil && *conn.ClaimToken == r.lease.Token && conn.ClaimUntil != nil && conn.ClaimUntil.After(now)
			return nil
		})
		if readErr == nil && valid {
			return true, nil
		}
		return false, errors.Join(errUnknown, err, readErr)
	}
	if e := committed(completion, err); e != nil {
		return false, e
	}
	return selected, nil
}
func (r *run) renew(ctx context.Context) error {
	c, e := r.tx(ctx, func(c context.Context, d store.GitHubWriteDAO) error {
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
	c, e := r.tx(ctx, func(c context.Context, d store.GitHubWriteDAO) error {
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
	if *r.connection.AppID != r.e.appID {
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
