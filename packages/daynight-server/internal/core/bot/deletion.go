package bot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func deletionConflict() error {
	return &model.Fault{Code: "session_conflict", Message: "Session identity or state no longer matches."}
}

// PrepareDeletion checks an initial request or identifies an exact replay.
func PrepareDeletion(bot model.Bot, input store.DeleteBot) (bool, error) {
	if bot.Deletion != nil {
		if bot.Deletion.DeletionID != input.DeletionID || bot.Deletion.RequestedVersion != input.Version {
			return false, botConflict("Bot deletion belongs to a different request.")
		}
		return false, nil
	}
	if bot.Version != input.Version {
		return false, &model.Fault{Code: "version_conflict", Message: "Bot version has changed."}
	}
	return true, nil
}

func NewDeletion(input store.DeleteBot) *model.BotDeletion {
	return &model.BotDeletion{DeletionID: input.DeletionID, RequestedVersion: input.Version, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
}

func deletionVersion(bot model.Bot) error {
	if bot.Version == math.MaxInt64 {
		return &model.Fault{Code: "version_exhausted", Message: "Bot version cannot advance."}
	}
	return nil
}

// SaveDeletion persists a transition after the caller has acquired its locks.
func SaveDeletion(ctx context.Context, dao store.BotWriteDAO, bot model.Bot) (model.Bot, error) {
	if err := deletionVersion(bot); err != nil {
		return model.Bot{}, err
	}
	return dao.SaveBotDeletion(ctx, bot.ID, bot.Deletion)
}

func ValidCleanupResult(result model.BotCleanupResult) bool {
	return result.State == "completed" && result.Code == nil || result.State == "failed" && result.Code != nil && utf8.ValidString(*result.Code) && strings.TrimSpace(*result.Code) != "" && !strings.ContainsRune(*result.Code, 0)
}

// ReceiptDigest preserves the digest of the complete encoded receipt, including stop proof.
func ReceiptDigest(encoded []byte) string {
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

// PrepareWorkerCleanup checks receipt identity and replay before Session proof is consulted.
// A changed completed result requires the service to verify the Session stop proof.
func PrepareWorkerCleanup(bot model.Bot, workerID, deletionID string, result model.BotCleanupResult, digest string) (change, needsStopProof bool, err error) {
	if bot.WorkerID != workerID {
		return false, false, &model.Fault{Code: "forbidden", Message: "Session access is not available."}
	}
	if bot.Deletion == nil || bot.Deletion.DeletionID != deletionID {
		return false, false, deletionConflict()
	}
	if bot.Deletion.WorkerCleanup.State == "completed" {
		if bot.Deletion.ReceiptDigest != digest {
			return false, false, deletionConflict()
		}
		return false, false, nil
	}
	if result.State == "failed" && sameJSON(result, bot.Deletion.WorkerCleanup) {
		return false, false, nil
	}
	return true, result.State == "completed", nil
}

// ApplyWorkerCleanup records a receipt after any required Session proof succeeds.
func ApplyWorkerCleanup(bot *model.Bot, result model.BotCleanupResult, digest string) {
	if result.State == "completed" {
		bot.Deletion.ReceiptDigest = digest
	}
	bot.Deletion.WorkerCleanup = result
}

func NeedsServerCleanup(bot model.Bot) bool {
	return bot.Deletion.WorkerCleanup.State == "completed" && bot.Deletion.ServerCleanup.State != "completed"
}

func PrepareServerCleanup(bot model.Bot, deletionID string) (bool, error) {
	if bot.Deletion == nil || bot.Deletion.DeletionID != deletionID || bot.Deletion.WorkerCleanup.State != "completed" {
		return false, deletionConflict()
	}
	return bot.Deletion.ServerCleanup.State != "completed", nil
}

func CompleteServerCleanup(bot *model.Bot) {
	bot.Deletion.ServerCleanup = model.BotCleanupResult{State: "completed"}
}

// FailServerCleanup never overwrites a successful concurrent retry.
func FailServerCleanup(bot *model.Bot, deletionID string) (bool, error) {
	if bot.Deletion == nil || bot.Deletion.DeletionID != deletionID {
		return false, deletionConflict()
	}
	if bot.Deletion.ServerCleanup.State == "completed" {
		return false, nil
	}
	code := "server_cleanup_failed"
	bot.Deletion.ServerCleanup = model.BotCleanupResult{State: "failed", Code: &code}
	return true, nil
}
