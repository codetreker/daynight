package bot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// BotDeletionReceipt attests cleanup of the bound Worker's private execution data.
type BotDeletionReceipt struct {
	DeletionID string                 `json:"deletionId"`
	Stop       *sp.TestStop           `json:"stop"`
	Result     model.BotCleanupResult `json:"result"`
}

// DeletionCleanupError reports that the deletion barrier committed, but a
// subsequent cleanup operation failed. The cause retains its own transaction facts.
type DeletionCleanupError struct{ Cause error }

func (e *DeletionCleanupError) Error() string { return "bot deletion cleanup: " + e.Cause.Error() }
func (e *DeletionCleanupError) Unwrap() error { return e.Cause }

type liveSessions interface{ DiscardBotSession(string) }

type Deletions struct {
	writer store.SessionWriter
	files  filestorage.Storage
	live   liveSessions
	now    func() time.Time
}

func NewDeletions(writer store.SessionWriter, files filestorage.Storage, live liveSessions) *Deletions {
	return &Deletions{writer: writer, files: files, live: live, now: time.Now}
}

func deletionFault(code, message string) error { return &model.Fault{Code: code, Message: message} }
func deletionConflict() error {
	return deletionFault("session_conflict", "Session identity or state no longer matches.")
}
func deletionResultError(err error) error {
	if err == nil {
		return nil
	}
	var transaction *store.TransactionError
	if errors.Is(err, model.ErrNotFound) && errors.As(err, &transaction) && transaction.Phase == "operation" && !transaction.CleanupFailed && transaction.Outcome == store.TransactionNotCommitted {
		return deletionFault("not_found", "Session was not found.")
	}
	return err
}
func deletionDenied() error { return deletionFault("forbidden", "Session access is not available.") }
func deletionID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id.String() == value
}
func deletionJSON(value any) []byte  { data, _ := json.Marshal(value); return data }
func sameDeletionJSON(a, b any) bool { return string(deletionJSON(a)) == string(deletionJSON(b)) }

func (s *Deletions) credential(ctx context.Context, dao store.SessionDAO, p model.Principal) error {
	if p.Kind != model.PATCredential && p.Kind != model.SessionCredential && p.Kind != model.OAuthCredential {
		return deletionDenied()
	}
	if err := dao.LockCredential(ctx, p, s.now()); err != nil {
		if errors.Is(err, model.ErrNotFound) {
			return deletionFault("unauthenticated", "Credential expired or was revoked.")
		}
		return err
	}
	return nil
}
func (s *Deletions) lockBot(ctx context.Context, scope store.SessionScope, p model.Principal, id string) (model.Bot, error) {
	if err := s.credential(ctx, scope.SessionDAO(), p); err != nil {
		return model.Bot{}, err
	}
	bot, err := scope.BotDAO().Bot(ctx, id)
	if errors.Is(err, model.ErrNotFound) {
		return bot, deletionFault("not_found", "Bot was not found.")
	}
	if err != nil {
		return bot, err
	}
	if err := botcore.RequireDeletionOwner(bot, p); err != nil {
		return bot, err
	}
	return bot, nil
}
func saveDeletion(ctx context.Context, dao store.BotWriteDAO, bot model.Bot) (model.Bot, error) {
	if err := botcore.CheckDeletionVersion(bot); err != nil {
		return model.Bot{}, err
	}
	return dao.SaveBotDeletion(ctx, bot.ID, bot.Deletion)
}

// DeleteBot commits admission revocation before physical cleanup.
func (s *Deletions) DeleteBot(ctx context.Context, p model.Principal, id string, input store.DeleteBot) (model.Bot, error) {
	if !deletionID(id) || !deletionID(input.DeletionID) || input.Version < 1 {
		return model.Bot{}, deletionFault("invalid_input", "Invalid Bot deletion identity or version.")
	}
	var out model.Bot
	var sessions []store.BotSession
	completion, err := s.writer.WriteSession(ctx, func(scope store.SessionScope) error {
		bot, err := s.lockBot(ctx, scope, p, id)
		if err != nil {
			return err
		}
		replay, err := botcore.DeletionRequest(bot, input)
		if err != nil {
			return err
		}
		if replay {
			out = bot
			return s.credential(ctx, scope.SessionDAO(), p)
		}
		sessions, err = scope.SessionDAO().LockBotSessions(ctx, id)
		if err != nil {
			return err
		}
		if err = scope.SessionDAO().RevokeBotSessions(ctx, id); err != nil {
			return err
		}
		bot.Deletion = botcore.NewDeletion(input)
		out, err = saveDeletion(ctx, scope.BotDAO(), bot)
		if err != nil {
			return err
		}
		return s.credential(ctx, scope.SessionDAO(), p)
	})
	if completion.Outcome == store.TransactionCommitted {
		for _, session := range sessions {
			s.live.DiscardBotSession(session.ID)
		}
	}
	if err != nil {
		return model.Bot{}, deletionResultError(err)
	}
	if completion.Outcome != store.TransactionCommitted {
		return model.Bot{}, errors.New("Bot deletion commit was not confirmed")
	}
	if out.Deletion.WorkerCleanup.State == "completed" && out.Deletion.ServerCleanup.State != "completed" {
		cleaned, err := s.clean(ctx, p, id, input.DeletionID)
		if err != nil {
			return model.Bot{}, &DeletionCleanupError{Cause: err}
		}
		return cleaned, nil
	}
	return out, nil
}

func validCleanupResult(result model.BotCleanupResult) bool {
	return result.State == "completed" && result.Code == nil || result.State == "failed" && result.Code != nil && utf8.ValidString(*result.Code) && strings.TrimSpace(*result.Code) != "" && !strings.ContainsRune(*result.Code, 0)
}

func (s *Deletions) CompleteBotDeletion(ctx context.Context, p model.Principal, workerID, id string, input BotDeletionReceipt) (model.Bot, error) {
	if !deletionID(workerID) || !deletionID(id) || !deletionID(input.DeletionID) || !validCleanupResult(input.Result) {
		return model.Bot{}, deletionFault("invalid_input", "Invalid Bot deletion receipt.")
	}
	if p.Kind != model.PATCredential {
		return model.Bot{}, deletionDenied()
	}
	if input.Stop != nil {
		if _, err := sp.DecodeTestStop(deletionJSON(input.Stop)); err != nil {
			return model.Bot{}, deletionFault("invalid_input", "Invalid Bot execution stop proof.")
		}
	}
	sum := sha256.Sum256(deletionJSON(input))
	digest := hex.EncodeToString(sum[:])
	var out model.Bot
	completion, err := s.writer.WriteSession(ctx, func(scope store.SessionScope) error {
		bot, err := s.lockBot(ctx, scope, p, id)
		if err != nil {
			return err
		}
		if bot.WorkerID != workerID {
			return deletionDenied()
		}
		if bot.Deletion == nil || bot.Deletion.DeletionID != input.DeletionID {
			return deletionConflict()
		}
		if bot.Deletion.WorkerCleanup.State == "completed" {
			if bot.Deletion.ReceiptDigest != digest {
				return deletionConflict()
			}
			out = bot
			return nil
		}
		if input.Result.State == "failed" && sameDeletionJSON(input.Result, bot.Deletion.WorkerCleanup) {
			out = bot
			return nil
		}
		if input.Result.State == "completed" {
			if bot.SessionID == nil {
				if input.Stop != nil {
					return deletionConflict()
				}
			} else {
				if input.Stop == nil {
					return deletionConflict()
				}
				proof, err := scope.SessionDAO().LockBotSessionStop(ctx, *bot.SessionID, id, p.UserID)
				if err != nil {
					return err
				}
				v, stop := proof.Snapshot, input.Stop
				if stop.Fence != v.Fence || stop.ControllerID != v.Identity.ControllerID || stop.ControllerInstanceID != v.Identity.ControllerInstanceID || stop.StopProof.PreviousControllerInstanceID != v.Identity.ControllerInstanceID {
					return deletionConflict()
				}
				stopped, err := time.Parse(time.RFC3339Nano, stop.StopProof.StoppedAt)
				if err != nil || stopped.After(s.now().Add(time.Second)) {
					return deletionConflict()
				}
				if stop.StopProof.Kind == "never_started" && (proof.Consumed || v.ConnectionEpoch != "0" || proof.SourceEpoch != nil || v.Identity.NativeSessionID != nil) {
					return deletionConflict()
				}
			}
			bot.Deletion.ReceiptDigest = digest
		}
		bot.Deletion.WorkerCleanup = input.Result
		out, err = saveDeletion(ctx, scope.BotDAO(), bot)
		return err
	})
	if err != nil {
		return model.Bot{}, deletionResultError(err)
	}
	if completion.Outcome != store.TransactionCommitted {
		return model.Bot{}, errors.New("Bot receipt commit was not confirmed")
	}
	if out.Deletion.WorkerCleanup.State != "completed" || out.Deletion.ServerCleanup.State == "completed" {
		return out, nil
	}
	return s.clean(ctx, p, id, input.DeletionID)
}

func (s *Deletions) clean(ctx context.Context, p model.Principal, id, deletionID string) (model.Bot, error) {
	var out model.Bot
	var sessions []store.BotSession
	cleanupFailed := false
	completion, err := s.writer.WriteSession(ctx, func(scope store.SessionScope) error {
		bot, err := s.lockBot(ctx, scope, p, id)
		if err != nil {
			return err
		}
		if bot.Deletion == nil || bot.Deletion.DeletionID != deletionID || bot.Deletion.WorkerCleanup.State != "completed" {
			return deletionConflict()
		}
		if bot.Deletion.ServerCleanup.State == "completed" {
			out = bot
			return nil
		}
		sessions, err = scope.SessionDAO().LockBotSessions(ctx, id)
		if err != nil {
			cleanupFailed = true
			return err
		}
		for _, session := range sessions {
			if session.Owner != bot.OwnerUserID || session.Scope != "test" || session.Backend != "web" {
				cleanupFailed = true
				return deletionConflict()
			}
			if s.files == nil {
				cleanupFailed = true
				return deletionFault("controller_offline", "Archive file storage is unavailable.")
			}
			namespace, err := sessionarchive.NewNamespace(sessionarchive.Users, bot.OwnerUserID, session.ID)
			if err == nil {
				err = s.files.DeleteSessionArchives(ctx, namespace)
			}
			if err == nil {
				err = scope.SessionDAO().DeleteBotSession(ctx, session.ID, id)
			}
			if err != nil {
				cleanupFailed = true
				return err
			}
		}
		if err = scope.SessionDAO().RedactDeletedBot(ctx, id); err != nil {
			cleanupFailed = true
			return err
		}
		bot.Deletion.ServerCleanup = model.BotCleanupResult{State: "completed"}
		out, err = saveDeletion(ctx, scope.BotDAO(), bot)
		return err
	})
	if completion.Outcome == store.TransactionCommitted {
		for _, session := range sessions {
			s.live.DiscardBotSession(session.ID)
		}
	}
	if err == nil && completion.Outcome == store.TransactionCommitted {
		return out, nil
	}
	if err == nil {
		return model.Bot{}, errors.New("Bot cleanup commit was not confirmed")
	}
	if !cleanupFailed || completion.Outcome != store.TransactionNotCommitted {
		return model.Bot{}, err
	}
	// The barrier and Worker receipt are durable. Record failure separately without downgrading a successful retry.
	completion, failure := s.writer.WriteSession(ctx, func(scope store.SessionScope) error {
		bot, e := s.lockBot(ctx, scope, p, id)
		if e != nil {
			return e
		}
		if bot.Deletion == nil || bot.Deletion.DeletionID != deletionID {
			return deletionConflict()
		}
		if bot.Deletion.ServerCleanup.State == "completed" {
			out = bot
			return nil
		}
		code := "server_cleanup_failed"
		bot.Deletion.ServerCleanup = model.BotCleanupResult{State: "failed", Code: &code}
		out, e = saveDeletion(ctx, scope.BotDAO(), bot)
		return e
	})
	if failure != nil {
		return model.Bot{}, failure
	}
	if completion.Outcome != store.TransactionCommitted {
		return model.Bot{}, errors.New("Bot cleanup failure commit was not confirmed")
	}
	return out, nil
}
