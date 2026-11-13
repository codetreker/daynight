package github

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// WebhookEvent is the verified, minimally decoded identity of a GitHub event.
// Its body is never used as a PR observation or proof of current access.
type WebhookEvent struct {
	Kind                                 string
	DeliveryID                           string
	InstallationID, RepositoryID, Number int64
}

// RecordWebhook routes one verified event to all matching enabled connections.
// The caller owns the transaction and supplies one fresh hint ID per delivery.
func RecordWebhook(ctx context.Context, writer store.GitHubSignalWriter, appID int64, event WebhookEvent, hintID string, now time.Time) (int64, error) {
	if writer == nil || appID <= 0 || event.InstallationID <= 0 || strings.TrimSpace(event.DeliveryID) == "" || hintID == "" || now.IsZero() {
		return 0, errors.New("invalid github webhook signal")
	}
	switch event.Kind {
	case "pull_request":
		if event.RepositoryID <= 0 || event.Number <= 0 {
			return 0, errors.New("invalid github pull request signal")
		}
		return writer.SignalPullRequest(ctx, store.GitHubPRSignal{AppID: appID, InstallationID: event.InstallationID, RepositoryID: event.RepositoryID, Number: event.Number, RequestID: hintID, DeliveryID: event.DeliveryID, ReceivedAt: now, NextAttemptAt: now})
	case "access":
		return writer.SignalAccess(ctx, store.GitHubAccessSignal{AppID: appID, InstallationID: event.InstallationID, HintID: hintID, DeliveryID: event.DeliveryID, ReceivedAt: now})
	default:
		return 0, errors.New("invalid github webhook event kind")
	}
}
