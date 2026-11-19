package runtime

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// Recovery coordinates current account authority, Bot hosting and original
// Session authorization. It deliberately does not authenticate an old PAT.
type Recovery struct {
	engine *sessioncore.Engine
	write  sessioncore.TransactionRunner
}

func NewRecovery(engine *sessioncore.Engine, write sessioncore.TransactionRunner) *Recovery {
	return &Recovery{engine: engine, write: write}
}

func recoveryFault(code, message string) error { return &model.Fault{Code: code, Message: message} }
func recoveryID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id != uuid.Nil && id.String() == value
}

type recoveryWork func(*sessioncore.Operation, store.SessionScope, model.Bot, *sessioncore.Access, []byte) error

func (s *Recovery) run(ctx context.Context, p model.Principal, workerID, id string, identity sessioncore.BotRecoveryIdentity, registration bool, work recoveryWork) error {
	if p.Kind != model.PATCredential {
		return recoveryFault("forbidden", "Bot recovery requires current account authentication.")
	}
	if !recoveryID(workerID) || !recoveryID(id) {
		return recoveryFault("invalid_input", "Invalid Bot recovery target.")
	}
	hash, err := sessioncore.ValidateBotRecoveryIdentity(identity, s.engine.Origin)
	if err != nil {
		return err
	}
	op, err := s.engine.BeginOperation()
	if err != nil {
		return err
	}
	defer op.Close()
	err = s.write(ctx, op, func(scope store.SessionScope) error {
		if err := op.LockCredential(ctx, scope, p); err != nil {
			return err
		}
		bot, err := scope.BotDAO().Bot(ctx, id)
		if err != nil {
			return err
		}
		if registration && bot.Recovery == nil {
			if err = botcore.PrepareRecoveryRegistration(bot, p.UserID, workerID); err != nil {
				return err
			}
		} else if err = botcore.AuthorizeRecovery(bot, p.UserID, identity.ServiceOrigin, hash); err != nil {
			return err
		}
		if bot.SessionID == nil {
			return recoveryFault("resource_conflict", "Bot has no original Session.")
		}
		if err = op.CheckBot(*bot.SessionID, &bot); err != nil {
			return err
		}
		a, err := op.Load(ctx, scope, *bot.SessionID, &bot)
		if err != nil {
			return err
		}
		if err = op.CheckTestOwner(a, p); err != nil {
			return err
		}
		if err = work(op, scope, bot, a, hash); err != nil {
			return err
		}
		// Credential expiry can pass while waiting for the Bot or Session lock.
		return op.LockCredential(ctx, scope, p)
	})
	var transaction *store.TransactionError
	if errors.As(err, &transaction) && transaction.Outcome == store.TransactionUnknown {
		return &model.Fault{Code: "outcome_unknown", Message: "Bot recovery outcome is unknown; query the original operation.", Cause: err}
	}
	return err
}

func requestHash(workerID, kind string, input any) []byte {
	raw, _ := json.Marshal(struct {
		WorkerID string
		Kind     string
		Input    any
	}{workerID, kind, input})
	hash := sha256.Sum256(raw)
	return hash[:]
}

func recoverOperation(ctx context.Context, dao store.BotWriteDAO, botID, operationID, kind string, hash []byte) (*sessioncore.BotRecoveryReceipt, error) {
	v, err := dao.BotRecoveryOperation(ctx, botID, operationID)
	if errors.Is(err, model.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if v.Kind != kind || !bytes.Equal(v.RequestHash, hash) {
		return nil, recoveryFault("resource_conflict", "Bot recovery operation already has another request.")
	}
	var receipt sessioncore.BotRecoveryReceipt
	if err = json.Unmarshal(v.Receipt, &receipt); err != nil {
		return nil, err
	}
	return &receipt, nil
}
func saveRecoveryOperation(ctx context.Context, dao store.BotWriteDAO, botID string, receipt sessioncore.BotRecoveryReceipt, hash []byte) error {
	raw, err := json.Marshal(receipt)
	if err != nil {
		return err
	}
	return dao.SaveBotRecoveryOperation(ctx, botID, store.BotRecoveryOperation{OperationID: receipt.OperationID, Kind: receipt.Kind, RequestHash: hash, Receipt: raw})
}

func (s *Recovery) RegisterBotRecovery(ctx context.Context, p model.Principal, workerID, id string, input sessioncore.BotRecoveryRegistration) (sessioncore.BotRecoveryResult, error) {
	var out sessioncore.BotRecoveryResult
	if !recoveryID(input.OperationID) || input.BotVersion < 1 {
		return out, recoveryFault("invalid_input", "Invalid Bot recovery registration.")
	}
	hash := requestHash(workerID, "register", input)
	err := s.run(ctx, p, workerID, id, input.BotRecoveryIdentity, true, func(op *sessioncore.Operation, scope store.SessionScope, bot model.Bot, a *sessioncore.Access, identityHash []byte) error {
		dao := scope.BotDAO()
		prior, err := recoverOperation(ctx, dao, id, input.OperationID, "register", hash)
		if err != nil {
			return err
		}
		if prior != nil {
			out = sessioncore.BotRecoveryResult{Receipt: *prior, Current: op.BotRecoveryCurrent(a, bot, *prior, p)}
			return nil
		}
		if bot.Recovery != nil {
			return recoveryFault("resource_conflict", "Bot recovery identity is already registered.")
		}
		if err = botcore.CheckVersion(bot, input.BotVersion); err != nil {
			return err
		}
		if err = op.CheckBotRecoveryBinding(a, input.BotRecoveryBinding); err != nil {
			return err
		}
		machine, err := dao.RecoveryWorker(ctx, p.UserID, workerID)
		if err != nil {
			return err
		}
		if machine.ID == "" {
			return recoveryFault("resource_conflict", "Worker has no confirmed machine identity.")
		}
		bot, err = dao.RegisterBotRecovery(ctx, id, bot.Version, model.BotRecovery{ServiceOrigin: input.ServiceOrigin, IdentityHash: identityHash, HostingGeneration: 1, WorkerID: workerID, MachineID: machine.ID, MachineName: machine.Name})
		if err != nil {
			return err
		}
		out.Receipt = op.BotRecoveryReceipt(a, bot, input.OperationID, "register", nil)
		out.Current = true
		return saveRecoveryOperation(ctx, dao, id, out.Receipt, hash)
	})
	return out, err
}

func (s *Recovery) TakeoverBot(ctx context.Context, p model.Principal, workerID, id string, input sessioncore.BotRecoveryGrant) (sessioncore.BotRecoveryResult, error) {
	return s.grant(ctx, p, workerID, id, input, true)
}
func (s *Recovery) GrantBotRecovery(ctx context.Context, p model.Principal, workerID, id string, input sessioncore.BotRecoveryGrant) (sessioncore.BotRecoveryResult, error) {
	return s.grant(ctx, p, workerID, id, input, false)
}
func (s *Recovery) grant(ctx context.Context, p model.Principal, workerID, id string, input sessioncore.BotRecoveryGrant, takeover bool) (sessioncore.BotRecoveryResult, error) {
	var out sessioncore.BotRecoveryResult
	if !recoveryID(input.OperationID) || input.ExpectedHostingGeneration < 1 {
		return out, recoveryFault("invalid_input", "Invalid Bot recovery operation.")
	}
	kind := "grant"
	if takeover {
		kind = "takeover"
	}
	hash := requestHash(workerID, kind, input)
	err := s.run(ctx, p, workerID, id, input.BotRecoveryIdentity, false, func(op *sessioncore.Operation, scope store.SessionScope, bot model.Bot, a *sessioncore.Access, _ []byte) error {
		dao := scope.BotDAO()
		prior, err := recoverOperation(ctx, dao, id, input.OperationID, kind, hash)
		if err != nil {
			return err
		}
		if prior != nil {
			out = sessioncore.BotRecoveryResult{Receipt: *prior, Current: op.BotRecoveryCurrent(a, bot, *prior, p)}
			return nil
		}
		machine, err := dao.RecoveryWorker(ctx, p.UserID, workerID)
		if err != nil {
			return err
		}
		if err = botcore.CheckRecoveryHosting(bot, input.ExpectedHostingGeneration, machine); err != nil {
			return err
		}
		if takeover {
			if err = botcore.PrepareRecoveryTakeover(bot, input.ExpectedHostingGeneration, machine); err != nil {
				return err
			}
		}
		if !takeover && bot.Recovery.WorkerID != workerID {
			return recoveryFault("forbidden", "Bot is hosted by another Worker.")
		}
		tokenHash := sha256.Sum256([]byte(input.ControllerToken))
		used, err := dao.BotRecoveryTokenUsed(ctx, id, hex.EncodeToString(tokenHash[:]))
		if err != nil {
			return err
		}
		if used {
			return recoveryFault("resource_conflict", "A recovery controller token cannot be reused.")
		}
		grant, err := op.GrantBotRecovery(ctx, a, p, input)
		if err != nil {
			return err
		}
		if takeover {
			bot, err = dao.AdvanceBotRecovery(ctx, id, bot.Version, input.ExpectedHostingGeneration, workerID, machine)
			if err != nil {
				return err
			}
		}
		out.Receipt = op.BotRecoveryReceipt(a, bot, input.OperationID, kind, &grant)
		out.Current = true
		return saveRecoveryOperation(ctx, dao, id, out.Receipt, hash)
	})
	return out, err
}

func (s *Recovery) BotRecoveryOperation(ctx context.Context, p model.Principal, workerID, id, operationID string, identity sessioncore.BotRecoveryIdentity) (sessioncore.BotRecoveryResult, error) {
	var out sessioncore.BotRecoveryResult
	if !recoveryID(operationID) {
		return out, recoveryFault("invalid_input", "Invalid recovery operation identity.")
	}
	err := s.run(ctx, p, workerID, id, identity, false, func(op *sessioncore.Operation, scope store.SessionScope, bot model.Bot, a *sessioncore.Access, _ []byte) error {
		v, err := scope.BotDAO().BotRecoveryOperation(ctx, id, operationID)
		if err != nil {
			return err
		}
		if err = json.Unmarshal(v.Receipt, &out.Receipt); err != nil {
			return err
		}
		out.Current = op.BotRecoveryCurrent(a, bot, out.Receipt, p)
		return nil
	})
	return out, err
}

func (s *Recovery) ReportBotRecovery(ctx context.Context, p model.Principal, workerID, id string, input sessioncore.BotRecoveryReport) (model.Bot, error) {
	execution := sessioncore.NewBotExecution(s.engine, func(ctx context.Context, principal model.Principal, worker, botID string, prepare func(model.Bot) error, _ func(model.Bot, *sessioncore.Access) error, work func(*sessioncore.Operation, store.SessionScope, model.Bot, *sessioncore.Access, func(model.Principal) error) error) error {
		return s.run(ctx, principal, worker, botID, input.BotRecoveryIdentity, false, func(op *sessioncore.Operation, scope store.SessionScope, bot model.Bot, a *sessioncore.Access, _ []byte) error {
			if input.HostingGeneration < 1 || bot.Recovery.HostingGeneration != input.HostingGeneration || bot.Recovery.WorkerID != worker {
				return recoveryFault("resource_conflict", "Bot hosting generation has changed.")
			}
			if prepare != nil {
				if err := prepare(bot); err != nil {
					return err
				}
			}
			return work(op, scope, bot, a, func(p model.Principal) error { return op.LockCredential(ctx, scope, p) })
		})
	})
	return execution.ReportBot(ctx, p, workerID, id, input.Report)
}
