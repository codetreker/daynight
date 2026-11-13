package github

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type webhookWriter struct {
	pr     *store.GitHubPRSignal
	access *store.GitHubAccessSignal
	cause  error
}

func (w *webhookWriter) SignalPullRequest(_ context.Context, signal store.GitHubPRSignal) (int64, error) {
	w.pr = &signal
	return 2, w.cause
}
func (w *webhookWriter) SignalAccess(_ context.Context, signal store.GitHubAccessSignal) (int64, error) {
	w.access = &signal
	return 3, w.cause
}

func TestRecordWebhookRoutesOnlyIdentity(t *testing.T) {
	now := time.Date(2026, 11, 13, 1, 2, 3, 0, time.UTC)
	w := &webhookWriter{}
	e := WebhookEvent{Kind: "pull_request", DeliveryID: "delivery", InstallationID: 11, RepositoryID: 12, Number: 13}
	n, err := RecordWebhook(context.Background(), w, 10, e, "hint", now)
	if err != nil || n != 2 || w.access != nil || w.pr == nil || *w.pr != (store.GitHubPRSignal{AppID: 10, InstallationID: 11, RepositoryID: 12, Number: 13, RequestID: "hint", DeliveryID: "delivery", ReceivedAt: now, NextAttemptAt: now}) {
		t.Fatalf("PR signal: %d %+v %v", n, w, err)
	}
	w = &webhookWriter{}
	e.Kind = "access"
	n, err = RecordWebhook(context.Background(), w, 10, e, "hint", now)
	if err != nil || n != 3 || w.pr != nil || w.access == nil || *w.access != (store.GitHubAccessSignal{AppID: 10, InstallationID: 11, HintID: "hint", DeliveryID: "delivery", ReceivedAt: now}) {
		t.Fatalf("access signal: %d %+v %v", n, w, err)
	}
}

func TestRecordWebhookRejectsInvalidInputsBeforeWriting(t *testing.T) {
	now := time.Now()
	valid := WebhookEvent{Kind: "pull_request", DeliveryID: "delivery", InstallationID: 1, RepositoryID: 2, Number: 3}
	for _, e := range []WebhookEvent{
		{Kind: "unknown", DeliveryID: "d", InstallationID: 1},
		{Kind: "access", DeliveryID: " ", InstallationID: 1},
		{Kind: "access", DeliveryID: "d"},
		{Kind: "pull_request", DeliveryID: "d", InstallationID: 1, Number: 1},
		{Kind: "pull_request", DeliveryID: "d", InstallationID: 1, RepositoryID: 1},
	} {
		w := &webhookWriter{}
		if _, err := RecordWebhook(context.Background(), w, 1, e, "hint", now); err == nil || w.pr != nil || w.access != nil {
			t.Fatalf("accepted invalid event %+v", e)
		}
	}
	for _, tc := range []struct {
		writer store.GitHubSignalWriter
		app    int64
		hint   string
		now    time.Time
	}{
		{nil, 1, "hint", now}, {&webhookWriter{}, 0, "hint", now}, {&webhookWriter{}, 1, "", now}, {&webhookWriter{}, 1, "hint", time.Time{}},
	} {
		if _, err := RecordWebhook(context.Background(), tc.writer, tc.app, valid, tc.hint, tc.now); err == nil {
			t.Fatal("accepted invalid signal dependencies")
		}
	}
	cause := errors.New("write failed")
	if _, err := RecordWebhook(context.Background(), &webhookWriter{cause: cause}, 1, valid, "hint", now); !errors.Is(err, cause) {
		t.Fatalf("lost cause: %v", err)
	}
}
