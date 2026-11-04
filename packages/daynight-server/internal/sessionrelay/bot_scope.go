package sessionrelay

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/sessionprotocol"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type BotRegistration struct {
	BotVersion        int64                     `json:"botVersion,string"`
	Registration      sp.TestRegistration       `json:"registration"`
	Configuration     core.BotConfiguration     `json:"configuration"`
	RoleConfiguration core.BotRoleConfiguration `json:"roleConfiguration"`
}
type BotRegistrationResult struct {
	Bot     core.Bot
	Session sp.Snapshot
}
type BotGrant struct {
	BotVersion      int64    `json:"botVersion,string"`
	Grant           sp.Grant `json:"grant"`
	NativeSessionID *string  `json:"nativeSessionId"`
}
type BotReport struct {
	BotVersion           int64                 `json:"botVersion,string"`
	Fence                *sp.ControllerFence   `json:"fence"`
	ControllerID         string                `json:"controllerId"`
	ControllerInstanceID string                `json:"controllerInstanceId"`
	NativeSessionID      *string               `json:"nativeSessionId"`
	Result               core.BotStartupResult `json:"result"`
}

func botID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id.String() == value
}
func botText(value string) bool {
	return utf8.ValidString(value) && strings.TrimSpace(value) != "" && !strings.ContainsRune(value, 0)
}
func validBotConfiguration(value core.BotConfiguration) bool {
	if !botID(value.WorkerID) || !botText(value.Cwd) || !core.WorkerAgent(value.Provider).Valid() || (value.Model != nil && !botText(*value.Model)) {
		return false
	}
	for _, arg := range value.Args {
		if !utf8.ValidString(arg) || strings.ContainsRune(arg, 0) {
			return false
		}
	}
	return true
}
func botVersion(bot core.Bot, version int64) error {
	if version != bot.Version {
		return fault("version_conflict", "Bot version has changed.")
	}
	return nil
}
func botMissing(err error) error {
	if errors.Is(err, core.ErrNotFound) {
		return fault("not_found", "Bot was not found.")
	}
	return err
}
func (s *Service) runtimeBot(ctx context.Context, tx pgx.Tx, p core.Principal, workerID, botID string) (core.Bot, error) {
	if p.Kind != core.PATCredential {
		return core.Bot{}, denied()
	}
	if err := credential(ctx, tx, p, s.now()); err != nil {
		return core.Bot{}, err
	}
	bot, err := store.ReadBotForUpdate(ctx, tx, botID)
	if err != nil {
		return bot, botMissing(err)
	}
	if bot.OwnerUserID != p.UserID || bot.WorkerID != workerID {
		return bot, denied()
	}
	if bot.Deletion != nil {
		return bot, fault("resource_conflict", "Bot is deleted.")
	}
	return bot, nil
}

// A Session's Bot association is immutable. Read that association without a
// Session lock, then acquire Bot before Session; deletion uses the same order.
func lockSessionBot(ctx context.Context, tx pgx.Tx, id string) (*core.Bot, error) {
	var botID *string
	if err := tx.QueryRow(ctx, `SELECT bot_id::text FROM task_sessions WHERE id=$1 AND backend='web'`, id).Scan(&botID); err != nil {
		return nil, err
	}
	if botID == nil {
		return nil, nil
	}
	bot, err := store.ReadBotForUpdate(ctx, tx, *botID)
	if err != nil {
		return nil, botMissing(err)
	}
	if bot.Deletion != nil {
		return nil, fault("resource_conflict", "Bot is deleted.")
	}
	if bot.SessionID == nil || *bot.SessionID != id {
		return nil, conflict()
	}
	return &bot, nil
}
func validSessionBot(bot *core.Bot, r *record) bool {
	if bot == nil {
		return r.BotID == nil
	}
	return r.BotID != nil && *r.BotID == bot.ID && bot.SessionID != nil && *bot.SessionID == r.Snapshot.SessionID && bot.TestExecutionID != nil && *bot.TestExecutionID == r.Snapshot.TestExecutionID && r.Owner == bot.OwnerUserID && r.Snapshot.Identity.OwnerUserID == bot.OwnerUserID && r.Snapshot.Identity.Provider == bot.ResolvedConfiguration.Provider
}

func (s *Service) RegisterBot(ctx context.Context, p core.Principal, workerID, id string, input BotRegistration) (BotRegistrationResult, error) {
	var out BotRegistrationResult
	role := input.RoleConfiguration
	sum := sha256.Sum256([]byte(role.Instructions))
	if !botID(workerID) || !botID(id) || input.BotVersion < 1 || !validBotConfiguration(input.Configuration) || !botText(role.Instructions) || len(role.Instructions) > 65536 || !botText(role.Revision) || role.Digest != hex.EncodeToString(sum[:]) {
		return out, fault("invalid_input", "Invalid Bot registration or frozen role.")
	}
	if _, err := sp.DecodeTestRegistration(encode(input.Registration)); err != nil || input.Registration.InitialInput != "none" {
		return out, fault("invalid_input", "Bot registration requires an independent Session with no initial input.")
	}
	err := s.transact(ctx, func(tx pgx.Tx) error {
		bot, err := s.runtimeBot(ctx, tx, p, workerID, id)
		if err != nil {
			return err
		}
		if !jsonEqual(encode(bot.ResolvedConfiguration), encode(input.Configuration)) || input.Registration.Provider != bot.ResolvedConfiguration.Provider {
			return conflict()
		}
		if bot.SessionID != nil {
			r, err := load(ctx, tx, *bot.SessionID)
			if err != nil {
				return err
			}
			if !jsonEqual(r.Registration, encode(input)) || bot.RoleConfiguration == nil || *bot.RoleConfiguration != role {
				return conflict()
			}
			if _, err = s.scopePermission(ctx, tx, p, r); err != nil {
				return err
			}
			out = BotRegistrationResult{Bot: bot, Session: permissions(r, true, s.now())}
			return nil
		}
		if err = botVersion(bot, input.BotVersion); err != nil {
			return err
		}
		if bot.Version == math.MaxInt64 {
			return fault("version_exhausted", "Bot version cannot advance.")
		}
		if bot.RoleConfiguration != nil {
			return conflict()
		}
		v := initialTestSnapshot(p, input.Registration)
		// The unique registration/execution indexes also fence collisions with
		// ordinary Test Sessions and concurrent registrations of different Bots.
		tag, err := tx.Exec(ctx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot,parent_credential_id,bot_id) VALUES($1,'test',$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, v.SessionID, v.TestExecutionID, p.UserID, input.Registration.RegistrationID, encode(input), encode(durableSnapshot(v)), p.CredentialID, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return conflict()
		}
		bot, err = store.BindBotSession(ctx, tx, id, bot.Version, v.SessionID, role)
		if err != nil {
			return err
		}
		out = BotRegistrationResult{Bot: bot, Session: v}
		return nil
	})
	return out, err
}

func initialTestSnapshot(p core.Principal, input sp.TestRegistration) sp.Snapshot {
	initial := "not_submitted"
	if input.InitialInput == "none" {
		initial = "not_required"
	}
	return sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), TestExecutionID: input.TestExecutionID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{OwnerUserID: p.UserID, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, AgentControlMode: "web", Provider: input.Provider}, SessionRevision: "1", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: initial, Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}
}

func equalNative(a, b *string) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}
func (s *Service) GrantBot(ctx context.Context, p core.Principal, workerID, id string, input BotGrant) (GrantResult, error) {
	var out GrantResult
	if !botID(workerID) || !botID(id) || input.BotVersion < 1 {
		return out, fault("invalid_input", "Invalid Bot grant identity or version.")
	}
	if _, err := sp.DecodeBotGrant(encode(input.Grant)); err != nil {
		return out, fault("invalid_input", "Invalid Bot controller grant.")
	}
	if input.NativeSessionID != nil && !botText(*input.NativeSessionID) {
		return out, fault("invalid_input", "Invalid native Session identity.")
	}
	err := s.transact(ctx, func(tx pgx.Tx) error {
		bot, err := s.runtimeBot(ctx, tx, p, workerID, id)
		if err != nil {
			return err
		}
		if err = botVersion(bot, input.BotVersion); err != nil {
			return err
		}
		if bot.SessionID == nil {
			return conflict()
		}
		r, err := load(ctx, tx, *bot.SessionID)
		if err != nil {
			return err
		}
		if _, err = s.scopePermission(ctx, tx, p, r); err != nil {
			return err
		}
		if !equalNative(input.NativeSessionID, r.Snapshot.Identity.NativeSessionID) {
			return conflict()
		}
		if input.Grant.PreviousGeneration != nil && (input.NativeSessionID == nil || input.Grant.StopProof == nil || input.Grant.StopProof.Kind != "") {
			return conflict()
		}
		out, err = s.grantRecord(ctx, tx, p, r, task{}, input.Grant)
		return err
	})
	return out, err
}

func (s *Service) ReportBot(ctx context.Context, p core.Principal, workerID, id string, input BotReport) (core.Bot, error) {
	var out core.Bot
	if !botID(workerID) || !botID(id) || input.BotVersion < 1 || (input.Result.State != "ready" && input.Result.State != "failed") || (input.Result.State == "ready" && input.Result.Code != nil) || (input.Result.State == "failed" && (input.Result.Code == nil || !botText(*input.Result.Code))) {
		return out, fault("invalid_input", "Invalid Bot startup report.")
	}
	if input.NativeSessionID != nil && !botText(*input.NativeSessionID) {
		return out, fault("invalid_input", "Invalid native Session identity.")
	}
	err := s.transact(ctx, func(tx pgx.Tx) error {
		bot, err := s.runtimeBot(ctx, tx, p, workerID, id)
		if err != nil {
			return err
		}
		if err = botVersion(bot, input.BotVersion); err != nil {
			return err
		}
		if bot.SessionID == nil {
			if input.Result.State != "failed" || input.Fence != nil || input.ControllerID != "" || input.ControllerInstanceID != "" || input.NativeSessionID != nil {
				return conflict()
			}
		} else {
			r, err := load(ctx, tx, *bot.SessionID)
			if err != nil {
				return err
			}
			if _, err = s.scopePermission(ctx, tx, p, r); err != nil {
				return err
			}
			v := r.Snapshot
			if input.Fence == nil || *input.Fence != v.ControllerFence || input.ControllerID != v.Identity.ControllerID || input.ControllerInstanceID != v.Identity.ControllerInstanceID || !equalNative(input.NativeSessionID, v.Identity.NativeSessionID) {
				return conflict()
			}
			if input.Result.State == "ready" {
				if !active(task{}, r) || !controlActivity(v.Activity) {
					return conflict()
				}
				if err = onlineContent(r, s.now()); err != nil {
					return err
				}
			}
		}
		if jsonEqual(encode(input.Result), encode(bot.StartupResult)) {
			out = bot
			return nil
		}
		if bot.Version == math.MaxInt64 {
			return fault("version_exhausted", "Bot version cannot advance.")
		}
		out, err = store.SetBotStartup(ctx, tx, id, bot.Version, input.Result)
		if err != nil {
			return err
		}
		if input.Result.State == "ready" {
			return store.CommitBotPreferences(ctx, tx, id)
		}
		return nil
	})
	return out, err
}
