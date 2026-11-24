// Package reviewassignment reconciles persisted PR facts with Worker eligibility.
package reviewassignment

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	worker "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
)

const pageSize = 25
const itemTimeout = 5 * time.Second

// Reconciler is single-owner: its cursor is retained between bounded batches.
type Reconciler struct {
	db               store.ReviewAssignmentStore
	logger           *slog.Logger
	pass             uint64
	started          bool
	start            time.Time
	upper            *store.ReviewWorkerKey
	after            *store.ReviewWorkerKey
	workers          []store.ReviewWorker
	worker           *store.ReviewWorker
	projects         []string
	project          string
	repository       *int64
	prUpper, prAfter *int64
	prs              []store.ReviewPR
	lastPage         bool
}

func New(db store.ReviewAssignmentStore, logger *slog.Logger) *Reconciler {
	if logger == nil {
		logger = slog.Default()
	}
	return &Reconciler{db: db, logger: logger}
}

func (r *Reconciler) log(ctx context.Context, phase string, err error, args ...any) {
	kind := "operation"
	if errors.Is(err, context.DeadlineExceeded) {
		kind = "deadline"
	} else if errors.Is(err, context.Canceled) {
		kind = "cancelled"
	}
	if database, _ := store.DatabaseErrorFacts(err); database {
		kind = "database"
	}
	attrs := []any{"component", "review_assignment", "phase", phase, "error_kind", kind, "pass", r.pass}
	attrs = append(attrs, args...)
	r.logger.ErrorContext(ctx, "review assignment reconciliation failed", attrs...)
}

func (r *Reconciler) nextProject() {
	r.project, r.repository, r.prUpper, r.prAfter, r.prs, r.lastPage = "", nil, nil, nil, nil, false
}
func (r *Reconciler) nextWorker() {
	if r.worker != nil {
		key := r.worker.ReviewWorkerKey
		r.after = &key
	}
	r.worker, r.projects = nil, nil
	r.nextProject()
}

// Batch attempts at most budget storage operations, keeping the first untried
// PR across calls. An individual failure advances the cursor until the next pass.
func (r *Reconciler) Batch(ctx context.Context, budget int) {
	for budget > 0 && ctx.Err() == nil {
		if !r.started {
			budget--
			call, cancel := context.WithTimeout(ctx, itemTimeout)
			start, upper, err := r.db.ReviewScanStart(call)
			cancel()
			if err != nil {
				r.log(ctx, "scan_start", err)
				return
			}
			r.pass++
			r.start, r.upper, r.after, r.started = start, upper, nil, true
			if upper == nil {
				r.started = false
				return
			}
		}
		if r.worker == nil {
			if len(r.workers) == 0 {
				if budget == 0 {
					return
				}
				budget--
				call, cancel := context.WithTimeout(ctx, itemTimeout)
				items, err := r.db.ReviewWorkers(call, r.start, *r.upper, r.after, pageSize)
				cancel()
				if err != nil {
					r.log(ctx, "workers", err)
					r.started = false
					return
				}
				if len(items) == 0 {
					r.started = false
					return
				}
				r.workers = items
			}
			w := r.workers[0]
			r.workers = r.workers[1:]
			r.worker = &w
			r.projects = worker.ReviewProjectIDs(w.DesiredConfiguration)
		}
		if r.project == "" {
			if len(r.projects) == 0 {
				r.nextWorker()
				continue
			}
			if budget == 0 {
				return
			}
			r.project, r.projects = r.projects[0], r.projects[1:]
			budget--
			call, cancel := context.WithTimeout(ctx, itemTimeout)
			repository, err := r.db.ReviewRepository(call, r.project)
			cancel()
			if err != nil {
				r.log(ctx, "repository", err, "projectId", r.project, "workerId", r.worker.WorkerID, "accountId", r.worker.UserID)
				r.nextProject()
				continue
			}
			if repository == nil {
				r.nextProject()
				continue
			}
			r.repository = repository
		}
		if len(r.prs) == 0 {
			if r.lastPage {
				r.nextProject()
				continue
			}
			if budget == 0 {
				return
			}
			budget--
			call, cancel := context.WithTimeout(ctx, itemTimeout)
			items, err := r.db.ReviewOpenPRs(call, r.worker.UserID, r.project, *r.repository, r.prUpper, r.prAfter, pageSize)
			cancel()
			if err != nil {
				r.log(ctx, "pull_requests", err, "projectId", r.project, "workerId", r.worker.WorkerID, "accountId", r.worker.UserID)
				r.nextProject()
				continue
			}
			if len(items) == 0 {
				r.nextProject()
				continue
			}
			if r.prUpper == nil {
				n := items[0].Number
				r.prUpper = &n
			}
			r.lastPage = len(items) < pageSize
			r.prs = items
		}
		if budget == 0 {
			return
		}
		pr := r.prs[0]
		r.prs = r.prs[1:]
		n := pr.Number
		r.prAfter = &n
		if pr.Assigned {
			continue
		}
		budget--
		call, cancel := context.WithTimeout(ctx, itemTimeout)
		completion, err := r.assign(call, *r.worker, r.project, *r.repository, pr)
		cancel()
		if err != nil {
			r.log(ctx, "assign", err, "projectId", r.project, "number", pr.Number, "workerId", r.worker.WorkerID, "accountId", r.worker.UserID, "outcome", completion.Outcome)
		}
	}
}

func (r *Reconciler) assign(ctx context.Context, candidate store.ReviewWorker, project string, repository int64, pr store.ReviewPR) (store.Completion, error) {
	return r.db.WriteReviewAssignment(ctx, project, func(tx store.ReviewAssignmentWrite) error {
		if _, err := tx.LockAuthorization(ctx, candidate.UserID); err != nil {
			if errors.Is(err, model.ErrNotFound) {
				return nil
			}
			return err
		}
		currentRepo, err := tx.LockConnection(ctx)
		if err != nil {
			return err
		}
		if currentRepo == nil || currentRepo.RepositoryID == nil || *currentRepo.RepositoryID != repository || currentRepo.DefaultBranch == nil {
			return nil
		}
		current, err := tx.LockWorker(ctx, candidate.UserID, candidate.WorkerID)
		if errors.Is(err, model.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		now, err := tx.ObservedAt(ctx)
		if err != nil {
			return err
		}
		if !current.ReviewEnabled || !worker.ActiveAt(current.LastSeenAt, now) {
			return nil
		}
		covered := false
		for _, id := range worker.ReviewProjectIDs(current.DesiredConfiguration) {
			if id == project {
				covered = true
				break
			}
		}
		if !covered {
			return nil
		}
		latest, err := tx.PullRequest(ctx, repository, pr.Number)
		if err != nil {
			return err
		}
		if latest == nil || latest.GitHubID != pr.GitHubID || latest.State != "open" || latest.BaseRef != *currentRepo.DefaultBranch {
			return nil
		}
		_, err = tx.Insert(ctx, candidate.UserID, repository, pr.GitHubID, candidate.WorkerID, now)
		return err
	})
}
