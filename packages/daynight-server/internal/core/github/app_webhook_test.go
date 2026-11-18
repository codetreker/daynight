package github

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type appWebhookWriter struct {
	access *store.GitHubAppAccessSignal
	err    error
}

func (w *appWebhookWriter) SignalAccess(_ context.Context, s store.GitHubAppAccessSignal) (int64, error) {
	w.access = &s
	return 3, w.err
}

func TestRecordAppWebhook(t *testing.T) {
	now := time.Now().UTC()
	e := WebhookEvent{Kind: "access", DeliveryID: "delivery", InstallationID: 11}
	w := &appWebhookWriter{}
	n, err := RecordAppWebhook(context.Background(), w, e, "hint", now)
	if err != nil || n != 3 || w.access == nil || *w.access != (store.GitHubAppAccessSignal{InstallationID: 11, HintID: "hint", DeliveryID: "delivery", ReceivedAt: now}) {
		t.Fatalf("access: %d %+v %v", n, w, err)
	}
	for _, bad := range []WebhookEvent{{Kind: "other", DeliveryID: "d", InstallationID: 1}, {Kind: "access", DeliveryID: " ", InstallationID: 1}, {Kind: "access", DeliveryID: "d"}, {Kind: "pull_request", DeliveryID: "d", InstallationID: 1, RepositoryID: 1, Number: 1}} {
		w = &appWebhookWriter{}
		if _, err := RecordAppWebhook(context.Background(), w, bad, "hint", now); err == nil || w.access != nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
	for _, args := range []struct {
		w    store.GitHubAppSignalWriter
		hint string
		now  time.Time
	}{{nil, "hint", now}, {&appWebhookWriter{}, "", now}, {&appWebhookWriter{}, "hint", time.Time{}}} {
		if _, err := RecordAppWebhook(context.Background(), args.w, e, args.hint, args.now); err == nil {
			t.Fatal("accepted invalid dependencies")
		}
	}
	cause := errors.New("write failed")
	if _, err := RecordAppWebhook(context.Background(), &appWebhookWriter{err: cause}, e, "hint", now); !errors.Is(err, cause) {
		t.Fatalf("lost cause %v", err)
	}
}
