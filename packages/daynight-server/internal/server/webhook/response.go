package webhook

import (
	"strconv"
	"time"

	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

const signingScheme = "standard-webhooks-v1"

type destinationResponse struct {
	Kind           string  `json:"kind"`
	AdapterVersion string  `json:"adapterVersion"`
	URL            *string `json:"url"`
	DisplayURL     string  `json:"displayUrl"`
}

type signingResponse struct {
	ActiveKeyID  string     `json:"activeKeyId"`
	OverlapUntil *time.Time `json:"overlapUntil"`
}

type endpointSigningResponse struct {
	Scheme string `json:"scheme"`
	signingResponse
}

type capabilitiesResponse struct {
	Manage     bool `json:"manage"`
	ReadSecret bool `json:"readSecret"`
	Redeliver  bool `json:"redeliver"`
}

type subscriptionResponse struct {
	ID          string                   `json:"id"`
	ProjectID   string                   `json:"projectId"`
	ProjectName *string                  `json:"projectName"`
	EventTypes  []string                 `json:"eventTypes"`
	Eligibility webhookmodel.Eligibility `json:"eligibility"`
}

type endpointResponse struct {
	ID                  string                  `json:"id"`
	Owner               webhookmodel.Owner      `json:"owner"`
	Lifecycle           string                  `json:"lifecycle"`
	Name                string                  `json:"name"`
	Enabled             bool                    `json:"enabled"`
	ConfigVersion       string                  `json:"configVersion"`
	DestinationRevision string                  `json:"destinationRevision"`
	Destination         destinationResponse     `json:"destination"`
	Signing             endpointSigningResponse `json:"signing"`
	Subscriptions       []subscriptionResponse  `json:"subscriptions"`
	Capabilities        capabilitiesResponse    `json:"capabilities"`
	CreatedAt           time.Time               `json:"createdAt"`
	UpdatedAt           time.Time               `json:"updatedAt"`
	DeletedAt           *time.Time              `json:"deletedAt"`
}

type deletedEndpointResponse struct {
	ID            string             `json:"id"`
	Owner         webhookmodel.Owner `json:"owner"`
	Lifecycle     string             `json:"lifecycle"`
	ConfigVersion string             `json:"configVersion"`
	DeletedAt     *time.Time         `json:"deletedAt"`
}

type endpointSummaryResponse struct {
	ID             string              `json:"id"`
	Owner          webhookmodel.Owner  `json:"owner"`
	Name           string              `json:"name"`
	Enabled        bool                `json:"enabled"`
	ConfigVersion  string              `json:"configVersion"`
	Destination    destinationResponse `json:"destination"`
	ProjectCount   int                 `json:"projectCount"`
	EventTypeCount int                 `json:"eventTypeCount"`
	LastResult     any                 `json:"lastResult"`
	LastResultAt   *time.Time          `json:"lastResultAt"`
	CreatedAt      time.Time           `json:"createdAt"`
	UpdatedAt      time.Time           `json:"updatedAt"`
}

type operationResponse struct {
	OperationID              string                       `json:"operationId"`
	Kind                     webhookmodel.OperationKind   `json:"kind"`
	IssuedAt                 string                       `json:"issuedAt"`
	RequestSHA256            string                       `json:"requestSha256"`
	ActorUserID              string                       `json:"actorUserId"`
	Owner                    webhookmodel.Owner           `json:"owner"`
	EndpointID               string                       `json:"endpointId"`
	Effect                   webhookmodel.OperationEffect `json:"effect"`
	ConfigVersionAfter       string                       `json:"configVersionAfter"`
	DestinationRevisionAfter string                       `json:"destinationRevisionAfter"`
	DeliveryID               *string                      `json:"deliveryId"`
	GenerationAfter          *string                      `json:"generationAfter"`
	KeyID                    *string                      `json:"keyId"`
	RecordedAt               time.Time                    `json:"recordedAt"`
	ExpiresAt                time.Time                    `json:"expiresAt"`
}

func operationView(receipt webhookmodel.OperationReceipt) operationResponse {
	var generation *string
	if receipt.GenerationAfter != nil {
		value := strconv.FormatInt(*receipt.GenerationAfter, 10)
		generation = &value
	}
	return operationResponse{OperationID: receipt.OperationID, Kind: receipt.Kind, IssuedAt: receipt.IssuedAt, RequestSHA256: receipt.RequestSHA256, ActorUserID: receipt.ActorUserID, Owner: receipt.Owner,
		EndpointID: receipt.EndpointID, Effect: receipt.Effect, ConfigVersionAfter: strconv.FormatInt(receipt.ConfigVersionAfter, 10), DestinationRevisionAfter: strconv.FormatInt(receipt.DestinationRevisionAfter, 10),
		DeliveryID: receipt.DeliveryID, GenerationAfter: generation, KeyID: receipt.KeyID, RecordedAt: receipt.RecordedAt.UTC(), ExpiresAt: receipt.ExpiresAt.UTC()}
}

func destinationView(result webhookservice.EndpointResult) destinationResponse {
	endpoint := result.Endpoint
	response := destinationResponse{Kind: endpoint.DestinationKind, AdapterVersion: strconv.FormatInt(endpoint.AdapterVersion, 10), DisplayURL: endpoint.DestinationOrigin + "/…"}
	if result.Access.CanManage && result.Destination != nil {
		value := result.Destination.Configuration.URL
		response.URL, response.DisplayURL = &value, value
	}
	return response
}

func endpointView(result webhookservice.EndpointResult) any {
	endpoint := result.Endpoint
	if endpoint.DeletedAt != nil {
		return deletedEndpointResponse{ID: endpoint.ID, Owner: endpoint.Owner, Lifecycle: "deleted", ConfigVersion: strconv.FormatInt(endpoint.ConfigVersion, 10), DeletedAt: endpoint.DeletedAt}
	}
	subscriptions := make([]subscriptionResponse, 0, len(result.Subscriptions))
	for _, item := range result.Subscriptions {
		events := []string{}
		for _, binding := range item.Subscription.Bindings {
			if binding.DeletedAt == nil {
				events = append(events, binding.EventType)
			}
		}
		subscriptions = append(subscriptions, subscriptionResponse{ID: item.Subscription.ID, ProjectID: item.Subscription.ProjectID, ProjectName: item.ProjectName, EventTypes: events, Eligibility: item.Eligibility})
	}
	return endpointResponse{ID: endpoint.ID, Owner: endpoint.Owner, Lifecycle: "active", Name: endpoint.Name, Enabled: endpoint.Enabled, ConfigVersion: strconv.FormatInt(endpoint.ConfigVersion, 10),
		DestinationRevision: strconv.FormatInt(endpoint.DestinationRevision, 10), Destination: destinationView(result), Signing: endpointSigningResponse{Scheme: signingScheme, signingResponse: signingResponse{ActiveKeyID: endpoint.ActiveKeyID, OverlapUntil: result.OverlapUntil}},
		Subscriptions: subscriptions, Capabilities: capabilitiesResponse{Manage: result.Access.CanManage, ReadSecret: result.Access.CanManage}, CreatedAt: endpoint.CreatedAt.UTC(), UpdatedAt: endpoint.UpdatedAt.UTC(), DeletedAt: nil}
}

func endpointSummary(result webhookservice.EndpointResult) endpointSummaryResponse {
	endpoint := result.Endpoint
	projects := make(map[string]struct{})
	events := make(map[string]struct{})
	for _, subscription := range result.Subscriptions {
		projects[subscription.Subscription.ProjectID] = struct{}{}
		for _, binding := range subscription.Subscription.Bindings {
			if binding.DeletedAt == nil {
				events[binding.EventType] = struct{}{}
			}
		}
	}
	return endpointSummaryResponse{ID: endpoint.ID, Owner: endpoint.Owner, Name: endpoint.Name, Enabled: endpoint.Enabled, ConfigVersion: strconv.FormatInt(endpoint.ConfigVersion, 10), Destination: destinationView(result),
		ProjectCount: len(projects), EventTypeCount: len(events), LastResult: nil, LastResultAt: nil, CreatedAt: endpoint.CreatedAt.UTC(), UpdatedAt: endpoint.UpdatedAt.UTC()}
}
