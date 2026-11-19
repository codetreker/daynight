package bot

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type observations interface {
	Observation(context.Context, model.Principal, string) (botcore.Observation, error)
}

func (h *botsHandler) observation(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	id, err := botResource(request)
	var result botcore.Observation
	if err == nil {
		if h.observations == nil {
			err = &model.Fault{Code: "service_unavailable", Message: "Bot observation is unavailable."}
		} else {
			result, err = h.observations.Observation(request.Context(), principal, id)
		}
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "bot", "observe", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, observationResponse(result))
}

func observationTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	utc := value.UTC()
	return &utc
}

func observationResponse(value botcore.Observation) api.BotObservation {
	result := api.BotObservation{SchemaVersion: 1, BotID: value.BotID, BotVersion: value.BotVersion,
		WorkerID: value.WorkerID, Provider: value.Provider, SessionID: value.SessionID,
		TestExecutionID: value.TestExecutionID, NativeSessionID: value.NativeSessionID,
		ExecutionGeneration: value.ExecutionGeneration, ConnectionEpoch: value.ConnectionEpoch,
		State: value.State, Reason: value.Reason, ObservedAt: value.ObservedAt.UTC(),
		WorkerLastSeenAt: observationTime(value.WorkerLastSeenAt), SessionLastSeenAt: observationTime(value.SessionLastSeenAt),
		FreshUntil: observationTime(value.FreshUntil), CurrentTurnID: value.CurrentTurnID}
	if value.Machine != nil {
		machine := api.WorkerMachine(*value.Machine)
		result.Machine = &machine
	}
	if value.HostingGeneration != nil {
		generation := strconv.FormatInt(*value.HostingGeneration, 10)
		result.HostingGeneration = &generation
	}
	return result
}
