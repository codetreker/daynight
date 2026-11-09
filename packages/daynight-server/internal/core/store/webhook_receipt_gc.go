package store

import (
	"context"
	"errors"
	"time"

	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

var ErrWebhookReceiptFenceBusy = errors.New("webhook operation fence busy")

// WebhookReceiptIdentity names the immutable operation namespace of a receipt.
type WebhookReceiptIdentity struct {
	Owner       webhook.Owner
	OperationID string
}

// WebhookReceiptGC separates the unlocked candidate scan from the fenced write.
type WebhookReceiptGC interface {
	ExpiredWebhookReceipts(context.Context, *WebhookReceiptIdentity, int) ([]WebhookReceiptIdentity, error)
	WriteWebhookReceiptGC(context.Context, WebhookReceiptIdentity, func(WebhookReceiptGCScope) error) (Completion, error)
	// An unfenced observation cannot prove a particular transaction's outcome.
	ObserveWebhookReceipt(context.Context, WebhookReceiptIdentity) (expiresAt time.Time, present bool, err error)
}

type WebhookReceiptGCScope interface {
	// ReceiptExpiry locks the receipt after its operation fence. A missing row
	// can result from another collector and is reported as present=false.
	ReceiptExpiry(context.Context, WebhookReceiptIdentity) (expiresAt, observedAt time.Time, present bool, err error)
	DeleteReceipt(context.Context, WebhookReceiptIdentity) (bool, error)
}
