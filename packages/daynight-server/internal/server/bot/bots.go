package bot

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"

	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	botcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
)

type definitions interface {
	CreateResolved(context.Context, model.Principal, botcore.CreateBot) (model.Bot, error)
	Defaults(context.Context, model.Principal, *string) (botcore.BotDefaults, error)
	List(context.Context, model.Principal, model.PageRequest) (botcore.BotPage, error)
	ListWorker(context.Context, model.Principal, string, model.PageRequest) (botcore.BotPage, error)
	Get(context.Context, model.Principal, string) (model.Bot, error)
}

type deletion interface {
	DeleteBot(context.Context, model.Principal, string, store.DeleteBot) (model.Bot, error)
}

type botsHandler struct {
	bots   definitions
	relay  deletion
	logger *slog.Logger
}

func RegisterRoutes(mux *http.ServeMux, bots definitions, relay deletion, auth *authhttp.Authentication, logger *slog.Logger) {
	h := &botsHandler{bots: bots, relay: relay, logger: logger}
	admit := func(handler httpx.AuthenticatedHandler) http.HandlerFunc {
		return auth.Require(h.withAttention(handler))
	}
	const base = "/api/v1/me/bots"
	mux.HandleFunc("GET "+base, admit(h.list))
	mux.HandleFunc("POST "+base, admit(h.create))
	mux.HandleFunc(base, admit(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, POST")))
	mux.HandleFunc("GET "+base+"/defaults", admit(h.defaults))
	mux.HandleFunc(base+"/defaults", admit(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	mux.HandleFunc(base+"/{botId}", admit(h.detail))
	const worker = "/api/v1/me/workers/{workerId}/bots"
	mux.HandleFunc("GET "+worker, admit(h.list))
	mux.HandleFunc(worker, admit(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
}

func (h *botsHandler) detail(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	switch request.Method {
	case http.MethodGet, http.MethodHead:
		h.get(w, request, principal)
	case http.MethodDelete:
		h.remove(w, request, principal)
	default:
		httpx.ResourceMethodNotAllowed(h.logger, "GET, HEAD, DELETE")(w, request, principal)
	}
}

func botCreateInput(fields map[string]json.RawMessage) (botcore.CreateBot, error) {
	var input botcore.CreateBot
	var err error
	input.ID, err = httpx.RequiredString(fields, "id")
	if err != nil {
		return input, err
	}
	input.Name, err = httpx.RequiredString(fields, "name")
	if err != nil {
		return input, err
	}
	if raw, exists := fields["overrides"]; exists {
		overrides, err := jsonobject.Decode(raw, "overrides", "workerId", "cwd", "provider", "model", "reasoningEffort")
		if err != nil {
			return input, httpx.InvalidInput(err.Error())
		}
		for key, target := range map[string]**string{"workerId": &input.Overrides.WorkerID, "cwd": &input.Overrides.Cwd, "provider": &input.Overrides.Provider, "model": &input.Overrides.Model, "reasoningEffort": &input.Overrides.ReasoningEffort} {
			*target, err = httpx.OptionalString(overrides, key)
			if err != nil {
				return input, err
			}
		}
	}
	return input, nil
}

func (h *botsHandler) create(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	var bot model.Bot
	var err error
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		err = httpx.InvalidInput("bot creation does not accept query parameters")
	} else {
		var fields map[string]json.RawMessage
		fields, err = httpx.DecodeObject(w, request, "id", "name", "overrides")
		if err == nil {
			var input botcore.CreateBot
			input, err = botCreateInput(fields)
			if err == nil {
				bot, err = h.bots.CreateResolved(request.Context(), principal, input)
			}
		}
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "bot", "create", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, responseForRequest(request, bot))
}

func (h *botsHandler) defaults(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	values, err := httpx.QueryValues(request, "workerId", "cwd", "provider", "model", "reasoningEffort")
	var result botcore.BotDefaults
	if err == nil {
		overrides := model.BotOverrides{}
		for key, destination := range map[string]**string{"workerId": &overrides.WorkerID, "cwd": &overrides.Cwd, "provider": &overrides.Provider, "model": &overrides.Model, "reasoningEffort": &overrides.ReasoningEffort} {
			if value, exists := values[key]; exists {
				*destination = &value[0]
			}
		}
		if resolver, ok := h.bots.(interface {
			DefaultsFor(context.Context, model.Principal, model.BotOverrides) (botcore.BotDefaults, error)
		}); ok {
			result, err = resolver.DefaultsFor(request.Context(), principal, overrides)
		} else if overrides.Cwd != nil || overrides.Provider != nil || overrides.Model != nil || overrides.ReasoningEffort != nil {
			err = httpx.InvalidInput("Bot defaults do not support these overrides.")
		} else {
			result, err = h.bots.Defaults(request.Context(), principal, overrides.WorkerID)
		}
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "bot", "defaults", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, botDefaultsResponse(result))
}

func botDefaultsResponse(value botcore.BotDefaults) api.BotDefaults {
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

func botConfigurationResponse(value *model.BotConfiguration) *api.BotConfiguration {
	if value == nil {
		return nil
	}
	result := api.BotConfiguration{WorkerID: value.WorkerID, Cwd: value.Cwd, Provider: value.Provider, Model: value.Model, Args: append([]string{}, value.Args...), ReasoningEffort: value.ReasoningEffort}
	if value.Selection != nil {
		selection := api.BotSelection(*value.Selection)
		result.Selection = &selection
	}
	return &result
}

func (h *botsHandler) list(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	logger := h.logger.With("user_id", principal.UserID)
	page, err := httpx.PageRequest(request)
	if err != nil {
		httpx.WriteError(w, request, logger, "bot", "list", err)
		return
	}
	var result botcore.BotPage
	if workerID := request.PathValue("workerId"); workerID != "" {
		result, err = h.bots.ListWorker(request.Context(), principal, workerID, page)
	} else {
		result, err = h.bots.List(request.Context(), principal, page)
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "bot", "list", err)
		return
	}
	response := api.BotPage{Items: make([]api.Bot, 0, len(result.Items)), NextCursor: result.NextCursor}
	for _, item := range result.Items {
		response.Items = append(response.Items, responseForRequest(request, item))
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, response)
}

func botResource(request *http.Request) (string, error) {
	if request.URL.RawQuery != "" || request.URL.ForceQuery {
		return "", httpx.InvalidInput("bot detail operations do not accept query parameters")
	}
	return model.CanonicalID(request.PathValue("botId"))
}

func (h *botsHandler) get(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	id, err := botResource(request)
	logger := h.logger.With("user_id", principal.UserID)
	var bot model.Bot
	if err == nil {
		bot, err = h.bots.Get(request.Context(), principal, id)
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "bot", "read", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, responseForRequest(request, bot))
}

func botDeleteInput(fields map[string]json.RawMessage) (store.DeleteBot, error) {
	version, err := httpx.RequiredString(fields, "ifVersion")
	if err != nil {
		return store.DeleteBot{}, err
	}
	value, err := strconv.ParseInt(version, 10, 64)
	if err != nil || value < 1 || strconv.FormatInt(value, 10) != version {
		return store.DeleteBot{}, httpx.InvalidInput("ifVersion must be a positive int64 decimal string")
	}
	id, err := httpx.RequiredString(fields, "deletionId")
	return store.DeleteBot{Version: value, DeletionID: id}, err
}

func (h *botsHandler) remove(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	id, err := botResource(request)
	logger := h.logger.With("user_id", principal.UserID)
	var bot model.Bot
	if err == nil {
		var fields map[string]json.RawMessage
		fields, err = httpx.DecodeObject(w, request, "ifVersion", "deletionId")
		if err == nil {
			var input store.DeleteBot
			input, err = botDeleteInput(fields)
			if err == nil {
				bot, err = h.relay.DeleteBot(request.Context(), principal, id, input)
			}
		}
	}
	if err != nil {
		httpx.WriteError(w, request, logger, "bot", "delete", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, responseForRequest(request, bot))
}

// Response projects a Bot into its public representation, redacting deleted definitions.
func Response(bot model.Bot) api.Bot {
	result := api.Bot{ID: bot.ID, WorkerID: bot.WorkerID, Version: bot.Version}
	if bot.Deletion != nil {
		deletion := bot.Deletion
		result.Deletion = &api.BotDeletion{DeletionID: deletion.DeletionID, RequestedVersion: deletion.RequestedVersion,
			WorkerCleanup: api.BotResult(deletion.WorkerCleanup), ServerCleanup: api.BotResult(deletion.ServerCleanup)}
		return result
	}
	result.BotDefinition = &api.BotDefinition{OwnerUserID: bot.OwnerUserID, Name: bot.Name, CreationOrder: bot.CreationOrder,
		RequestedOverrides: api.BotOverrides(bot.RequestedOverrides), ResolvedConfiguration: *botConfigurationResponse(&bot.ResolvedConfiguration),
		SessionID: bot.SessionID, TestExecutionID: bot.TestExecutionID, StartupResult: api.BotResult(bot.StartupResult), CreatedAt: bot.CreatedAt.UTC(), UpdatedAt: bot.UpdatedAt.UTC()}
	if bot.RoleConfiguration != nil {
		role := api.BotRoleConfiguration(*bot.RoleConfiguration)
		result.RoleConfiguration = &role
	}
	return result
}
