package github

import (
	"context"
	"errors"
	"log/slog"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
	"github.com/google/uuid"
)

// WebhookReceiver persists signed event hints before acknowledging a delivery.
type WebhookReceiver struct {
	db     store.GitHubSignalTransaction
	appID  int64
	logger *slog.Logger
}

func NewWebhookReceiver(db store.GitHubSignalTransaction, appID int64, logger *slog.Logger) (*WebhookReceiver, error) {
	if db == nil || appID <= 0 {
		return nil, errors.New("github webhook receiver requires signal store and app ID")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &WebhookReceiver{db: db, appID: appID, logger: logger}, nil
}

// Receive performs one atomic broadcast and does not retry an uncertain commit.
func (r *WebhookReceiver) Receive(ctx context.Context, event core.WebhookEvent) error {
	id, now := uuid.NewString(), time.Now().UTC()
	start := time.Now()
	var matched int64
	completion, err := r.db.WriteGitHubSignals(ctx, func(w store.GitHubSignalWriter) error {
		var e error
		matched, e = core.RecordWebhook(ctx, w, r.appID, event, id, now)
		return e
	})
	err = committed(completion, err)
	attrs := []any{"component", "github_sync", "phase", "receive", "request_id", requestid.From(ctx), "delivery_id", event.DeliveryID, "hint_id", id, "result_code", string(completion.Outcome), "duration_ms", time.Since(start).Milliseconds()}
	if err != nil {
		r.logger.WarnContext(ctx, "github webhook signal failed", attrs...)
		return err
	}
	r.logger.InfoContext(ctx, "github webhook signal recorded", append(attrs, "matched_projects", matched)...)
	return nil
}
