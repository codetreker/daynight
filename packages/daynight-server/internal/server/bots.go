package server

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

type botsHandler struct {
	bots   *service.Bots
	logger *slog.Logger
}

func botsRoutes(mux *http.ServeMux, bots *service.Bots, auth *Authentication, logger *slog.Logger) {
	h := &botsHandler{bots: bots, logger: logger}
	const base = "/api/v1/me/bots"
	mux.HandleFunc("GET "+base, auth.Require(h.list))
	mux.HandleFunc("POST "+base, auth.Require(h.create))
	mux.HandleFunc(base, auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD, POST")))
	mux.HandleFunc("GET "+base+"/defaults", auth.Require(h.defaults))
	mux.HandleFunc(base+"/defaults", auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc(base+"/{botId}", auth.Require(h.detail))
	const worker = "/api/v1/me/workers/{workerId}/bots"
	mux.HandleFunc("GET "+worker, auth.Require(h.list))
	mux.HandleFunc(worker, auth.Require(resourceMethodNotAllowed(logger, "GET, HEAD")))
}

func (h *botsHandler) detail(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	switch request.Method {
	case http.MethodGet, http.MethodHead:
		h.get(w, request, principal)
	case http.MethodDelete:
		h.remove(w, request, principal)
	default:
		resourceMethodNotAllowed(h.logger, "GET, HEAD, DELETE")(w, request, principal)
	}
}

func botCreateInput(fields map[string]json.RawMessage) (service.CreateBot, error) {
	var input service.CreateBot
	var err error
	input.ID, err = requiredString(fields, "id")
	if err != nil {
		return input, err
	}
	input.Name, err = requiredString(fields, "name")
	if err != nil {
		return input, err
	}
	if raw, exists := fields["overrides"]; exists {
		overrides, err := jsonobject.Decode(raw, "overrides", "workerId", "cwd", "provider")
		if err != nil {
			return input, invalidInput(err.Error())
		}
		for key, target := range map[string]**string{"workerId": &input.Overrides.WorkerID, "cwd": &input.Overrides.Cwd, "provider": &input.Overrides.Provider} {
			*target, err = optionalString(overrides, key)
			if err != nil {
				return input, err
			}
		}
	}
	return input, nil
}

func (h *botsHandler) create(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	var bot core.Bot
	var err error
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		err = invalidInput("bot creation does not accept query parameters")
	} else {
		var fields map[string]json.RawMessage
		fields, err = decodeObject(w, request, "id", "name", "overrides")
		if err == nil {
			var input service.CreateBot
			input, err = botCreateInput(fields)
			if err == nil {
				bot, err = h.bots.CreateResolved(request.Context(), principal, input)
			}
		}
	}
	if err != nil {
		writeError(w, request, logger, "bot", "create", err)
		return
	}
	writeJSON(w, request, logger, http.StatusOK, botResponse(bot))
}

func (h *botsHandler) defaults(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	values, err := queryValues(request, "workerId")
	var result service.BotDefaults
	if err == nil {
		var workerID *string
		if value, exists := values["workerId"]; exists {
			workerID = &value[0]
		}
		result, err = h.bots.Defaults(request.Context(), principal, workerID)
	}
	if err != nil {
		writeError(w, request, logger, "bot", "defaults", err)
		return
	}
	writeJSON(w, request, logger, http.StatusOK, botDefaultsResponse(result))
}

func botDefaultsResponse(value service.BotDefaults) api.BotDefaults {
	result := api.BotDefaults{ObservedAt: value.ObservedAt.UTC(), WorkerID: value.WorkerID,
		Configuration: botConfigurationResponse(value.Configuration), Reason: value.Reason, Workers: make([]api.BotWorkerDefaults, 0, len(value.Workers))}
	for _, worker := range value.Workers {
		item := api.BotWorkerDefaults{WorkerID: worker.WorkerID, Machine: api.WorkerMachine(worker.Machine), Platform: string(worker.Platform),
			State: worker.State, Reason: worker.Reason, Configuration: botConfigurationResponse(worker.Configuration), Providers: make([]api.WorkerAssistantProvider, 0, len(worker.Providers))}
		for _, provider := range worker.Providers {
			item.Providers = append(item.Providers, api.WorkerAssistantProvider{Provider: string(provider.Provider), Available: provider.Available,
				Reason: provider.Reason, Model: provider.Model, Args: append([]string{}, provider.Args...)})
		}
		result.Workers = append(result.Workers, item)
	}
	return result
}

func botConfigurationResponse(value *core.BotConfiguration) *api.BotConfiguration {
	if value == nil {
		return nil
	}
	result := api.BotConfiguration(*value)
	result.Args = append([]string{}, value.Args...)
	return &result
}

func (h *botsHandler) list(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	page, err := pageRequest(request)
	var result service.BotPage
	if err == nil {
		if workerID := request.PathValue("workerId"); workerID != "" {
			result, err = h.bots.ListWorker(request.Context(), principal, workerID, page)
		} else {
			result, err = h.bots.List(request.Context(), principal, page)
		}
	}
	if err != nil {
		writeError(w, request, logger, "bot", "list", err)
		return
	}
	response := api.BotPage{Items: make([]api.Bot, 0, len(result.Items)), NextCursor: result.NextCursor}
	for _, bot := range result.Items {
		response.Items = append(response.Items, botResponse(bot))
	}
	writeJSON(w, request, logger, http.StatusOK, response)
}

func botResource(request *http.Request) (string, error) {
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		return "", invalidInput("bot detail operations do not accept query parameters")
	}
	return service.CanonicalID(request.PathValue("botId"))
}

func (h *botsHandler) get(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	id, err := botResource(request)
	logger := h.logger.With("user_id", principal.UserID)
	var bot core.Bot
	if err == nil {
		bot, err = h.bots.Get(request.Context(), principal, id)
	}
	if err != nil {
		writeError(w, request, logger, "bot", "read", err)
		return
	}
	writeJSON(w, request, logger, http.StatusOK, botResponse(bot))
}

func botDeleteInput(fields map[string]json.RawMessage) (service.DeleteBot, error) {
	version, err := requiredString(fields, "ifVersion")
	if err != nil {
		return service.DeleteBot{}, err
	}
	value, err := strconv.ParseInt(version, 10, 64)
	if err != nil || value < 1 || strconv.FormatInt(value, 10) != version {
		return service.DeleteBot{}, invalidInput("ifVersion must be a positive int64 decimal string")
	}
	id, err := requiredString(fields, "deletionId")
	return service.DeleteBot{Version: value, DeletionID: id}, err
}

func (h *botsHandler) remove(w http.ResponseWriter, request *http.Request, principal core.Principal) {
	id, err := botResource(request)
	logger := h.logger.With("user_id", principal.UserID)
	var bot core.Bot
	if err == nil {
		var fields map[string]json.RawMessage
		fields, err = decodeObject(w, request, "ifVersion", "deletionId")
		if err == nil {
			var input service.DeleteBot
			input, err = botDeleteInput(fields)
			if err == nil {
				bot, err = h.bots.Delete(request.Context(), principal, id, input)
			}
		}
	}
	if err != nil {
		writeError(w, request, logger, "bot", "delete", err)
		return
	}
	writeJSON(w, request, logger, http.StatusOK, botResponse(bot))
}

func botResponse(bot core.Bot) api.Bot {
	result := api.Bot{ID: bot.ID, WorkerID: bot.WorkerID, Version: bot.Version}
	if bot.Deletion != nil {
		deletion := bot.Deletion
		result.Deletion = &api.BotDeletion{DeletionID: deletion.DeletionID, RequestedVersion: deletion.RequestedVersion,
			WorkerCleanup: api.BotResult(deletion.WorkerCleanup), ServerCleanup: api.BotResult(deletion.ServerCleanup)}
		return result
	}
	result.BotDefinition = &api.BotDefinition{OwnerUserID: bot.OwnerUserID, Name: bot.Name, CreationOrder: bot.CreationOrder,
		RequestedOverrides: api.BotOverrides(bot.RequestedOverrides), ResolvedConfiguration: api.BotConfiguration(bot.ResolvedConfiguration),
		SessionID: bot.SessionID, StartupResult: api.BotResult(bot.StartupResult), CreatedAt: bot.CreatedAt.UTC(), UpdatedAt: bot.UpdatedAt.UTC()}
	if bot.RoleConfiguration != nil {
		role := api.BotRoleConfiguration(*bot.RoleConfiguration)
		result.RoleConfiguration = &role
	}
	return result
}
