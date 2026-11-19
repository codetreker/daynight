package bot

import (
	"crypto/sha256"
	"crypto/subtle"
	"math"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func recoveryConflict() error {
	return &model.Fault{Code: "resource_conflict", Message: "Bot recovery identity or hosting generation has changed."}
}

// PrepareRecoveryRegistration admits an existing binding under current account
// authentication. The former Session parent credential is not recovery proof.
func PrepareRecoveryRegistration(bot model.Bot, userID, workerID string) error {
	if err := AuthorizeRuntime(bot, userID, workerID); err != nil {
		return err
	}
	if bot.SessionID == nil || bot.TestExecutionID == nil || bot.RoleConfiguration == nil {
		return recoveryConflict()
	}
	if bot.Version == math.MaxInt64 {
		return &model.Fault{Code: "version_exhausted", Message: "Bot version cannot advance."}
	}
	return nil
}

// AuthorizeRecovery authenticates the durable proof independently of old PATs.
func AuthorizeRecovery(bot model.Bot, userID, serviceOrigin string, identityHash []byte) error {
	if bot.OwnerUserID != userID {
		return &model.Fault{Code: "forbidden", Message: "Bot recovery access is not available."}
	}
	if bot.Deletion != nil {
		return &model.Fault{Code: "resource_conflict", Message: "Bot is deleted."}
	}
	if bot.Recovery == nil {
		return &model.Fault{Code: "upgrade_required", Message: "Bot recovery registration is required."}
	}
	if bot.Recovery.ServiceOrigin != serviceOrigin || len(identityHash) != sha256.Size || len(bot.Recovery.IdentityHash) != sha256.Size || subtle.ConstantTimeCompare(bot.Recovery.IdentityHash, identityHash) != 1 {
		return &model.Fault{Code: "forbidden", Message: "Bot recovery access is not available."}
	}
	return nil
}

// CheckRecoveryHosting requires the observed generation on the original machine.
// A matching machine is not evidence that an old process has stopped.
func CheckRecoveryHosting(bot model.Bot, expectedGeneration int64, machine model.WorkerMachine) error {
	if bot.Recovery == nil || expectedGeneration < 1 || bot.Recovery.HostingGeneration != expectedGeneration || machine.ID == "" || machine.ID != bot.Recovery.MachineID || bot.SessionID == nil || bot.TestExecutionID == nil {
		return recoveryConflict()
	}
	return nil
}

// PrepareRecoveryTakeover additionally reserves room for a hosting transition.
// Grant renewal uses CheckRecoveryHosting without advancing either version.
func PrepareRecoveryTakeover(bot model.Bot, expectedGeneration int64, machine model.WorkerMachine) error {
	if err := CheckRecoveryHosting(bot, expectedGeneration, machine); err != nil {
		return err
	}
	if bot.Version == math.MaxInt64 || expectedGeneration == math.MaxInt64 {
		return &model.Fault{Code: "version_exhausted", Message: "Bot hosting generation or version cannot advance."}
	}
	return nil
}
