package github

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// RecordAppWebhook turns an authenticated delivery into a hint, never a PR fact.
// The writer is bound to the current App and its credential version.
func RecordAppWebhook(ctx context.Context, writer store.GitHubAppSignalWriter, event WebhookEvent, hintID string, now time.Time) (int64, error) {
	if writer == nil || event.InstallationID <= 0 || strings.TrimSpace(event.DeliveryID) == "" || hintID == "" || now.IsZero() {
		return 0, errors.New("invalid github app webhook signal")
	}
	switch event.Kind {
	case "access":
		return writer.SignalAccess(ctx, store.GitHubAppAccessSignal{InstallationID: event.InstallationID, HintID: hintID, DeliveryID: event.DeliveryID, ReceivedAt: now})
	default:
		return 0, errors.New("invalid github webhook event kind")
	}
}
