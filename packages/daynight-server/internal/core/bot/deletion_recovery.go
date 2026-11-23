package bot

import (
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

const MissingExecutionEvidence = "execution_evidence_missing"

type DeletionRecovery struct {
	BotID             string
	Version           int64
	DeletionID        string
	RequestedVersion  int64
	WorkerID          string
	HostingWorkerID   string
	RequiresStopProof bool
	RecoveryRequired  bool
	OriginalBinding   *model.BotDeletionBinding
	WorkerCleanup     model.BotCleanupResult
	Decision          *model.BotDeletionDecision
	ServerCleanup     model.BotCleanupResult
}

type ResolveDeletion struct {
	Action                     string
	Version                    int64
	DeletionID                 string
	OperationID                string
	AcknowledgeLocalUnverified bool
	Reason                     string
}

func ValidateDeletionResolution(input ResolveDeletion) error {
	if !runtimeID(input.DeletionID) || !runtimeID(input.OperationID) || input.Version < 1 {
		return &model.Fault{Code: "invalid_input", Message: "Invalid deletion recovery identity or version."}
	}
	switch input.Action {
	case "accept_unverified":
		if !input.AcknowledgeLocalUnverified || !utf8.ValidString(input.Reason) || strings.TrimSpace(input.Reason) == "" || strings.ContainsRune(input.Reason, 0) || utf8.RuneCountInString(input.Reason) > 1000 {
			return &model.Fault{Code: "invalid_input", Message: "Acknowledge unverified local cleanup and provide a reason of 1 to 1000 characters."}
		}
	case "retry_cleanup":
		if input.AcknowledgeLocalUnverified || input.Reason != "" {
			return &model.Fault{Code: "invalid_input", Message: "Cleanup retry cannot replace the original decision."}
		}
	default:
		return &model.Fault{Code: "invalid_input", Message: "Unknown deletion recovery action."}
	}
	return nil
}

func deletionRecoveryConflict(message string) error {
	return &model.Fault{Code: "resource_conflict", Message: message}
}

func DeletionRecoveryRequired(bot model.Bot) bool {
	d := bot.Deletion
	return d != nil && d.Recovery == nil && d.ServerCleanup.State != "completed" && d.WorkerCleanup.State == "failed" && d.WorkerCleanup.Code != nil && *d.WorkerCleanup.Code == MissingExecutionEvidence
}

// DeletionBinding validates metadata without treating its presence as stop proof.
func DeletionBinding(bot model.Bot, snapshot *sp.Snapshot) (*model.BotDeletionBinding, error) {
	if bot.SessionID == nil {
		if bot.TestExecutionID != nil || snapshot != nil {
			return nil, errors.New("Bot deletion binding is inconsistent")
		}
		return nil, nil
	}
	if snapshot == nil || bot.TestExecutionID == nil || snapshot.SessionID != *bot.SessionID || snapshot.TestExecutionID != *bot.TestExecutionID || snapshot.Identity.OwnerUserID != bot.OwnerUserID {
		return nil, errors.New("Bot deletion requires its original Session binding")
	}
	binding := &model.BotDeletionBinding{SessionID: snapshot.SessionID, TestExecutionID: snapshot.TestExecutionID, ExecutionGeneration: snapshot.ExecutionGeneration,
		ControllerID: snapshot.Identity.ControllerID, ControllerInstanceID: snapshot.Identity.ControllerInstanceID}
	if !validDeletionBinding(binding) {
		return nil, errors.New("Bot deletion Session binding is invalid")
	}
	return binding, nil
}

func validDeletionBinding(value *model.BotDeletionBinding) bool {
	if value == nil {
		return true
	}
	version, err := strconv.ParseInt(value.ExecutionGeneration, 10, 64)
	return runtimeID(value.SessionID) && runtimeID(value.TestExecutionID) && runtimeID(value.ControllerID) && runtimeID(value.ControllerInstanceID) && err == nil && version > 0 && strconv.FormatInt(version, 10) == value.ExecutionGeneration
}

func deletionRecoveryValid(bot model.Bot) bool {
	r := bot.Deletion.Recovery
	return r != nil && runtimeID(r.WorkerID) && validDeletionBinding(r.OriginalBinding) && runtimeID(r.Decision.OperationID) && r.Decision.ActorUserID == bot.OwnerUserID && r.Decision.RequestedVersion > 0 && !r.Decision.AcknowledgedAt.IsZero() && r.Decision.LocalDisposition == "unverified" && ValidateDeletionResolution(ResolveDeletion{Action: "accept_unverified", Version: r.Decision.RequestedVersion, DeletionID: bot.Deletion.DeletionID, OperationID: r.Decision.OperationID, AcknowledgeLocalUnverified: true, Reason: r.Decision.Reason}) == nil
}

func ProjectDeletionRecovery(bot model.Bot, binding *model.BotDeletionBinding) (DeletionRecovery, error) {
	if bot.Deletion == nil {
		return DeletionRecovery{}, deletionRecoveryConflict("Bot has not been deleted.")
	}
	d := bot.Deletion
	if d.Recovery == nil && binding == nil && (bot.SessionID != nil || bot.TestExecutionID != nil) {
		return DeletionRecovery{}, errors.New("Bot deletion binding has not been established")
	}
	out := DeletionRecovery{BotID: bot.ID, Version: bot.Version, DeletionID: d.DeletionID, RequestedVersion: d.RequestedVersion,
		WorkerID: bot.WorkerID, HostingWorkerID: bot.WorkerID, OriginalBinding: binding, WorkerCleanup: d.WorkerCleanup, ServerCleanup: d.ServerCleanup, RecoveryRequired: DeletionRecoveryRequired(bot)}
	if bot.Recovery != nil {
		out.HostingWorkerID = bot.Recovery.WorkerID
	}
	if d.Recovery != nil {
		if !deletionRecoveryValid(bot) {
			return DeletionRecovery{}, errors.New("Stored Bot deletion recovery decision is invalid")
		}
		out.HostingWorkerID = d.Recovery.WorkerID
		out.OriginalBinding = d.Recovery.OriginalBinding
		decision := d.Recovery.Decision
		out.Decision = &decision
	}
	out.RequiresStopProof = out.OriginalBinding != nil
	return out, nil
}

// CheckDeletionResolution runs under the same Bot lock as Worker receipts.
// Exact decision replay only reads its result; only explicit retry runs cleanup.
func CheckDeletionResolution(bot model.Bot, input ResolveDeletion) (replay bool, err error) {
	if err = ValidateDeletionResolution(input); err != nil {
		return false, err
	}
	if bot.Deletion == nil || bot.Deletion.DeletionID != input.DeletionID {
		return false, deletionRecoveryConflict("Deletion recovery does not match the original deletion.")
	}
	if r := bot.Deletion.Recovery; r != nil {
		if !deletionRecoveryValid(bot) {
			return false, errors.New("Stored Bot deletion recovery decision is invalid")
		}
		if r.Decision.OperationID != input.OperationID {
			return false, deletionRecoveryConflict("Deletion recovery belongs to a different decision.")
		}
		if input.Action == "accept_unverified" {
			if r.Decision.RequestedVersion != input.Version || r.Decision.Reason != input.Reason {
				return false, deletionRecoveryConflict("Deletion recovery replay differs from the original decision.")
			}
			return true, nil
		}
	} else if input.Action != "accept_unverified" || !DeletionRecoveryRequired(bot) {
		return false, deletionRecoveryConflict("Deletion does not require an unverified local cleanup decision.")
	}
	if bot.Version != input.Version {
		return false, &model.Fault{Code: "version_conflict", Message: "Bot version has changed."}
	}
	if bot.Deletion.ServerCleanup.State == "completed" {
		return false, deletionRecoveryConflict("Server cleanup is already completed.")
	}
	return false, CheckDeletionVersion(bot)
}

func ApplyDeletionResolution(bot *model.Bot, input ResolveDeletion, binding *model.BotDeletionBinding, now time.Time) {
	if input.Action == "accept_unverified" {
		worker := bot.WorkerID
		if bot.Recovery != nil {
			worker = bot.Recovery.WorkerID
		}
		bot.Deletion.Recovery = &model.BotDeletionRecovery{WorkerID: worker, OriginalBinding: binding, Decision: model.BotDeletionDecision{
			OperationID: input.OperationID, RequestedVersion: input.Version, ActorUserID: bot.OwnerUserID, Reason: input.Reason, AcknowledgedAt: now.UTC(), LocalDisposition: "unverified"}}
	}
	bot.Deletion.ServerCleanup = model.BotCleanupResult{State: "pending"}
}
