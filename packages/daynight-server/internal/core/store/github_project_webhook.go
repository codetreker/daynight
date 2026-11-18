package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// GitHubProjectWebhook is the safe projection; secret bytes are never included.
type GitHubProjectWebhook struct {
	Version, RepositoryID, CurrentRepositoryID *int64
	Enabled                                    bool
	LastReceivedAt                             *time.Time
}

type GitHubProjectWebhookLocked struct {
	GitHubProjectWebhook
	Secret               []byte
	Exists, BindingValid bool
}

type GitHubProjectWebhookWrite struct {
	ExpectedVersion       *int64
	Version, RepositoryID int64
	Enabled               bool
	Secret                []byte
}

type GitHubProjectWebhookScope interface {
	GitHubProjectWebhookDAO() GitHubProjectWebhookWriteDAO
}

type GitHubProjectWebhookReadDAO interface {
	ProjectWebhook(context.Context) (GitHubProjectWebhook, error)
}

type GitHubProjectWebhookWriteDAO interface {
	Authorization(context.Context, model.Principal) (model.ProjectAccess, error)
	LockWebhook(context.Context) (GitHubProjectWebhookLocked, error)
	SaveWebhook(context.Context, GitHubProjectWebhookWrite) (bool, error)
}

// GitHubProjectWebhookSecret is a narrow credential snapshot for signature verification.
type GitHubProjectWebhookSecret struct {
	Version, RepositoryID int64
	Secret                []byte
}

type GitHubProjectWebhookSecretReader interface {
	ReadGitHubProjectWebhookSecret(context.Context, string) (GitHubProjectWebhookSecret, error)
}

// GitHubProjectWebhookReceiptScope is bound to a live, locked Project.
type GitHubProjectWebhookReceiptScope interface {
	GitHubProjectWebhookReceiptDAO() GitHubProjectWebhookReceiptDAO
}

// GitHubProjectWebhookReceiptFacts are read while the connection row is locked.
type GitHubProjectWebhookReceiptFacts struct {
	Exists, Enabled, SyncEnabled, BindingValid, AccessAvailable bool
	Version, RepositoryID, CurrentRepositoryID                  *int64
	Generation                                                  int64
}

type GitHubProjectWebhookReceiptWrite struct {
	Enqueue               bool
	Number                int64
	RequestID, DeliveryID string
}

type GitHubProjectWebhookReceiptDAO interface {
	LockReceipt(context.Context) (GitHubProjectWebhookReceiptFacts, error)
	RecordReceipt(context.Context, GitHubProjectWebhookReceiptWrite) error
}
