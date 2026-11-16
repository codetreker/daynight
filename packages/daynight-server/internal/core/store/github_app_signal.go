package store

import (
	"context"
	"errors"
	"time"
)

// ErrGitHubAppWebhookChanged means the authenticated snapshot no longer
// identifies the live credentials at the signal transaction boundary.
var ErrGitHubAppWebhookChanged = errors.New("github app webhook credentials changed")

// GitHubAppWebhookSnapshot contains secrets solely for authenticating a
// webhook. It must not be included in logs or public representations.
type GitHubAppWebhookSnapshot struct {
	GitHubAppID, CredentialVersion int64
	Secret                         []byte
}

type GitHubAppPRSignal struct {
	InstallationID, RepositoryID, Number int64
	RequestID, DeliveryID                string
	ReceivedAt, NextAttemptAt            time.Time
}

type GitHubAppAccessSignal struct {
	InstallationID     int64
	HintID, DeliveryID string
	ReceivedAt         time.Time
}

// GitHubAppSignalWriter is bound to the authenticated App transaction.
// Matching connections are locked in Project order before pending rows.
type GitHubAppSignalWriter interface {
	SignalPullRequest(context.Context, GitHubAppPRSignal) (int64, error)
	SignalAccess(context.Context, GitHubAppAccessSignal) (int64, error)
}

// GitHubAppWebhookStore reads the secret outside the transaction and rechecks
// its exact version under the App lock before invoking the writer.
type GitHubAppWebhookStore interface {
	ReadGitHubAppWebhook(context.Context, string) (GitHubAppWebhookSnapshot, error)
	WriteGitHubAppSignals(context.Context, string, int64, func(GitHubAppSignalWriter) error) (Completion, error)
}
