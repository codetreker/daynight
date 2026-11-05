package sessionrelay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/jackc/pgx/v5"
)

// BotDeletionReceipt attests cleanup of the bound Worker's private execution
// data. The Worker owns process-stop verification; the relay checks its exact
// execution identity and persists the receipt before removing that identity.
type BotDeletionReceipt struct {
	DeletionID string                 `json:"deletionId"`
	Stop       *sp.TestStop           `json:"stop"`
	Result     model.BotCleanupResult `json:"result"`
}

func (s *Service) deletionBot(ctx context.Context, tx pgx.Tx, p model.Principal, id string) (model.Bot, error) {
	if err := credential(ctx, tx, p, s.now()); err != nil {
		return model.Bot{}, err
	}
	bot, err := store.ReadBotForUpdate(ctx, tx, id)
	if err != nil {
		return bot, botMissing(err)
	}
	if bot.OwnerUserID != p.UserID {
		return bot, denied()
	}
	return bot, nil
}

func writeBotDeletion(ctx context.Context, tx pgx.Tx, bot model.Bot) (model.Bot, error) {
	if bot.Version == math.MaxInt64 {
		return model.Bot{}, fault("version_exhausted", "Bot version cannot advance.")
	}
	_, err := tx.Exec(ctx, `UPDATE bots SET deletion=$2,version=version+1,updated_at=statement_timestamp() WHERE id=$1`, bot.ID, encode(bot.Deletion))
	if err != nil {
		return model.Bot{}, err
	}
	return store.ReadBotForUpdate(ctx, tx, bot.ID)
}

// DeleteBot commits admission revocation independently of physical cleanup.
// A retry uses the original version/deletion ID, even after stages advance.
func (s *Service) DeleteBot(ctx context.Context, p model.Principal, id string, input service.DeleteBot) (model.Bot, error) {
	var out model.Bot
	if !botID(id) || !botID(input.DeletionID) || input.Version < 1 {
		return out, fault("invalid_input", "Invalid Bot deletion identity or version.")
	}
	var sessions []string
	err := s.transact(ctx, func(tx pgx.Tx) error {
		bot, err := s.deletionBot(ctx, tx, p, id)
		if err != nil {
			return err
		}
		if bot.Deletion != nil {
			if bot.Deletion.DeletionID != input.DeletionID || bot.Deletion.RequestedVersion != input.Version {
				return fault("resource_conflict", "Bot deletion belongs to a different request.")
			}
			out = bot
			return credential(ctx, tx, p, s.now())
		}
		if err = botVersion(bot, input.Version); err != nil {
			return err
		}
		// Registration and uploads hold the Bot lock before a Session lock. Once
		// this statement runs, every previously admitted upload has finished.
		rows, err := tx.Query(ctx, `SELECT id::text FROM task_sessions WHERE bot_id=$1 ORDER BY id FOR UPDATE`, id)
		if err != nil {
			return err
		}
		for rows.Next() {
			var sid string
			if err = rows.Scan(&sid); err != nil {
				rows.Close()
				return err
			}
			sessions = append(sessions, sid)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE task_sessions SET grant_hash=NULL,grant_expires_at=NULL,connection_expires_at=NULL WHERE bot_id=$1`, id)
		if err != nil {
			return err
		}
		bot.Deletion = &model.BotDeletion{DeletionID: input.DeletionID, RequestedVersion: input.Version, WorkerCleanup: model.BotCleanupResult{State: "pending"}, ServerCleanup: model.BotCleanupResult{State: "pending"}}
		out, err = writeBotDeletion(ctx, tx, bot)
		if err != nil {
			return err
		}
		// Row-lock waits can outlive the credential without a revocation write.
		return credential(ctx, tx, p, s.now())
	})
	if err != nil {
		return model.Bot{}, err
	}
	for _, sid := range sessions {
		s.discardBotSession(sid)
	}
	if out.Deletion.WorkerCleanup.State == "completed" && out.Deletion.ServerCleanup.State != "completed" {
		return s.cleanBotDeletion(ctx, p, id, input.DeletionID)
	}
	return out, nil
}

func validCleanupResult(result model.BotCleanupResult) bool {
	return result.State == "completed" && result.Code == nil || result.State == "failed" && result.Code != nil && botText(*result.Code)
}

func (s *Service) CompleteBotDeletion(ctx context.Context, p model.Principal, workerID, id string, input BotDeletionReceipt) (model.Bot, error) {
	var out model.Bot
	if !botID(workerID) || !botID(id) || !botID(input.DeletionID) || !validCleanupResult(input.Result) {
		return out, fault("invalid_input", "Invalid Bot deletion receipt.")
	}
	if p.Kind != model.PATCredential {
		return out, denied()
	}
	if input.Stop != nil {
		if _, err := sp.DecodeTestStop(encode(input.Stop)); err != nil {
			return out, fault("invalid_input", "Invalid Bot execution stop proof.")
		}
	}
	sum := sha256.Sum256(encode(input))
	digest := hex.EncodeToString(sum[:])
	err := s.transact(ctx, func(tx pgx.Tx) error {
		bot, err := s.deletionBot(ctx, tx, p, id)
		if err != nil {
			return err
		}
		if bot.WorkerID != workerID {
			return denied()
		}
		if bot.Deletion == nil || bot.Deletion.DeletionID != input.DeletionID {
			return conflict()
		}
		if bot.Deletion.WorkerCleanup.State == "completed" {
			if bot.Deletion.ReceiptDigest != digest {
				return conflict()
			}
			out = bot
			return nil
		}
		if input.Result.State == "failed" && jsonEqual(encode(input.Result), encode(bot.Deletion.WorkerCleanup)) {
			out = bot
			return nil
		}
		if input.Result.State == "completed" {
			if bot.SessionID == nil {
				if input.Stop != nil {
					return conflict()
				}
			} else {
				if input.Stop == nil {
					return conflict()
				}
				var raw []byte
				var consumed bool
				var source *string
				err = tx.QueryRow(ctx, `SELECT snapshot,grant_consumed,source_epoch::text FROM task_sessions WHERE id=$1 AND bot_id=$2 AND owner_user_id=$3 AND scope='test' AND backend='web' FOR UPDATE`, *bot.SessionID, id, p.UserID).Scan(&raw, &consumed, &source)
				if err != nil {
					return err
				}
				var v sp.Snapshot
				if err = json.Unmarshal(raw, &v); err != nil {
					return err
				}
				stop := input.Stop
				if stop.Fence != v.Fence || stop.ControllerID != v.Identity.ControllerID || stop.ControllerInstanceID != v.Identity.ControllerInstanceID || stop.StopProof.PreviousControllerInstanceID != v.Identity.ControllerInstanceID {
					return conflict()
				}
				stopped, err := time.Parse(time.RFC3339Nano, stop.StopProof.StoppedAt)
				if err != nil || stopped.After(s.now().Add(time.Second)) {
					return conflict()
				}
				if stop.StopProof.Kind == "never_started" && (consumed || v.ConnectionEpoch != "0" || source != nil || v.Identity.NativeSessionID != nil) {
					return conflict()
				}
			}
			bot.Deletion.ReceiptDigest = digest
		}
		bot.Deletion.WorkerCleanup = input.Result
		out, err = writeBotDeletion(ctx, tx, bot)
		return err
	})
	if err != nil {
		return model.Bot{}, err
	}
	if out.Deletion.WorkerCleanup.State != "completed" || out.Deletion.ServerCleanup.State == "completed" {
		return out, nil
	}
	return s.cleanBotDeletion(ctx, p, id, input.DeletionID)
}

// The list is explicit: archive and recording metadata have no foreign key,
// and the remaining Session children do not cascade on parent removal.
var botSessionChildren = []string{"session_events", "session_timeline", "session_operations", "session_resources", "session_archives", "session_recording_evidence"}

func (s *Service) cleanBotDeletion(ctx context.Context, p model.Principal, id, deletionID string) (model.Bot, error) {
	var out model.Bot
	var sessions []string
	cleanupFailed := false
	err := s.transact(ctx, func(tx pgx.Tx) error {
		bot, err := s.deletionBot(ctx, tx, p, id)
		if err != nil {
			return err
		}
		if bot.Deletion == nil || bot.Deletion.DeletionID != deletionID || bot.Deletion.WorkerCleanup.State != "completed" {
			return conflict()
		}
		if bot.Deletion.ServerCleanup.State == "completed" {
			out = bot
			return nil
		}
		rows, err := tx.Query(ctx, `SELECT id::text,owner_user_id::text,scope,backend FROM task_sessions WHERE bot_id=$1 ORDER BY id FOR UPDATE`, id)
		if err != nil {
			cleanupFailed = true
			return err
		}
		for rows.Next() {
			var sid, owner, scope, backend string
			if err = rows.Scan(&sid, &owner, &scope, &backend); err != nil {
				rows.Close()
				cleanupFailed = true
				return err
			}
			if owner != bot.OwnerUserID || scope != "test" || backend != "web" {
				rows.Close()
				cleanupFailed = true
				return conflict()
			}
			sessions = append(sessions, sid)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			cleanupFailed = true
			return err
		}
		for _, sid := range sessions {
			if s.files == nil {
				cleanupFailed = true
				return fault("controller_offline", "Archive file storage is unavailable.")
			}
			namespace, err := archiveNamespace("", bot.OwnerUserID, sid)
			if err != nil {
				cleanupFailed = true
				return err
			}
			if err = s.files.DeleteSessionArchives(ctx, namespace); err != nil {
				cleanupFailed = true
				return err
			}
			for _, table := range botSessionChildren {
				if _, err = tx.Exec(ctx, `DELETE FROM `+table+` WHERE session_id=$1`, sid); err != nil {
					cleanupFailed = true
					return err
				}
			}
			if _, err = tx.Exec(ctx, `DELETE FROM task_sessions WHERE id=$1 AND bot_id=$2`, sid, id); err != nil {
				cleanupFailed = true
				return err
			}
		}
		// Keep only deletion responsibility and immutable request/owner identity.
		if _, err = tx.Exec(ctx, `UPDATE bots SET session_id=NULL,role_configuration=NULL,name='Deleted',requested_overrides='{}',resolved_configuration='{}',startup_result='{"state":"failed","code":"deleted"}' WHERE id=$1`, id); err != nil {
			cleanupFailed = true
			return err
		}
		bot.Deletion.ServerCleanup = model.BotCleanupResult{State: "completed"}
		out, err = writeBotDeletion(ctx, tx, bot)
		return err
	})
	if err == nil {
		for _, sid := range sessions {
			s.discardBotSession(sid)
		}
		return out, nil
	}
	if !cleanupFailed {
		return model.Bot{}, err
	}
	// The admission barrier and Worker receipt are already committed. Persist
	// failure separately; never downgrade a concurrent successful retry.
	failure := s.transact(ctx, func(tx pgx.Tx) error {
		bot, e := s.deletionBot(ctx, tx, p, id)
		if e != nil {
			return e
		}
		if bot.Deletion == nil || bot.Deletion.DeletionID != deletionID {
			return conflict()
		}
		if bot.Deletion.ServerCleanup.State == "completed" {
			out = bot
			return nil
		}
		code := "server_cleanup_failed"
		bot.Deletion.ServerCleanup = model.BotCleanupResult{State: "failed", Code: &code}
		out, e = writeBotDeletion(ctx, tx, bot)
		return e
	})
	if failure != nil {
		return model.Bot{}, failure
	}
	return out, nil
}
