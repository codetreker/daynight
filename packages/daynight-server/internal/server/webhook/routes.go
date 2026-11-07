package webhook

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	webhookcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type management interface {
	Catalog(context.Context, model.Principal) (webhookservice.CatalogResult, error)
	List(context.Context, model.Principal, webhookmodel.Owner, webhookservice.ListInput) (webhookservice.ListResult, error)
	Get(context.Context, model.Principal, webhookmodel.Owner, string) (webhookservice.EndpointResult, error)
	Operation(context.Context, model.Principal, webhookmodel.Owner, string) (webhookmodel.OperationReceipt, error)
	SigningSecret(context.Context, model.Principal, webhookmodel.Owner, string) (webhookservice.SecretResult, error)
	Create(context.Context, model.Principal, webhookmodel.Owner, webhookcore.CreateInput) (webhookservice.MutationResult, error)
	Patch(context.Context, model.Principal, webhookmodel.Owner, string, webhookcore.PatchInput) (webhookservice.MutationResult, error)
	Delete(context.Context, model.Principal, webhookmodel.Owner, string, webhookcore.DeleteInput) (webhookservice.MutationResult, error)
	Rotate(context.Context, model.Principal, webhookmodel.Owner, string, webhookcore.RotateInput) (webhookservice.MutationResult, error)
}

type handler struct {
	manager management
	logger  *slog.Logger
}

func RegisterRoutes(mux *http.ServeMux, manager management, auth *authhttp.Authentication, logger *slog.Logger) {
	h := &handler{manager: manager, logger: logger}
	mux.HandleFunc("GET /api/v1/webhook-event-types", auth.Require(h.catalog))
	mux.HandleFunc("/api/v1/webhook-event-types", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
	for _, base := range []string{"/api/v1/me/webhooks", "/api/v1/teams/{teamId}/webhooks"} {
		mux.HandleFunc("GET "+base, auth.Require(h.list))
		mux.HandleFunc("POST "+base, auth.Require(h.create))
		mux.HandleFunc(base, auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, POST")))
		mux.HandleFunc("GET "+base+"/operations/{operationId}", auth.Require(h.receipt))
		mux.HandleFunc(base+"/operations/{operationId}", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD")))
		mux.HandleFunc("GET "+base+"/{endpointId}", auth.Require(h.get))
		mux.HandleFunc("PATCH "+base+"/{endpointId}", auth.Require(h.patch))
		mux.HandleFunc("DELETE "+base+"/{endpointId}", auth.Require(h.remove))
		mux.HandleFunc(base+"/{endpointId}", auth.Require(httpx.ResourceMethodNotAllowed(logger, "GET, HEAD, PATCH, DELETE")))
		// A shared endpoint subtree avoids the ambiguous operation/{id} versus
		// {id}/signing-secret patterns in the standard ServeMux.
		mux.HandleFunc(base+"/{endpointId}/", auth.Require(h.nested))
	}
}

func (h *handler) nested(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	marker := "/" + request.PathValue("endpointId") + "/"
	index := strings.LastIndex(request.URL.Path, marker)
	if index < 0 {
		httpx.WriteError(w, request, h.logger, "webhook", "route", &model.Fault{Code: "not_found", Message: "Webhook resource was not found."})
		return
	}
	switch request.URL.Path[index+len(marker):] {
	case "signing-secret":
		if request.Method == http.MethodGet || request.Method == http.MethodHead {
			h.secret(w, request, principal)
		} else {
			httpx.ResourceMethodNotAllowed(h.logger, "GET, HEAD")(w, request, principal)
		}
	case "signing-secret/rotations":
		if request.Method == http.MethodPost {
			h.rotate(w, request, principal)
		} else {
			httpx.ResourceMethodNotAllowed(h.logger, "POST")(w, request, principal)
		}
	default:
		httpx.WriteError(w, request, h.logger, "webhook", "route", &model.Fault{Code: "not_found", Message: "Webhook resource was not found."})
	}
}

func (h *handler) scoped(request *http.Request, principal model.Principal) (webhookmodel.Owner, string, *slog.Logger, error) {
	owner := webhookmodel.Owner{Kind: webhookmodel.PersonalOwner, ID: principal.UserID}
	if value := request.PathValue("teamId"); value != "" {
		id, err := canonicalID(value)
		if err != nil {
			return owner, "", h.logger, err
		}
		owner = webhookmodel.Owner{Kind: webhookmodel.TeamOwner, ID: id}
	}
	logger := h.logger.With("user_id", principal.UserID, "owner_kind", owner.Kind, "owner_id", owner.ID)
	id := request.PathValue("endpointId")
	if id != "" {
		canonical, err := canonicalID(id)
		if err != nil {
			return owner, "", logger, err
		}
		id = canonical
		logger = logger.With("endpoint_id", id)
	}
	return owner, id, logger, nil
}

func writeError(w http.ResponseWriter, request *http.Request, logger *slog.Logger, phase string, err error) {
	facts := operation.CompletionFacts(err)
	if facts.Outcome == store.TransactionUnknown || facts.Outcome == store.TransactionCommitted {
		httpx.LogFailure(logger.With("webhook_error_code", "write_outcome_unknown"), request.Context(), "webhook", phase, err)
		httpx.WriteJSON(w, request, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: "write_outcome_unknown", Message: "The write result could not be confirmed. Query the original operation before making another write.", RequestID: httpx.RequestID(request.Context())}})
		return
	}
	if failed, _ := store.DatabaseErrorFacts(err); failed {
		httpx.LogFailure(logger.With("webhook_error_code", "dependency_unavailable"), request.Context(), "webhook", phase, err)
		httpx.WriteJSON(w, request, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: "dependency_unavailable", Message: "Webhook persistence is temporarily unavailable.", RequestID: httpx.RequestID(request.Context())}})
		return
	}
	httpx.WriteError(w, request, logger, "webhook", phase, err)
}

func (h *handler) catalog(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	if _, err := httpx.QueryValues(request); err != nil {
		writeError(w, request, h.logger, "catalog", err)
		return
	}
	result, err := h.manager.Catalog(request.Context(), principal)
	if err != nil {
		writeError(w, request, h.logger, "catalog", err)
		return
	}
	response := struct {
		Items   []webhookcore.EventDefinition `json:"items"`
		Service struct {
			ConfigurationExpansionAvailable bool `json:"configurationExpansionAvailable"`
			DispatchEnabled                 bool `json:"dispatchEnabled"`
		} `json:"service"`
		Limits struct {
			PolicyVersion                  string `json:"policyVersion"`
			EndpointLimit                  int64  `json:"endpointLimit"`
			SubscriptionsPerEndpoint       int64  `json:"subscriptionsPerEndpoint"`
			BindingsPerSubscription        int64  `json:"bindingsPerSubscription"`
			MatchedEndpointsPerProject     int64  `json:"matchedEndpointsPerProject"`
			ConfigurationRequestBytesLimit int64  `json:"configurationRequestBytesLimit"`
			OperationMaxAgeSeconds         int64  `json:"operationMaxAgeSeconds"`
			OperationFutureSkewSeconds     int64  `json:"operationFutureSkewSeconds"`
			OperationRetentionSeconds      int64  `json:"operationRetentionSeconds"`
		} `json:"limits"`
	}{Items: result.Items}
	response.Service.ConfigurationExpansionAvailable, response.Service.DispatchEnabled = result.Settings.ConfigurationExpansionAvailable, result.Settings.DispatchEnabled
	response.Limits.PolicyVersion = strconv.FormatInt(result.Policy.Version, 10)
	response.Limits.EndpointLimit, response.Limits.SubscriptionsPerEndpoint, response.Limits.BindingsPerSubscription = result.Policy.EndpointLimit, result.Policy.SubscriptionsPerEndpoint, result.Policy.BindingsPerSubscription
	response.Limits.MatchedEndpointsPerProject, response.Limits.ConfigurationRequestBytesLimit = result.Policy.MatchedEndpointsPerProject, result.Policy.ConfigurationRequestBytesLimit
	response.Limits.OperationMaxAgeSeconds, response.Limits.OperationFutureSkewSeconds, response.Limits.OperationRetentionSeconds = result.Policy.OperationMaxAgeSeconds, result.Policy.OperationFutureSkewSeconds, result.Policy.OperationRetentionSeconds
	httpx.WriteJSON(w, request, h.logger, http.StatusOK, response)
}

func listInput(request *http.Request) (webhookservice.ListInput, error) {
	values, err := httpx.QueryValues(request, "q", "enabled", "limit", "cursor")
	if err != nil {
		return webhookservice.ListInput{}, err
	}
	input := webhookservice.ListInput{Search: values.Get("q"), Limit: 50}
	if values.Has("limit") {
		input.Limit, err = strconv.Atoi(values.Get("limit"))
		if err != nil || input.Limit < 1 || input.Limit > 100 {
			return webhookservice.ListInput{}, httpx.InvalidInput("limit must be between 1 and 100.")
		}
	}
	if values.Has("enabled") {
		value := values.Get("enabled")
		if value != "true" && value != "false" {
			return webhookservice.ListInput{}, httpx.InvalidInput("enabled must be true or false.")
		}
		flag := value == "true"
		input.Enabled = &flag
	}
	if values.Has("cursor") {
		value := values.Get("cursor")
		if value == "" {
			return webhookservice.ListInput{}, httpx.InvalidInput("cursor cannot be empty.")
		}
		input.Cursor = &value
	}
	return input, nil
}

func (h *handler) list(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	owner, _, logger, err := h.scoped(request, principal)
	var input webhookservice.ListInput
	if err == nil {
		input, err = listInput(request)
	}
	if err != nil {
		writeError(w, request, logger, "list", err)
		return
	}
	result, err := h.manager.List(request.Context(), principal, owner, input)
	if err != nil {
		writeError(w, request, logger, "list", err)
		return
	}
	items := make([]endpointSummaryResponse, 0, len(result.Items))
	for _, item := range result.Items {
		items = append(items, endpointSummary(item))
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, struct {
		Items      []endpointSummaryResponse `json:"items"`
		NextCursor *string                   `json:"nextCursor"`
	}{Items: items, NextCursor: result.NextCursor})
}

func (h *handler) get(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	owner, id, logger, err := h.scoped(request, principal)
	if err == nil {
		_, err = httpx.QueryValues(request)
	}
	if err != nil {
		writeError(w, request, logger, "get", err)
		return
	}
	result, err := h.manager.Get(request.Context(), principal, owner, id)
	if err != nil {
		writeError(w, request, logger, "get", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, endpointView(result))
}

func operationModel(input operationInput) webhookcore.Operation {
	return webhookcore.Operation{ID: input.ID, IssuedAt: input.IssuedAt, ExpectedUserID: input.ExpectedUserID, RequestSHA256: input.RequestSHA256}
}

func destinationModel(input destinationInput) (webhookmodel.Destination, error) {
	version, err := webhookcore.ParseVersion(input.AdapterVersion)
	return webhookmodel.Destination{Kind: input.Kind, AdapterVersion: version, Configuration: webhookmodel.HTTPConfiguration{URL: input.URL}}, err
}

func subscriptionModels(input []subscriptionInput) []webhookcore.SubscriptionInput {
	result := make([]webhookcore.SubscriptionInput, 0, len(input))
	for _, subscription := range input {
		result = append(result, webhookcore.SubscriptionInput{ID: subscription.ID, ProjectID: subscription.ProjectID, EventTypes: subscription.EventTypes})
	}
	return result
}

func (h *handler) create(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	owner, _, logger, err := h.scoped(request, principal)
	var input createInput
	var destination webhookmodel.Destination
	if err == nil {
		input, err = parseCreate(request)
	}
	if err == nil {
		destination, err = destinationModel(input.Destination)
	}
	if err != nil {
		writeError(w, request, logger, "create", err)
		return
	}
	result, err := h.manager.Create(request.Context(), principal, owner, webhookcore.CreateInput{Operation: operationModel(input.Operation), Name: input.Name, Enabled: input.Enabled, Destination: destination, Subscriptions: subscriptionModels(input.Subscriptions)})
	if err != nil {
		writeError(w, request, logger, "create", err)
		return
	}
	status := http.StatusCreated
	if result.Replayed {
		status = http.StatusOK
	}
	writeMutation(w, request, logger, status, result)
}

func (h *handler) patch(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	owner, id, logger, err := h.scoped(request, principal)
	var parsed patchInput
	if err == nil {
		parsed, err = parsePatch(request)
	}
	input := webhookcore.PatchInput{Operation: operationModel(parsed.Operation), IfVersion: parsed.IfVersion, Name: parsed.Name, Enabled: parsed.Enabled}
	if err == nil && parsed.Destination != nil {
		value, failure := destinationModel(*parsed.Destination)
		err, input.Destination = failure, &value
	}
	if parsed.Subscriptions != nil {
		value := subscriptionModels(*parsed.Subscriptions)
		input.Subscriptions = &value
	}
	if parsed.ConfirmProjectIDs != nil {
		input.ConfirmProjectIDs = append([]string{}, (*parsed.ConfirmProjectIDs)...)
	}
	if err != nil {
		writeError(w, request, logger, "patch", err)
		return
	}
	result, err := h.manager.Patch(request.Context(), principal, owner, id, input)
	if err != nil {
		writeError(w, request, logger, "patch", err)
		return
	}
	writeMutation(w, request, logger, http.StatusOK, result)
}

func (h *handler) remove(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	owner, id, logger, err := h.scoped(request, principal)
	var input deleteInput
	if err == nil {
		input, err = parseDelete(request)
	}
	if err != nil {
		writeError(w, request, logger, "delete", err)
		return
	}
	result, err := h.manager.Delete(request.Context(), principal, owner, id, webhookcore.DeleteInput{Operation: operationModel(input.Operation), IfVersion: input.IfVersion})
	if err != nil {
		writeError(w, request, logger, "delete", err)
		return
	}
	writeMutation(w, request, logger, http.StatusOK, result)
}

func writeMutation(w http.ResponseWriter, request *http.Request, logger *slog.Logger, status int, result webhookservice.MutationResult) {
	httpx.WriteMutationJSON(w, request, logger, "webhook", status, struct {
		Operation operationResponse `json:"operation"`
		Endpoint  any               `json:"endpoint"`
	}{Operation: operationView(result.Operation), Endpoint: endpointView(result.Endpoint)})
}

func (h *handler) receipt(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	owner, _, logger, err := h.scoped(request, principal)
	var id string
	if err == nil {
		id, err = canonicalID(request.PathValue("operationId"))
	}
	if err == nil {
		_, err = httpx.QueryValues(request)
	}
	if err != nil {
		writeError(w, request, logger, "receipt", err)
		return
	}
	result, err := h.manager.Operation(request.Context(), principal, owner, id)
	if err != nil {
		writeError(w, request, logger, "receipt", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, operationView(result))
}

func (h *handler) secret(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	owner, id, logger, err := h.scoped(request, principal)
	if err == nil {
		_, err = httpx.QueryValues(request)
	}
	if err != nil {
		writeError(w, request, logger, "secret", err)
		return
	}
	result, err := h.manager.SigningSecret(request.Context(), principal, owner, id)
	if err != nil {
		writeError(w, request, logger, "secret", err)
		return
	}
	httpx.WriteJSON(w, request, logger, http.StatusOK, struct {
		EndpointID    string `json:"endpointId"`
		ConfigVersion string `json:"configVersion"`
		KeyID         string `json:"keyId"`
		Scheme        string `json:"scheme"`
		Secret        string `json:"secret"`
	}{EndpointID: result.EndpointID, ConfigVersion: strconv.FormatInt(result.ConfigVersion, 10), KeyID: result.KeyID, Scheme: signingScheme, Secret: result.Secret})
}

func (h *handler) rotate(w http.ResponseWriter, request *http.Request, principal model.Principal) {
	owner, id, logger, err := h.scoped(request, principal)
	var input rotationInput
	if err == nil {
		input, err = parseRotation(request)
	}
	if err != nil {
		writeError(w, request, logger, "rotate", err)
		return
	}
	result, err := h.manager.Rotate(request.Context(), principal, owner, id, webhookcore.RotateInput{Operation: operationModel(input.Operation), IfVersion: input.IfVersion, Mode: input.Mode})
	if err != nil {
		writeError(w, request, logger, "rotate", err)
		return
	}
	if result.Operation.KeyID == nil {
		writeError(w, request, logger, "rotate", &store.TransactionError{Phase: "response", Outcome: store.TransactionCommitted})
		return
	}
	httpx.WriteMutationJSON(w, request, logger, "webhook", http.StatusOK, struct {
		Operation operationResponse `json:"operation"`
		Signing   signingResponse   `json:"signing"`
	}{Operation: operationView(result.Operation), Signing: signingResponse{ActiveKeyID: *result.Operation.KeyID, OverlapUntil: result.Operation.SigningOverlapUntil}})
}
