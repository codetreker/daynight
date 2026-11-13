package github

import (
	"context"
	"errors"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

// repository verifies PR access and falls back to stable-ID discovery if a name
// was changed or reused. A same-name replacement never becomes this binding.
func (r *run) repository(ctx context.Context) (githubpr.RepositoryObservation, error) {
	c := r.connection
	id := *c.InstallationID
	repoID := *c.RepositoryID
	if c.RepositoryFullName != nil {
		owner, name, e := core.RepositoryParts(*c.RepositoryFullName)
		if e == nil {
			repo, err := r.e.remote.VerifyAccess(ctx, id, owner, name)
			if err == nil && repo.ID == repoID {
				return repo, nil
			}
			if err != nil {
				var re *remote.Error
				if !errors.As(err, &re) || (re.Code != "not_found" && re.Code != "permission_denied" && re.Code != "unauthorized") {
					return githubpr.RepositoryObservation{}, err
				}
			}
		}
	}
	repo, err := r.e.remote.ResolveRepository(ctx, id, repoID)
	if err != nil {
		return repo, err
	}
	if repo.ID != repoID {
		return repo, errors.New("github repository identity mismatch")
	}
	owner, name, err := core.RepositoryParts(repo.FullName)
	if err != nil {
		return repo, err
	}
	verified, err := r.e.remote.VerifyAccess(ctx, id, owner, name)
	if err != nil {
		return repo, err
	}
	if verified.ID != repoID {
		return repo, errors.New("github repository identity mismatch")
	}
	return verified, nil
}
func (r *run) publishRepository(ctx context.Context, repo githubpr.RepositoryObservation) error {
	r.log.InfoContext(ctx, "github repository observation", "phase", "publish")
	c, e := r.tx(ctx, func(c context.Context, d store.GitHubWriteDAO) error {
		login := ""
		if r.connection.InstallationAccountLogin != nil {
			login = *r.connection.InstallationAccountLogin
		}
		ok, e := d.PublishRepository(c, r.lease, store.GitHubRepositoryObservation{InstallationID: *r.connection.InstallationID, RepositoryID: repo.ID, InstallationAccountLogin: login, RepositoryFullName: repo.FullName, RepositoryPrivate: repo.Private})
		return require(ok, e)
	})
	if e = committed(c, e); e != nil {
		return e
	}
	r.connection.RepositoryFullName = &repo.FullName
	return nil
}
func (r *run) access(ctx context.Context) error {
	r.log.InfoContext(ctx, "github access check", "phase", "access")
	repo, err := r.repository(ctx)
	if err != nil {
		return r.accessFailure(ctx, err)
	}
	if err = r.publishRepository(ctx, repo); err != nil {
		return err
	}
	c, e := r.tx(ctx, func(c context.Context, d store.GitHubWriteDAO) error {
		conn, e := d.Connection(c)
		if e != nil {
			return e
		}
		now, e := d.ObservedAt(c)
		if e != nil {
			return e
		}
		if r.connection.AccessHintID != nil {
			acked, e := d.AckAccessHint(c, r.lease, *r.connection.AccessHintID)
			if e = require(acked, e); e != nil {
				return e
			}
		}
		w := core.Runtime(conn)
		core.AccessSuccess(&w, conn, now)
		if r.connection.AccessHintID != nil {
			pending, valid, e := d.HasPending(c, r.lease)
			if e = require(valid, e); e != nil {
				return e
			}
			core.WebhookAttempt(&w, now)
			core.WebhookSuccess(&w, now, pending)
		}
		w.ReleaseClaim = true
		ok, e := d.SaveRuntime(c, r.lease, w)
		return require(ok, e)
	})
	return committed(c, e)
}
func (r *run) accessFailure(ctx context.Context, cause error) error {
	if fatal(cause) {
		return cause
	}
	var re *remote.Error
	confirmed := errors.As(cause, &re) && (re.Code == "permission_denied" || re.Code == "unauthorized" || re.Code == "not_found")
	reason, permanent := "permission_denied", false
	if confirmed {
		// Only the App installation endpoint can confirm deletion or suspension.
		status, err := r.e.remote.Installation(ctx, *r.connection.InstallationID)
		if err != nil {
			if fatal(err) {
				return err
			}
			var installErr *remote.Error
			if errors.As(err, &installErr) && installErr.Code == "installation_missing" {
				reason, permanent = "installation_missing", true
			} else {
				return errors.Join(cause, r.recordAccessFailure(ctx, err, "", false))
			}
		} else if status.Suspended {
			reason = "suspended"
		} else if re.Code == "not_found" {
			reason = "repository_unavailable"
		}
	}
	return r.recordAccessFailure(ctx, cause, reasonIf(confirmed, reason), permanent)
}
func reasonIf(confirmed bool, reason string) string {
	if confirmed {
		return reason
	}
	return ""
}
func (r *run) recordAccessFailure(ctx context.Context, cause error, reason string, permanent bool) error {
	c, err := r.tx(ctx, func(ctx context.Context, d store.GitHubWriteDAO) error {
		conn, err := d.Connection(ctx)
		if err != nil {
			return err
		}
		now, err := d.ObservedAt(ctx)
		if err != nil {
			return err
		}
		w := core.Runtime(conn)
		f := fail(cause)
		eventAccess := r.kind == core.WorkAccess && r.connection.AccessHintID != nil
		if r.kind == core.WorkWebhook || eventAccess {
			core.WebhookAttempt(&w, now)
			core.WebhookFailure(&w, now, f)
		} else {
			core.PollFailure(&w, now, f)
		}
		if reason != "" {
			core.AccessUnavailable(&w, conn, now, reason, permanent)
		} else {
			next := core.RetryAt(now, f)
			w.NextAccessCheckAt = &next
		}
		w.ReleaseClaim = true
		ok, err := d.SaveRuntime(ctx, r.lease, w)
		return require(ok, err)
	})
	return errors.Join(errAccessStop, cause, committed(c, err))
}

// A single PR 404 is not proof of revocation. Check repository capability
// before deciding whether to stop the connection.
func (r *run) confirmPRFailure(ctx context.Context, cause error) error {
	var re *remote.Error
	if !errors.As(cause, &re) || (re.Code != "not_found" && re.Code != "permission_denied" && re.Code != "unauthorized") {
		return nil
	}
	_, err := r.repository(ctx)
	if err == nil {
		return nil
	}
	if fatal(err) {
		return err
	}
	return r.accessFailure(ctx, err)
}
