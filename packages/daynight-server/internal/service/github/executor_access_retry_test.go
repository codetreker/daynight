package github

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

type retryScope struct{ store.ProjectWriteScope }

func (s retryScope) GitHubDAO() store.GitHubWriteDAO {
	return retryDAO{s.ProjectWriteScope.GitHubDAO()}
}

type retryDAO struct{ store.GitHubWriteDAO }

func (d retryDAO) ValidLease(_ context.Context, _ store.GitHubLease) (bool, error) { return true, nil }

func TestWebhookAccessFailureReschedulesCapturedRequests(t *testing.T) {
	f := newPollFixture(t)
	originalWrite := f.db.write
	f.db.write = func(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
		return originalWrite(ctx, id, func(scope store.ProjectWriteScope) error { return work(retryScope{scope}) })
	}
	f.workKind = "webhook"
	f.connection.NextPollAt = nil
	pollError := "older-poll-failure"
	f.connection.PollErrorCode = &pollError
	f.hints = []store.GitHubPendingPR{{Number: 4, Generation: 7, RequestID: "captured", DeliveryID: "delivery"}}
	r := f.remote()
	temporary := errors.New("temporary access failure")
	r.verify = func(ctx context.Context, _ int64, _, _ string) (githubpr.RepositoryObservation, error) {
		if err := remote.CheckpointRequest(ctx); err != nil {
			return githubpr.RepositoryObservation{}, err
		}
		return githubpr.RepositoryObservation{}, temporary
	}
	if err := f.run(r); !errors.Is(err, temporary) {
		t.Fatalf("error %v", err)
	}
	if len(f.rescheduled) != 1 || f.rescheduled[0] != "captured" {
		t.Fatalf("rescheduled: %v", f.rescheduled)
	}
	if len(f.publications) != 0 || len(f.ackRequests) != 0 {
		t.Fatalf("unexpected publish or ack")
	}
	w := f.runtimes[len(f.runtimes)-1]
	if !w.ReleaseClaim || w.WebhookErrorCode == nil || w.PollErrorCode == nil || *w.PollErrorCode != pollError || w.NextAccessCheckAt == nil || !w.NextAccessCheckAt.Equal(f.now.Add(30*time.Second)) {
		t.Fatalf("access retry: %+v", w)
	}
}
