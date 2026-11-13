package github

import (
	"context"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

// executorStore controls each transaction outcome independently of its callback.
// Captured writes are proposals, not evidence of persistence.
type executorStore struct {
	t        *testing.T
	write    func(context.Context, string, func(store.ProjectWriteScope) error) (store.Completion, error)
	snapshot func(context.Context, func(store.SnapshotScope) error) error
}

func (s *executorStore) WriteProject(ctx context.Context, id string, f func(store.ProjectWriteScope) error) (store.Completion, error) {
	if s.write == nil {
		s.t.Fatal("unexpected WriteProject")
	}
	return s.write(ctx, id, f)
}

func (s *executorStore) ReadSnapshot(ctx context.Context, f func(store.SnapshotScope) error) error {
	if s.snapshot == nil {
		s.t.Fatal("unexpected ReadSnapshot")
	}
	return s.snapshot(ctx, f)
}

type executorWriteScope struct {
	store.ProjectWriteScope
	dao store.GitHubWriteDAO
}

func (s executorWriteScope) GitHubDAO() store.GitHubWriteDAO { return s.dao }

type executorSnapshotScope struct {
	store.SnapshotScope
	dao   store.GitHubReadDAO
	clock func(context.Context) (time.Time, error)
}

func (s executorSnapshotScope) GitHubDAO() store.GitHubReadDAO { return s.dao }
func (s executorSnapshotScope) ObservedAt(ctx context.Context) (time.Time, error) {
	return s.clock(ctx)
}

type executorReadDAO struct {
	store.GitHubReadDAO
	connection func(context.Context, string) (githubpr.Connection, error)
	pull       func(context.Context, string, int64) (githubpr.PullRequest, error)
}

func (d executorReadDAO) Connection(ctx context.Context, id string) (githubpr.Connection, error) {
	return d.connection(ctx, id)
}

func (d executorReadDAO) PullRequest(ctx context.Context, id string, n int64) (githubpr.PullRequest, error) {
	return d.pull(ctx, id, n)
}

type executorWriteDAO struct {
	store.GitHubWriteDAO
	connection func(context.Context) (githubpr.Connection, error)
	clock      func(context.Context) (time.Time, error)
	due        func(context.Context, time.Time) (bool, error)
	claim      func(context.Context, store.GitHubClaim) (bool, error)
	renew      func(context.Context, store.GitHubLease, time.Time) (bool, error)
	valid      func(context.Context, store.GitHubLease) (bool, error)
	publish    func(context.Context, store.GitHubLease, []githubpr.PullRequest) (bool, error)
	repository func(context.Context, store.GitHubLease, store.GitHubRepositoryObservation) (bool, error)
	unseen     func(context.Context, store.GitHubLease, string, int64, int) ([]int64, bool, error)
	pending    func(context.Context, store.GitHubLease, time.Time, int) ([]store.GitHubPendingPR, bool, error)
	hasPending func(context.Context, store.GitHubLease) (bool, bool, error)
	ack        func(context.Context, store.GitHubLease, int64, string) (bool, error)
	reschedule func(context.Context, store.GitHubLease, int64, string, time.Time) (bool, error)
	accessHint func(context.Context, store.GitHubLease, string) (bool, error)
	runtime    func(context.Context, store.GitHubLease, store.GitHubRuntimeWrite) (bool, error)
}

func (d executorWriteDAO) Connection(ctx context.Context) (githubpr.Connection, error) {
	return d.connection(ctx)
}
func (d executorWriteDAO) ObservedAt(ctx context.Context) (time.Time, error) { return d.clock(ctx) }
func (d executorWriteDAO) HasDuePending(ctx context.Context, now time.Time) (bool, error) {
	return d.due(ctx, now)
}
func (d executorWriteDAO) Claim(ctx context.Context, v store.GitHubClaim) (bool, error) {
	return d.claim(ctx, v)
}
func (d executorWriteDAO) Renew(ctx context.Context, l store.GitHubLease, t time.Time) (bool, error) {
	return d.renew(ctx, l, t)
}
func (d executorWriteDAO) ValidLease(ctx context.Context, l store.GitHubLease) (bool, error) {
	return d.valid(ctx, l)
}
func (d executorWriteDAO) Publish(ctx context.Context, l store.GitHubLease, p []githubpr.PullRequest) (bool, error) {
	return d.publish(ctx, l, p)
}
func (d executorWriteDAO) PublishRepository(ctx context.Context, l store.GitHubLease, p store.GitHubRepositoryObservation) (bool, error) {
	return d.repository(ctx, l, p)
}
func (d executorWriteDAO) UnseenActive(ctx context.Context, l store.GitHubLease, p string, a int64, n int) ([]int64, bool, error) {
	return d.unseen(ctx, l, p, a, n)
}
func (d executorWriteDAO) Pending(ctx context.Context, l store.GitHubLease, now time.Time, n int) ([]store.GitHubPendingPR, bool, error) {
	return d.pending(ctx, l, now, n)
}
func (d executorWriteDAO) HasPending(ctx context.Context, l store.GitHubLease) (bool, bool, error) {
	return d.hasPending(ctx, l)
}
func (d executorWriteDAO) AckPending(ctx context.Context, l store.GitHubLease, n int64, r string) (bool, error) {
	return d.ack(ctx, l, n, r)
}
func (d executorWriteDAO) ReschedulePending(ctx context.Context, l store.GitHubLease, n int64, r string, next time.Time) (bool, error) {
	return d.reschedule(ctx, l, n, r, next)
}
func (d executorWriteDAO) AckAccessHint(ctx context.Context, l store.GitHubLease, h string) (bool, error) {
	return d.accessHint(ctx, l, h)
}
func (d executorWriteDAO) SaveRuntime(ctx context.Context, l store.GitHubLease, v store.GitHubRuntimeWrite) (bool, error) {
	return d.runtime(ctx, l, v)
}

type executorRemote struct {
	installation func(context.Context, int64) (remote.InstallationStatus, error)
	verify       func(context.Context, int64, string, string) (githubpr.RepositoryObservation, error)
	resolve      func(context.Context, int64, int64) (githubpr.RepositoryObservation, error)
	list         func(context.Context, int64, string, string, func([]githubpr.Observation) error) error
	pull         func(context.Context, int64, string, string, int64) (githubpr.Observation, error)
}

func (r executorRemote) Installation(c context.Context, i int64) (remote.InstallationStatus, error) {
	return r.installation(c, i)
}

func (r executorRemote) VerifyAccess(c context.Context, i int64, o, n string) (githubpr.RepositoryObservation, error) {
	return r.verify(c, i, o, n)
}
func (r executorRemote) ResolveRepository(c context.Context, i, id int64) (githubpr.RepositoryObservation, error) {
	return r.resolve(c, i, id)
}
func (r executorRemote) ListOpen(c context.Context, i int64, o, n string, visit func([]githubpr.Observation) error) error {
	return r.list(c, i, o, n, visit)
}
func (r executorRemote) PullRequest(c context.Context, i int64, o, repo string, n int64) (githubpr.Observation, error) {
	return r.pull(c, i, o, repo, n)
}
