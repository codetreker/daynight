package session

import (
	"context"
	"strings"
	"unicode/utf8"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type BotRegistration struct {
	BotVersion        int64                      `json:"botVersion,string"`
	Registration      sp.TestRegistration        `json:"registration"`
	Configuration     model.BotConfiguration     `json:"configuration"`
	RoleConfiguration model.BotRoleConfiguration `json:"roleConfiguration"`
}
type BotRegistrationResult struct {
	Bot     model.Bot
	Session sp.Snapshot
}
type BotGrant struct {
	BotVersion      int64    `json:"botVersion,string"`
	Grant           sp.Grant `json:"grant"`
	NativeSessionID *string  `json:"nativeSessionId"`
}
type BotReport struct {
	BotVersion           int64                  `json:"botVersion,string"`
	Fence                *sp.ControllerFence    `json:"fence"`
	ControllerID         string                 `json:"controllerId"`
	ControllerInstanceID string                 `json:"controllerInstanceId"`
	NativeSessionID      *string                `json:"nativeSessionId"`
	Result               model.BotStartupResult `json:"result"`
}

func botID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id.String() == value
}
func botText(value string) bool {
	return utf8.ValidString(value) && strings.TrimSpace(value) != "" && !strings.ContainsRune(value, 0)
}
func botVersion(bot model.Bot, version int64) error {
	if version != bot.Version {
		return fault("version_conflict", "Bot version has changed.")
	}
	return nil
}
func validSessionBot(bot *model.Bot, r *record) bool {
	if bot == nil {
		return r.BotID == nil
	}
	return r.BotID != nil && *r.BotID == bot.ID && bot.SessionID != nil && *bot.SessionID == r.Snapshot.SessionID && bot.TestExecutionID != nil && *bot.TestExecutionID == r.Snapshot.TestExecutionID && r.Owner == bot.OwnerUserID && r.Snapshot.Identity.OwnerUserID == bot.OwnerUserID && r.Snapshot.Identity.Provider == bot.ResolvedConfiguration.Provider
}

func (s *Execution) RegisterBot(ctx context.Context, p model.Principal, workerID, id string, input BotRegistration) (BotRegistrationResult, error) {
	var out BotRegistrationResult
	role := input.RoleConfiguration
	if !botID(workerID) || !botID(id) || input.BotVersion < 1 || !botcore.ValidBindingInput(input.Configuration, role) {
		return out, fault("invalid_input", "Invalid Bot registration or frozen role.")
	}
	if _, err := sp.DecodeTestRegistration(encode(input.Registration)); err != nil || input.Registration.InitialInput != "none" {
		return out, fault("invalid_input", "Bot registration requires an independent Session with no initial input.")
	}
	err := s.botRun(ctx, p, workerID, id, func(bot model.Bot) error {
		if !botcore.BindingConfigurationMatches(bot, input.Configuration, input.Registration.Provider) {
			return conflict()
		}
		if bot.SessionID == nil {
			return botcore.PrepareBinding(bot, input.BotVersion)
		}
		return nil
	}, func(bot model.Bot, access *Access) error {
		if !jsonEqual(access.record.Registration, encode(input)) || !botcore.BindingRoleMatches(bot, role) {
			return conflict()
		}
		return nil
	}, func(op *Operation, scope store.SessionScope, bot model.Bot, access *Access, recheck func(model.Principal) error) error {
		_, tx := op.scoped(scope)
		if access != nil {
			out = BotRegistrationResult{Bot: bot, Session: permissions(access.record, true, s.now())}
			return nil
		}
		v := initialTestSnapshot(p, input.Registration)
		// The unique registration/execution indexes also fence collisions with
		// ordinary Test Sessions and concurrent registrations of different Bots.
		inserted, err := tx.dao.InsertBotSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: v.SessionID}, TestExecutionID: v.TestExecutionID, OwnerID: p.UserID, RegistrationID: input.Registration.RegistrationID, Registration: encode(input), Snapshot: durableSnapshot(v), ParentCredentialID: p.CredentialID, BotID: &id})
		if err != nil {
			return err
		}
		if !inserted {
			return conflict()
		}
		bot, err = tx.bot.BindBotSession(ctx, id, bot.Version, v.SessionID, role)
		if err != nil {
			return err
		}
		// Credential share locks prevent revocation, but not expiry while waiting.
		if err = recheck(p); err != nil {
			return err
		}
		out = BotRegistrationResult{Bot: bot, Session: v}
		return nil
	})
	return out, err
}

func initialTestSnapshot(p model.Principal, input sp.TestRegistration) sp.Snapshot {
	initial := "not_submitted"
	if input.InitialInput == "none" {
		initial = "not_required"
	}
	return sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: uuid.NewString(), TestExecutionID: input.TestExecutionID, ExecutionGeneration: "1"}, ConnectionEpoch: "0"}, Protocol: sp.Protocol, SchemaVersion: 1, ProjectionVersion: 1, Identity: sp.Identity{OwnerUserID: p.UserID, ControllerID: input.ControllerID, ControllerInstanceID: input.ControllerInstanceID, AgentControlMode: "web", Provider: input.Provider}, SessionRevision: "1", HistoryEpoch: uuid.NewString(), LastEventSeq: "0", LastTimelineSeq: "0", InitialInputState: initial, Lifecycle: "active", ConnectionState: "disconnected", Activity: "initializing"}
}

func equalNative(a, b *string) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}
func (s *Execution) GrantBot(ctx context.Context, p model.Principal, workerID, id string, input BotGrant) (GrantResult, error) {
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
	err := s.botRun(ctx, p, workerID, id, func(bot model.Bot) error {
		if err := botVersion(bot, input.BotVersion); err != nil {
			return err
		}
		if bot.SessionID == nil {
			return conflict()
		}
		return nil
	}, nil, func(op *Operation, scope store.SessionScope, _ model.Bot, access *Access, _ func(model.Principal) error) error {
		_, tx := op.scoped(scope)
		r := access.record
		var err error
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

func (s *Execution) ReportBot(ctx context.Context, p model.Principal, workerID, id string, input BotReport) (model.Bot, error) {
	var out model.Bot
	if !botID(workerID) || !botID(id) || input.BotVersion < 1 || !botcore.ValidStartupResult(input.Result) {
		return out, fault("invalid_input", "Invalid Bot startup report.")
	}
	if input.NativeSessionID != nil && !botText(*input.NativeSessionID) {
		return out, fault("invalid_input", "Invalid native Session identity.")
	}
	err := s.botRun(ctx, p, workerID, id, func(bot model.Bot) error { return botVersion(bot, input.BotVersion) }, nil, func(op *Operation, scope store.SessionScope, bot model.Bot, access *Access, recheck func(model.Principal) error) error {
		_, tx := op.scoped(scope)
		if access == nil {
			if input.Result.State != "failed" || input.Fence != nil || input.ControllerID != "" || input.ControllerInstanceID != "" || input.NativeSessionID != nil {
				return conflict()
			}
		} else {
			r := access.record
			var err error
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
				// A replacement grant does not transfer the existing connection's
				// synchronization proof to its new parent credential.
				if err = recheck(model.Principal{Kind: model.PATCredential, UserID: r.Owner, CredentialID: r.ConnectionParent}); err != nil {
					return err
				}
			}
		}
		writeStartup, err := botcore.PrepareStartup(bot, input.Result)
		if err != nil {
			return err
		}
		if !writeStartup {
			if bot.SessionID == nil {
				if err = recheck(p); err != nil {
					return err
				}
			}
			out = bot
			return nil
		}
		out, err = tx.bot.SetBotStartup(ctx, id, bot.Version, input.Result)
		if err != nil {
			return err
		}
		if input.Result.State == "ready" {
			return tx.bot.CommitBotPreferences(ctx, id)
		}
		if bot.SessionID == nil {
			return recheck(p)
		}
		return nil
	})
	return out, err
}
