package github

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"strings"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
	"github.com/google/uuid"
)

var ErrAppWebhookUnauthenticated = errors.New("invalid github app webhook signature")

// AppWebhookIdentity binds the signature proof to a live local App version.
type AppWebhookIdentity struct {
	AppID             string
	CredentialVersion int64
}

type AppWebhookReceiver struct {
	db     store.GitHubAppWebhookStore
	logger *slog.Logger
}

func NewAppWebhookReceiver(db store.GitHubAppWebhookStore, logger *slog.Logger) (*AppWebhookReceiver, error) {
	if db == nil {
		return nil, errors.New("github app webhook receiver requires store")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &AppWebhookReceiver{db: db, logger: logger}, nil
}

// AuthenticateAppWebhook verifies exactly the original bytes outside a transaction.
func (r *AppWebhookReceiver) AuthenticateAppWebhook(ctx context.Context, appID string, body []byte, signature string) (AppWebhookIdentity, error) {
	snapshot, err := r.db.ReadGitHubAppWebhook(ctx, appID)
	if err != nil {
		return AppWebhookIdentity{}, err
	}
	if !strings.HasPrefix(signature, "sha256=") || len(signature) != len("sha256=")+sha256.Size*2 {
		return AppWebhookIdentity{}, ErrAppWebhookUnauthenticated
	}
	value, err := hex.DecodeString(signature[len("sha256="):])
	if err != nil {
		return AppWebhookIdentity{}, ErrAppWebhookUnauthenticated
	}
	mac := hmac.New(sha256.New, snapshot.Secret)
	_, _ = mac.Write(body)
	if !hmac.Equal(value, mac.Sum(nil)) {
		return AppWebhookIdentity{}, ErrAppWebhookUnauthenticated
	}
	return AppWebhookIdentity{AppID: appID, CredentialVersion: snapshot.CredentialVersion}, nil
}

// ReceiveAppWebhook writes once and acknowledges only a confirmed commit.
func (r *AppWebhookReceiver) ReceiveAppWebhook(ctx context.Context, identity AppWebhookIdentity, event core.WebhookEvent) error {
	id, now := uuid.NewString(), time.Now().UTC()
	start := time.Now()
	var matched int64
	completion, err := r.db.WriteGitHubAppSignals(ctx, identity.AppID, identity.CredentialVersion, func(w store.GitHubAppSignalWriter) error {
		var e error
		matched, e = core.RecordAppWebhook(ctx, w, event, id, now)
		return e
	})
	err = committed(completion, err)
	attrs := []any{"component", "github_webhook", "phase", "receive", "request_id", requestid.From(ctx), "app_resource_id", identity.AppID, "credential_version", identity.CredentialVersion, "event", event.Kind, "delivery_id", event.DeliveryID, "write_outcome", string(completion.Outcome), "duration_ms", time.Since(start).Milliseconds()}
	if err != nil {
		r.logger.WarnContext(ctx, "github app webhook signal failed", attrs...)
		return err
	}
	r.logger.InfoContext(ctx, "github app webhook signal recorded", append(attrs, "matched_projects", matched)...)
	return nil
}
