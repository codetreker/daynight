package bot

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sessionhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/session"
)

type recoveryService interface {
	RegisterBotRecovery(context.Context, model.Principal, string, string, sessioncore.BotRecoveryRegistration) (sessioncore.BotRecoveryResult, error)
	TakeoverBot(context.Context, model.Principal, string, string, sessioncore.BotRecoveryGrant) (sessioncore.BotRecoveryResult, error)
	GrantBotRecovery(context.Context, model.Principal, string, string, sessioncore.BotRecoveryGrant) (sessioncore.BotRecoveryResult, error)
	ReportBotRecovery(context.Context, model.Principal, string, string, sessioncore.BotRecoveryReport) (model.Bot, error)
	BotRecoveryOperation(context.Context, model.Principal, string, string, string, sessioncore.BotRecoveryIdentity) (sessioncore.BotRecoveryResult, error)
}

// RegisterRecoveryRoutes keeps recovery secrets in request bodies on an
// independent versioned API; the ordinary Bot DTO and grant API remain stable.
func RegisterRecoveryRoutes(mux *http.ServeMux, service recoveryService, auth *authhttp.Authentication, responses *sessionhttp.Routes, logger *slog.Logger) {
	registerRecoveryRoutes(mux, service, auth, responses, logger, nil)
}

// RegisterRecoveryRoutesWithScopeObserver reports classifications at registration.
func RegisterRecoveryRoutesWithScopeObserver(mux *http.ServeMux, service recoveryService, auth *authhttp.Authentication, responses *sessionhttp.Routes, logger *slog.Logger, observe func(RuntimeScopeRoute)) {
	registerRecoveryRoutes(mux, service, auth, responses, logger, observe)
}

func registerRecoveryRoutes(mux *http.ServeMux, service recoveryService, auth *authhttp.Authentication, responses *sessionhttp.Routes, logger *slog.Logger, observe func(RuntimeScopeRoute)) {
	const base = "/api/v1/me/workers/{workerId}/bots/{botId}/recovery/v1/"
	routes := runtimeRouteRegistry{mux: mux, observe: observe}
	for _, route := range []struct {
		action string
		class  runtimeRouteClass
	}{
		{"register", recoveryWrite}, {"takeover", recoveryWrite}, {"grant", recoveryWrite},
		{"report", recoveryReport}, {"operations/{operationId}", recoveryReceipt},
	} {
		action := route.action
		handler := func(w http.ResponseWriter, r *http.Request, p model.Principal) {
			raw, err := sessionhttp.ReadBody(w, r)
			if err != nil {
				responses.Failure(w, r, err)
				return
			}
			worker, botID := r.PathValue("workerId"), r.PathValue("botId")
			var result sessioncore.BotRecoveryResult
			switch action {
			case "register":
				input, parseErr := botRecoveryRegistrationInput(raw)
				if parseErr != nil {
					responses.Failure(w, r, parseErr)
					return
				}
				result, err = service.RegisterBotRecovery(r.Context(), p, worker, botID, input)
			case "takeover", "grant":
				input, parseErr := botRecoveryGrantInput(raw)
				if parseErr != nil {
					responses.Failure(w, r, parseErr)
					return
				}
				if action == "takeover" {
					result, err = service.TakeoverBot(r.Context(), p, worker, botID, input)
				} else {
					result, err = service.GrantBotRecovery(r.Context(), p, worker, botID, input)
				}
			case "report":
				input, parseErr := botRecoveryReportInput(raw)
				if parseErr != nil {
					responses.Failure(w, r, parseErr)
					return
				}
				bot, reportErr := service.ReportBotRecovery(r.Context(), p, worker, botID, input)
				if reportErr != nil {
					recoveryFailure(w, r, responses, logger, reportErr)
					return
				}
				httpx.WriteMutationJSON(w, r, logger, "bot_recovery", http.StatusOK, Response(bot))
				return
			default:
				input, parseErr := botRecoveryQueryInput(raw)
				if parseErr != nil {
					responses.Failure(w, r, parseErr)
					return
				}
				result, err = service.BotRecoveryOperation(r.Context(), p, worker, botID, r.PathValue("operationId"), input)
			}
			if err != nil {
				recoveryFailure(w, r, responses, logger, err)
				return
			}
			if action == "operations/{operationId}" {
				httpx.WriteJSON(w, r, logger, http.StatusOK, recoveryResponse(result))
			} else {
				httpx.WriteMutationJSON(w, r, logger, "bot_recovery", http.StatusOK, recoveryResponse(result))
			}
		}
		routes.handle("POST "+base+action, auth.Require(responses.Parameters(handler)), route.class)
		routes.handle(base+action, auth.Require(httpx.ResourceMethodNotAllowed(logger, "POST")), runtimeFallback)
	}
}

func recoveryFailure(w http.ResponseWriter, r *http.Request, responses *sessionhttp.Routes, logger *slog.Logger, err error) {
	var fault *model.Fault
	if errors.As(err, &fault) && fault.Code == "outcome_unknown" {
		httpx.CloseUnreadBody(w, r)
		httpx.LogFailure(logger, r.Context(), "bot_recovery", "operation", err)
		httpx.WriteJSON(w, r, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: "outcome_unknown", Message: "Bot recovery outcome is unknown; query the original operation.", RequestID: httpx.RequestID(r.Context())}})
		return
	}
	responses.Failure(w, r, err)
}

func recoveryResponse(result sessioncore.BotRecoveryResult) api.BotRecoveryResult {
	r := result.Receipt
	return api.BotRecoveryResult{Current: result.Current, Receipt: api.BotRecoveryReceipt{BotRecoveryVersion: r.BotRecoveryVersion, OperationID: r.OperationID, Kind: r.Kind, WorkerID: r.WorkerID, HostingGeneration: r.HostingGeneration, BotVersion: r.BotVersion, SessionID: r.SessionID, TestExecutionID: r.TestExecutionID, NativeSessionID: r.NativeSessionID, ExecutionGeneration: r.ExecutionGeneration, ControllerID: r.ControllerID, ControllerInstanceID: r.ControllerInstanceID, GrantExpiresAt: r.GrantExpiresAt, ControllerTokenHash: r.ControllerTokenHash}}
}
