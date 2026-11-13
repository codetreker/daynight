package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"testing"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
	"github.com/google/uuid"
)

type webhookSignalStore struct {
	writes  int
	outcome store.TransactionOutcome
	cause   error
	pr      *store.GitHubPRSignal
	access  *store.GitHubAccessSignal
}

func TestWebhookReceiverLogsCorrelation(t *testing.T) {
	var output bytes.Buffer
	s := &webhookSignalStore{outcome: store.TransactionCommitted}
	r, err := NewWebhookReceiver(s, 1, slog.New(slog.NewJSONHandler(&output, nil)))
	if err != nil {
		t.Fatal(err)
	}
	ctx := requestid.With(context.Background(), "request-1")
	err = r.Receive(ctx, core.WebhookEvent{Kind: "access", DeliveryID: "delivery-1", InstallationID: 2})
	if err != nil {
		t.Fatal(err)
	}
	var entry map[string]any
	if err := json.Unmarshal(output.Bytes(), &entry); err != nil {
		t.Fatal(err)
	}
	if entry["request_id"] != "request-1" || entry["delivery_id"] != "delivery-1" || entry["hint_id"] != s.access.HintID || entry["component"] != "github_sync" || entry["phase"] != "receive" {
		t.Fatalf("correlation log: %+v", entry)
	}
}

func (s *webhookSignalStore) WriteGitHubSignals(_ context.Context, f func(store.GitHubSignalWriter) error) (store.Completion, error) {
	s.writes++
	err := f(s)
	return store.Completion{Outcome: s.outcome}, errors.Join(err, s.cause)
}
func (s *webhookSignalStore) SignalPullRequest(_ context.Context, p store.GitHubPRSignal) (int64, error) {
	s.pr = &p
	return 2, nil
}
func (s *webhookSignalStore) SignalAccess(_ context.Context, p store.GitHubAccessSignal) (int64, error) {
	s.access = &p
	return 2, nil
}

func TestWebhookReceiverPersistsOneSignalAndDoesNotReplayUnknown(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	if _, err := NewWebhookReceiver(nil, 1, logger); err == nil {
		t.Fatal("accepted nil store")
	}
	if _, err := NewWebhookReceiver(&webhookSignalStore{}, 0, logger); err == nil {
		t.Fatal("accepted invalid app")
	}
	if _, err := NewWebhookReceiver(&webhookSignalStore{}, 1, nil); err != nil {
		t.Fatal(err)
	}
	event := core.WebhookEvent{Kind: "pull_request", DeliveryID: "delivery", InstallationID: 4, RepositoryID: 5, Number: 6}
	for _, tc := range []struct {
		outcome   store.TransactionOutcome
		cause     error
		wantError bool
	}{
		{store.TransactionCommitted, nil, false},
		{store.TransactionNotCommitted, errors.New("rollback"), true},
		{store.TransactionUnknown, errors.New("commit response lost"), true},
		{store.TransactionNotCommitted, nil, true},
	} {
		s := &webhookSignalStore{outcome: tc.outcome, cause: tc.cause}
		r, err := NewWebhookReceiver(s, 3, logger)
		if err != nil {
			t.Fatal(err)
		}
		err = r.Receive(context.Background(), event)
		if (err != nil) != tc.wantError || s.writes != 1 || s.pr == nil || s.access != nil || s.pr.AppID != 3 || s.pr.DeliveryID != event.DeliveryID || s.pr.ReceivedAt.IsZero() || !s.pr.NextAttemptAt.Equal(s.pr.ReceivedAt) {
			t.Fatalf("outcome %s: signal=%+v writes=%d error=%v", tc.outcome, s.pr, s.writes, err)
		}
		if _, parseErr := uuid.Parse(s.pr.RequestID); parseErr != nil {
			t.Fatalf("invalid hint ID: %v", parseErr)
		}
		if tc.cause != nil && !errors.Is(err, tc.cause) {
			t.Fatalf("lost failure cause: %v", err)
		}
		if tc.outcome == store.TransactionUnknown && !errors.Is(err, errUnknown) {
			t.Fatalf("lost unknown outcome: %v", err)
		}
	}
	s := &webhookSignalStore{outcome: store.TransactionCommitted}
	r, _ := NewWebhookReceiver(s, 3, logger)
	event.Kind = "access"
	if err := r.Receive(context.Background(), event); err != nil || s.access == nil || s.pr != nil || s.access.InstallationID != event.InstallationID {
		t.Fatalf("access signal: %+v %v", s, err)
	}
}
