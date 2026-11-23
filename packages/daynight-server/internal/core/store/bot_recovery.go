package store

import (
	"context"
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// BotRecoveryOperation retains one original request and its safe receipt.
// Receipt must not contain recovery identities or Controller grant tokens.
type BotRecoveryOperation struct {
	OperationID string
	Kind        string
	RequestHash []byte
	Receipt     json.RawMessage
}

// BotRecoveryDAO shares the Bot/Session transaction. Callers lock the Bot before
// reading its recovery state and retain that lock through the Session update.
type BotRecoveryDAO interface {
	RecoveryWorker(context.Context, string, string) (model.WorkerMachine, error)
	RegisterBotRecovery(context.Context, string, int64, model.BotRecovery) (model.Bot, error)
	AdvanceBotRecovery(context.Context, string, int64, int64, string, model.WorkerMachine) (model.Bot, error)
	BotRecoveryOperation(context.Context, string, string) (BotRecoveryOperation, error)
	BotRecoveryTokenUsed(context.Context, string, string) (bool, error)
	SaveBotRecoveryOperation(context.Context, string, BotRecoveryOperation) error
}
