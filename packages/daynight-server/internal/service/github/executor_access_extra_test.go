package github

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

type accessTestDAO struct {
	store.GitHubWorkDAO
	ack func(context.Context, store.GitHubLease, string) (bool, error)
}

func (d accessTestDAO) AckAccessHint(ctx context.Context, l store.GitHubLease, id string) (bool, error) {
	return d.ack(ctx, l, id)
}

func TestExecutorAcknowledgesAccessHintOnlyAfterVerification(t *testing.T) {
	for _, valid := range []bool{true, false} {
		t.Run(map[bool]string{true: "available", false: "denied"}[valid], func(t *testing.T) {
			f := newPollFixture(t)
			f.workKind = "access"
			hint := "hint-original"
			f.connection.AccessHintID = &hint
			f.connection.NextAccessCheckAt = &f.now
			old := f.db.write
			acks := 0
			f.db.write = func(ctx context.Context, id string, work func(store.GitHubWorkDAO) error) (store.Completion, error) {
				return old(ctx, id, func(dao store.GitHubWorkDAO) error {
					return work(accessTestDAO{dao, func(_ context.Context, l store.GitHubLease, id string) (bool, error) {
						if id != hint || l != f.lease {
							t.Fatalf("ack %q %+v", id, l)
						}
						acks++
						return true, nil
					}})
				})
			}
			r := f.remote()
			if !valid {
				r.verify = func(ctx context.Context, _ int64, _, _ string) (githubpr.RepositoryObservation, error) {
					if err := remote.CheckpointRequest(ctx); err != nil {
						return githubpr.RepositoryObservation{}, err
					}
					return githubpr.RepositoryObservation{}, &remote.Error{Code: "permission_denied", Status: 403}
				}
				r.resolve = func(ctx context.Context, _, _ int64) (githubpr.RepositoryObservation, error) {
					if err := remote.CheckpointRequest(ctx); err != nil {
						return githubpr.RepositoryObservation{}, err
					}
					return githubpr.RepositoryObservation{}, &remote.Error{Code: "permission_denied", Status: 403}
				}
			}
			err := f.run(r)
			if valid && err != nil || !valid && !errors.Is(err, errAccessStop) {
				t.Fatalf("access error %v", err)
			}
			w := f.runtimes[len(f.runtimes)-1]
			if (valid && acks != 1 || !valid && acks != 0) || !w.ReleaseClaim {
				t.Fatalf("acks=%d state=%+v", acks, w)
			}
			if valid && w.AccessState != "available" || !valid && (w.AccessState != "unavailable" || w.AccessReason == nil || *w.AccessReason != "permission_denied") {
				t.Fatalf("state %+v", w)
			}
		})
	}
}

func TestAccessFailurePreservesPRChannels(t *testing.T) {
	for _, tc := range []struct {
		name      string
		failure   error
		wantNext  time.Duration
		wantState string
		hinted    bool
	}{
		{"hint temporary", errors.New("temporary"), 30 * time.Second, "available", true},
		{"hint confirmed denial", &remote.Error{Code: "permission_denied", Status: 403}, 5 * time.Minute, "unavailable", true},
		{"scheduled temporary", errors.New("temporary"), 30 * time.Second, "available", false},
		{"scheduled confirmed denial", &remote.Error{Code: "permission_denied", Status: 403}, 5 * time.Minute, "unavailable", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newPollFixture(t)
			f.workKind = "access"
			hint, pollCode, webhookCode := "original-hint", "prior-poll-error", "prior-webhook-error"
			if tc.hinted {
				f.connection.AccessHintID = &hint
			}
			f.connection.PollErrorCode, f.connection.WebhookErrorCode = &pollCode, &webhookCode
			f.connection.NextAccessCheckAt = &f.now
			r := f.remote()
			r.verify = func(ctx context.Context, _ int64, _, _ string) (githubpr.RepositoryObservation, error) {
				if err := remote.CheckpointRequest(ctx); err != nil {
					return githubpr.RepositoryObservation{}, err
				}
				return githubpr.RepositoryObservation{}, tc.failure
			}
			r.resolve = func(ctx context.Context, _, _ int64) (githubpr.RepositoryObservation, error) {
				if err := remote.CheckpointRequest(ctx); err != nil {
					return githubpr.RepositoryObservation{}, err
				}
				return githubpr.RepositoryObservation{}, tc.failure
			}
			if err := f.run(r); !errors.Is(err, errAccessStop) {
				t.Fatalf("access: %v", err)
			}
			w := f.runtimes[len(f.runtimes)-1]
			next := f.now.Add(tc.wantNext)
			if w.WebhookErrorCode == nil || *w.WebhookErrorCode != webhookCode || w.LastWebhookAttemptAt != nil || w.LastWebhookSuccessAt != nil || w.PollErrorCode == nil || *w.PollErrorCode != pollCode || w.NextPollAt != nil && tc.wantState == "unavailable" || w.AccessState != tc.wantState || w.NextAccessCheckAt == nil || !w.NextAccessCheckAt.Equal(next) || w.NotBefore != nil || !w.ReleaseClaim {
				t.Fatalf("failed event access: %+v", w)
			}
		})
	}
}

func TestAccessSuccessPreservesPRChannels(t *testing.T) {
	for _, hinted := range []bool{false, true} {
		t.Run(map[bool]string{false: "scheduled", true: "installation hint"}[hinted], func(t *testing.T) {
			f := newPollFixture(t)
			f.workKind = "access"
			hint, pollCode, webhookCode := "original-hint", "prior-poll-error", "prior-webhook-error"
			if hinted {
				f.connection.AccessHintID = &hint
			}
			f.connection.PollErrorCode, f.connection.WebhookErrorCode = &pollCode, &webhookCode
			oldAttempt, oldSuccess := f.now.Add(-time.Hour), f.now.Add(-2*time.Hour)
			f.connection.LastWebhookAttemptAt, f.connection.LastWebhookSuccessAt = &oldAttempt, &oldSuccess
			f.connection.NextAccessCheckAt = &f.now
			old := f.db.write
			acks := 0
			f.db.write = func(ctx context.Context, id string, work func(store.GitHubWorkDAO) error) (store.Completion, error) {
				return old(ctx, id, func(dao store.GitHubWorkDAO) error {
					return work(accessTestDAO{dao, func(_ context.Context, l store.GitHubLease, got string) (bool, error) {
						if l != f.lease || got != hint {
							t.Fatalf("wrong acknowledgement: %s %+v", got, l)
						}
						acks++
						return true, nil
					}})
				})
			}
			if err := f.run(f.remote()); err != nil {
				t.Fatal(err)
			}
			w := f.runtimes[len(f.runtimes)-1]
			wantAcks := 0
			if hinted {
				wantAcks = 1
			}
			if acks != wantAcks || !w.LastWebhookAttemptAt.Equal(oldAttempt) || !w.LastWebhookSuccessAt.Equal(oldSuccess) || w.PollErrorCode == nil || *w.PollErrorCode != pollCode || w.WebhookErrorCode == nil || *w.WebhookErrorCode != webhookCode {
				t.Fatalf("successful event access: %+v", w)
			}
		})
	}
}

func TestEventAccessRateLimitAndStaleAcknowledgement(t *testing.T) {
	t.Run("rate limit", func(t *testing.T) {
		f := newPollFixture(t)
		f.workKind = "access"
		hint := "original-hint"
		f.connection.AccessHintID, f.connection.NextAccessCheckAt = &hint, &f.now
		retry := f.now.Add(2 * time.Minute)
		r := f.remote()
		r.verify = func(ctx context.Context, _ int64, _, _ string) (githubpr.RepositoryObservation, error) {
			if err := remote.CheckpointRequest(ctx); err != nil {
				return githubpr.RepositoryObservation{}, err
			}
			return githubpr.RepositoryObservation{}, &remote.Error{Code: "rate_limited", RetryAt: retry}
		}
		if err := f.run(r); !errors.Is(err, errAccessStop) {
			t.Fatalf("access: %v", err)
		}
		w := f.runtimes[len(f.runtimes)-1]
		if w.WebhookErrorCode != nil || w.LastWebhookAttemptAt != nil || w.PollErrorCode != nil || w.NextAccessCheckAt == nil || !w.NextAccessCheckAt.Equal(retry) || w.NotBefore == nil || !w.NotBefore.Equal(retry) {
			t.Fatalf("rate limit: %+v", w)
		}
	})
	t.Run("stale hint", func(t *testing.T) {
		f := newPollFixture(t)
		f.workKind = "access"
		hint := "original-hint"
		f.connection.AccessHintID, f.connection.NextAccessCheckAt = &hint, &f.now
		old := f.db.write
		f.db.write = func(ctx context.Context, id string, work func(store.GitHubWorkDAO) error) (store.Completion, error) {
			return old(ctx, id, func(dao store.GitHubWorkDAO) error {
				return work(accessTestDAO{dao, func(context.Context, store.GitHubLease, string) (bool, error) { return false, nil }})
			})
		}
		if err := f.run(f.remote()); !errors.Is(err, errLease) {
			t.Fatalf("stale hint: %v", err)
		}
		if len(f.runtimes) != 0 {
			t.Fatalf("stale hint saved runtime: %+v", f.runtimes)
		}
	})
}

func TestAppChangeStopsWithoutRemoteReads(t *testing.T) {
	f := newPollFixture(t)
	f.lease = store.GitHubLease{Generation: 7, Token: "original"}
	f.until = f.now.Add(time.Minute)
	r := f.preparedRun(executorRemote{})
	r.lease, r.connection, r.kind, r.log = f.lease, f.connection, "access", slog.New(slog.NewTextHandler(io.Discard, nil))
	r.appID = 99
	if err := r.execute(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(f.runtimes) != 1 {
		t.Fatalf("runtimes %d", len(f.runtimes))
	}
	w := f.runtimes[0]
	if w.AccessState != "unavailable" || w.AccessReason == nil || *w.AccessReason != "app_changed" || w.NextAccessCheckAt != nil || !w.ReleaseClaim {
		t.Fatalf("app change: %+v", w)
	}
}

func TestAccessCheckCancellationDoesNotPublishFailure(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "access"
	f.connection.NextAccessCheckAt = &f.now
	r := f.remote()
	r.verify = func(_ context.Context, _ int64, _, _ string) (githubpr.RepositoryObservation, error) {
		return githubpr.RepositoryObservation{}, context.Canceled
	}
	if err := f.run(r); !errors.Is(err, context.Canceled) {
		t.Fatalf("error %v", err)
	}
	if len(f.runtimes) != 0 || len(f.publications) != 0 {
		t.Fatalf("cancellation wrote runtime or PR facts")
	}
}

func TestAccessConfirmationDoesNotTreatRateLimitAsRevocation(t *testing.T) {
	f := newPollFixture(t)
	f.workKind = "access"
	f.connection.NextAccessCheckAt = &f.now
	r := f.remote()
	r.verify = func(ctx context.Context, _ int64, _, _ string) (githubpr.RepositoryObservation, error) {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.RepositoryObservation{}, err
		}
		return githubpr.RepositoryObservation{}, &remote.Error{Code: "not_found", Status: 404}
	}
	r.resolve = func(ctx context.Context, _, _ int64) (githubpr.RepositoryObservation, error) {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.RepositoryObservation{}, err
		}
		return githubpr.RepositoryObservation{}, &remote.Error{Code: "not_found", Status: 404}
	}
	retry := f.now.Add(2 * time.Minute)
	r.installation = func(ctx context.Context, _ int64) (remote.InstallationStatus, error) {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return remote.InstallationStatus{}, err
		}
		return remote.InstallationStatus{}, &remote.Error{Code: "rate_limited", Status: 429, RetryAt: retry}
	}
	if err := f.run(r); !errors.Is(err, errAccessStop) {
		t.Fatalf("error %v", err)
	}
	w := f.runtimes[len(f.runtimes)-1]
	if w.AccessState != "available" || w.AccessReason != nil || w.NotBefore == nil || !w.NotBefore.Equal(retry) || w.NextAccessCheckAt == nil || !w.NextAccessCheckAt.Equal(retry) || !w.ReleaseClaim {
		t.Fatalf("rate limit: %+v", w)
	}
}

func TestRepositoryIdentityRefusalAndCancellation(t *testing.T) {
	app, installation, repo := int64(10), int64(20), int64(30)
	name := "old/name"
	for _, tc := range []struct {
		name    string
		resolve func(context.Context, int64, int64) (githubpr.RepositoryObservation, error)
		want    error
	}{
		{"wrong stable identity", func(context.Context, int64, int64) (githubpr.RepositoryObservation, error) {
			return githubpr.RepositoryObservation{ID: 31, FullName: "new/name"}, nil
		}, nil},
		{"cancelled", func(context.Context, int64, int64) (githubpr.RepositoryObservation, error) {
			return githubpr.RepositoryObservation{}, context.Canceled
		}, context.Canceled},
		{"invalid resolved name", func(context.Context, int64, int64) (githubpr.RepositoryObservation, error) {
			return githubpr.RepositoryObservation{ID: 30, FullName: "invalid"}, nil
		}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := executorRemote{verify: func(context.Context, int64, string, string) (githubpr.RepositoryObservation, error) {
				return githubpr.RepositoryObservation{}, &remote.Error{Code: "not_found", Status: 404}
			}, resolve: tc.resolve}
			run := run{remote: r, connection: githubpr.Connection{AppID: &app, InstallationID: &installation, RepositoryID: &repo, RepositoryFullName: &name}}
			_, err := run.repository(context.Background())
			if err == nil || tc.want != nil && !errors.Is(err, tc.want) {
				t.Fatalf("error %v", err)
			}
		})
	}
}

type accessFaultDAO struct {
	store.GitHubWorkDAO
	fail  string
	cause error
}

func (d accessFaultDAO) Connection(ctx context.Context) (githubpr.Connection, error) {
	if d.fail == "connection" {
		return githubpr.Connection{}, d.cause
	}
	return d.GitHubWorkDAO.Connection(ctx)
}
func (d accessFaultDAO) ObservedAt(ctx context.Context) (time.Time, error) {
	if d.fail == "clock" {
		return time.Time{}, d.cause
	}
	return d.GitHubWorkDAO.ObservedAt(ctx)
}
func (d accessFaultDAO) Renew(ctx context.Context, l store.GitHubLease, at time.Time) (bool, error) {
	if d.fail == "renew" {
		return false, d.cause
	}
	return d.GitHubWorkDAO.Renew(ctx, l, at)
}
func (d accessFaultDAO) SaveRuntime(ctx context.Context, l store.GitHubLease, w store.GitHubRuntimeWrite) (bool, error) {
	if d.fail == "save" {
		return false, d.cause
	}
	return d.GitHubWorkDAO.SaveRuntime(ctx, l, w)
}
func (d accessFaultDAO) AckAccessHint(_ context.Context, _ store.GitHubLease, _ string) (bool, error) {
	if d.fail == "ack" {
		return false, d.cause
	}
	return true, nil
}
func TestAccessDatabaseFailuresPropagateWithoutCompletion(t *testing.T) {
	for _, tc := range []struct{ name, operation, fault string }{
		{"renew connection", "renew", "connection"}, {"renew clock", "renew", "clock"}, {"renew write", "renew", "renew"},
		{"runtime connection", "runtime", "connection"}, {"runtime clock", "runtime", "clock"}, {"runtime write", "runtime", "save"},
		{"save failed access", "failure", "save"},
		{"ack successful access", "access", "ack"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newPollFixture(t)
			f.lease = store.GitHubLease{Generation: 7, Token: "original"}
			f.until = f.now.Add(time.Minute)
			hint := "captured"
			f.connection.AccessHintID = &hint
			failure := errors.New("database failure")
			old := f.db.write
			f.db.write = func(ctx context.Context, id string, work func(store.GitHubWorkDAO) error) (store.Completion, error) {
				return old(ctx, id, func(dao store.GitHubWorkDAO) error { return work(accessFaultDAO{dao, tc.fault, failure}) })
			}
			r := f.preparedRun(f.remote())
			r.lease, r.connection, r.kind, r.log = f.lease, f.connection, "access", slog.New(slog.NewTextHandler(io.Discard, nil))
			var err error
			switch tc.operation {
			case "renew":
				err = r.renew(context.Background())
			case "runtime":
				err = r.runtime(context.Background(), func(*store.GitHubRuntimeWrite, githubpr.Connection, time.Time) {})
			case "failure":
				err = r.recordAccessFailure(context.Background(), errors.New("unavailable"), "", false)
			case "access":
				err = r.access(context.Background())
			}
			if !errors.Is(err, failure) || !errors.Is(err, errTransaction) {
				t.Fatalf("error %v", err)
			}
			if len(f.runtimes) != 0 {
				t.Fatalf("saved runtime on failure: %+v", f.runtimes)
			}
		})
	}
}
