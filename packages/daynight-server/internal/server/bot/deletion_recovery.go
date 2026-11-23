package bot

import (
	"context"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type deletionRecoveryReader interface {
	DeletionRecovery(context.Context, model.Principal, string) (botcore.DeletionRecovery, error)
}
type deletionRecoveryWriter interface {
	ResolveDeletion(context.Context, model.Principal, string, botcore.ResolveDeletion) (botcore.DeletionRecovery, error)
}

func (h *botsHandler) deletionRecovery(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	id, err := botResource(request)
	var result botcore.DeletionRecovery
	if err == nil {
		if request.Method == http.MethodGet || request.Method == http.MethodHead {
			reader, ok := h.bots.(deletionRecoveryReader)
			if !ok {
				err = &model.Fault{Code: "capability_error", Message: "Bot deletion recovery is unavailable."}
			} else {
				result, err = reader.DeletionRecovery(request.Context(), principal, id)
			}
		} else {
			var input botcore.ResolveDeletion
			input, err = deletionRecoveryInput(w, request)
			if err == nil {
				writer, ok := h.relay.(deletionRecoveryWriter)
				if !ok {
					err = &model.Fault{Code: "capability_error", Message: "Bot deletion recovery is unavailable."}
				} else {
					result, err = writer.ResolveDeletion(request.Context(), principal, id, input)
				}
			}
		}
	}
	if err != nil {
		writeBotError(w, request, logger, "deletion-recovery", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, deletionRecoveryResponse(result))
}

func deletionRecoveryInput(w http.ResponseWriter, request *http.Request) (botcore.ResolveDeletion, error) {
	fields, err := httpx.DecodeObject(w, request, "action", "ifVersion", "deletionId", "operationId", "acknowledgeLocalUnverified", "reason")
	if err != nil {
		return botcore.ResolveDeletion{}, err
	}
	base, err := botDeleteInput(fields)
	if err != nil {
		return botcore.ResolveDeletion{}, err
	}
	input := botcore.ResolveDeletion{Version: base.Version, DeletionID: base.DeletionID}
	input.Action, err = httpx.RequiredString(fields, "action")
	if err != nil {
		return input, err
	}
	input.OperationID, err = httpx.RequiredString(fields, "operationId")
	if err != nil {
		return input, err
	}
	if input.Action == "accept_unverified" {
		if string(fields["acknowledgeLocalUnverified"]) != "true" {
			return input, httpx.InvalidInput("acknowledgeLocalUnverified must be true")
		}
		input.AcknowledgeLocalUnverified = true
		input.Reason, err = httpx.RequiredString(fields, "reason")
		if err != nil {
			return input, err
		}
	} else if _, present := fields["reason"]; present {
		return input, httpx.InvalidInput("Cleanup retry cannot replace the original decision")
	} else if _, present := fields["acknowledgeLocalUnverified"]; present {
		return input, httpx.InvalidInput("Cleanup retry cannot replace the original decision")
	}
	return input, botcore.ValidateDeletionResolution(input)
}

func deletionRecoveryResponse(value botcore.DeletionRecovery) api.BotDeletionRecovery {
	result := api.BotDeletionRecovery{SchemaVersion: 1, BotID: value.BotID, Version: value.Version,
		DeletionID: value.DeletionID, RequestedVersion: value.RequestedVersion, WorkerID: value.WorkerID, HostingWorkerID: value.HostingWorkerID,
		RequiresStopProof: value.RequiresStopProof, RecoveryRequired: value.RecoveryRequired,
		WorkerCleanup: api.BotResult(value.WorkerCleanup), ServerCleanup: api.BotResult(value.ServerCleanup)}
	if value.OriginalBinding != nil {
		binding := api.BotDeletionBinding(*value.OriginalBinding)
		result.OriginalBinding = &binding
	}
	if value.Decision != nil {
		decision := api.BotDeletionDecision(*value.Decision)
		decision.AcknowledgedAt = decision.AcknowledgedAt.UTC()
		result.Decision = &decision
	}
	return result
}
