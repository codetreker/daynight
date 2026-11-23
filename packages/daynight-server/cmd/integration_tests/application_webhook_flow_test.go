//go:build integration

package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

type applicationWebhookOwner struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

type applicationWebhookEventType struct {
	Key string `json:"key"`
}

type applicationWebhookSigning struct {
	ActiveKeyID  string     `json:"activeKeyId"`
	OverlapUntil *time.Time `json:"overlapUntil"`
}

type applicationWebhookEndpoint struct {
	ID                  string                    `json:"id"`
	Owner               applicationWebhookOwner   `json:"owner"`
	Lifecycle           string                    `json:"lifecycle"`
	Name                string                    `json:"name"`
	Enabled             bool                      `json:"enabled"`
	ConfigVersion       string                    `json:"configVersion"`
	DestinationRevision string                    `json:"destinationRevision"`
	Signing             applicationWebhookSigning `json:"signing"`
	Subscriptions       []struct {
		ID          string   `json:"id"`
		ProjectID   string   `json:"projectId"`
		ProjectName string   `json:"projectName"`
		EventTypes  []string `json:"eventTypes"`
		Eligibility string   `json:"eligibility"`
	} `json:"subscriptions"`
}

type applicationWebhookEndpointSummary struct {
	ID             string                  `json:"id"`
	Owner          applicationWebhookOwner `json:"owner"`
	Name           string                  `json:"name"`
	Enabled        bool                    `json:"enabled"`
	ConfigVersion  string                  `json:"configVersion"`
	ProjectCount   int                     `json:"projectCount"`
	EventTypeCount int                     `json:"eventTypeCount"`
}

type applicationWebhookOperation struct {
	OperationID        string                  `json:"operationId"`
	Kind               string                  `json:"kind"`
	ActorUserID        string                  `json:"actorUserId"`
	Owner              applicationWebhookOwner `json:"owner"`
	EndpointID         string                  `json:"endpointId"`
	Effect             string                  `json:"effect"`
	ConfigVersionAfter string                  `json:"configVersionAfter"`
	KeyID              string                  `json:"keyId"`
	OverlapUntil       *time.Time              `json:"overlapUntil"`
}

type applicationWebhookResult struct {
	Endpoint  applicationWebhookEndpoint  `json:"endpoint"`
	Operation applicationWebhookOperation `json:"operation"`
}

type applicationWebhookRotation struct {
	Operation applicationWebhookOperation `json:"operation"`
	Signing   applicationWebhookSigning   `json:"signing"`
}

type applicationWebhookSecret struct {
	EndpointID    string `json:"endpointId"`
	ConfigVersion string `json:"configVersion"`
	KeyID         string `json:"keyId"`
	Scheme        string `json:"scheme"`
	Secret        string `json:"secret"`
}

func readApplicationWebhookSecret(t *testing.T, f *fixture, path string) applicationWebhookSecret {
	t.Helper()
	request, err := http.NewRequestWithContext(f.context, http.MethodGet, f.origin+path, nil)
	if err != nil {
		t.Fatal("construct signing-secret request failed")
	}
	response, err := f.client.Do(request)
	if err != nil {
		t.Fatal("signing-secret transport failed")
	}
	data, readErr := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err := errors.Join(readErr, response.Body.Close()); err != nil || response.StatusCode != http.StatusOK {
		t.Fatal("signing-secret response failed")
	}
	var result applicationWebhookSecret
	if json.Unmarshal(data, &result) != nil {
		t.Fatal("signing-secret response did not contain its DTO")
	}
	secret, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(result.Secret, "whsec_"))
	if !strings.HasPrefix(result.Secret, "whsec_") || err != nil || len(secret) != 32 || result.Scheme != "standard-webhooks-v1" {
		t.Fatal("signing-secret response did not contain a valid key")
	}
	return result
}

func serverAPIApplicationWebhookNormalFlow(t *testing.T, f *fixture) {
	application := newApplicationFixture(t, f)
	project := createProject(t, application, "Application Webhook")
	owner := applicationWebhookOwner{Kind: "personal", ID: f.userID}
	base := "/api/v1/me/webhooks"
	catalog := requestJSON[struct {
		Items   []applicationWebhookEventType `json:"items"`
		Service struct {
			ConfigurationExpansionAvailable bool `json:"configurationExpansionAvailable"`
			DispatchEnabled                 bool `json:"dispatchEnabled"`
		} `json:"service"`
	}](t, application, http.MethodGet, "/api/v1/webhook-event-types", nil, http.StatusOK)
	if !catalog.Service.ConfigurationExpansionAvailable || !catalog.Service.DispatchEnabled || expectID(t, catalog.Items, "task.created", func(item applicationWebhookEventType) string { return item.Key }).Key != "task.created" {
		t.Fatal("application did not read the active Webhook catalog")
	}
	mutation := func(version string) map[string]any {
		fields := map[string]any{"operationId": uuid.NewString(), "issuedAt": time.Now().UTC().Format(time.RFC3339Nano), "expectedUserId": f.userID}
		if version != "" {
			fields["ifVersion"] = version
		}
		return fields
	}
	create := mutation("")
	create["name"] = "Application events"
	// Disabled endpoints are omitted from capture, so the reserved destination
	// exercises production management without sending to an external receiver.
	create["enabled"] = false
	create["destination"] = map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": "https://receiver.invalid/application"}}
	create["subscriptions"] = []any{map[string]any{"id": nil, "projectId": project.ID, "eventTypes": []string{"task.created"}}}
	created := requestJSON[applicationWebhookResult](t, application, http.MethodPost, base, create, http.StatusCreated)
	endpoint := created.Endpoint
	if endpoint.ID == "" || endpoint.Owner != owner || endpoint.Lifecycle != "active" || endpoint.Enabled || endpoint.ConfigVersion != "1" || endpoint.DestinationRevision != "1" || endpoint.Signing.ActiveKeyID == "" || len(endpoint.Subscriptions) != 1 {
		t.Fatal("application Webhook creation did not retain the owner, version or disabled state")
	}
	subscription := endpoint.Subscriptions[0]
	if subscription.ID == "" || subscription.ProjectID != project.ID || subscription.ProjectName != project.Name || subscription.Eligibility != "eligible" || !reflect.DeepEqual(subscription.EventTypes, []string{"task.created"}) {
		t.Fatal("application Webhook subscription did not retain current project eligibility")
	}
	path := base + "/" + endpoint.ID
	assertOperation := func(operation applicationWebhookOperation, fields map[string]any, kind, version string) {
		t.Helper()
		if operation.OperationID != fields["operationId"] || operation.Kind != kind || operation.ActorUserID != f.userID || operation.Owner != owner || operation.EndpointID != endpoint.ID || operation.Effect != "applied" || operation.ConfigVersionAfter != version {
			t.Fatal("application Webhook operation lost its actual actor, endpoint or version")
		}
		read := requestJSON[applicationWebhookOperation](t, application, http.MethodGet, base+"/operations/"+operation.OperationID, nil, http.StatusOK)
		if !reflect.DeepEqual(read, operation) {
			t.Fatal("application Webhook operation readback differs from the committed result")
		}
	}
	assertOperation(created.Operation, create, "endpoint.create", "1")
	if read := requestJSON[applicationWebhookEndpoint](t, f, http.MethodGet, path, nil, http.StatusOK); !reflect.DeepEqual(read, endpoint) {
		t.Fatal("native owner did not read the application's Webhook configuration")
	}
	listing := requestJSON[struct {
		Items []applicationWebhookEndpointSummary `json:"items"`
	}](t, application, http.MethodGet, base, nil, http.StatusOK)
	listed := expectID(t, listing.Items, endpoint.ID, func(item applicationWebhookEndpointSummary) string { return item.ID })
	if listed.Owner != endpoint.Owner || listed.Name != endpoint.Name || listed.Enabled != endpoint.Enabled || listed.ConfigVersion != endpoint.ConfigVersion || listed.ProjectCount != 1 || listed.EventTypeCount != 1 {
		t.Fatal("application Webhook list differs from the created endpoint")
	}
	secret := readApplicationWebhookSecret(t, application, path+"/signing-secret")
	if secret.EndpointID != endpoint.ID || secret.ConfigVersion != endpoint.ConfigVersion || secret.KeyID != endpoint.Signing.ActiveKeyID {
		t.Fatal("application signing key does not belong to the created endpoint")
	}
	update := mutation(endpoint.ConfigVersion)
	update["name"] = "Renamed application events"
	updated := requestJSON[applicationWebhookResult](t, application, http.MethodPatch, path, update, http.StatusOK)
	assertOperation(updated.Operation, update, "endpoint.patch", "2")
	if updated.Endpoint.ID != endpoint.ID || updated.Endpoint.Name != update["name"] || updated.Endpoint.ConfigVersion != "2" || !reflect.DeepEqual(updated.Endpoint.Subscriptions, endpoint.Subscriptions) {
		t.Fatal("application Webhook update lost its identity, version or subscription")
	}
	rotation := mutation(updated.Endpoint.ConfigVersion)
	rotation["mode"] = "overlap"
	rotated := requestJSON[applicationWebhookRotation](t, application, http.MethodPost, path+"/signing-secret/rotations", rotation, http.StatusOK)
	assertOperation(rotated.Operation, rotation, "signing-secret.rotate", "3")
	currentEndpoint := requestJSON[applicationWebhookEndpoint](t, application, http.MethodGet, path, nil, http.StatusOK)
	currentSecret := readApplicationWebhookSecret(t, application, path+"/signing-secret")
	if currentEndpoint.ID != endpoint.ID || currentEndpoint.Owner != owner || currentEndpoint.ConfigVersion != "3" || currentEndpoint.Enabled || !reflect.DeepEqual(currentEndpoint.Subscriptions, endpoint.Subscriptions) || currentSecret.EndpointID != endpoint.ID || currentSecret.ConfigVersion != currentEndpoint.ConfigVersion || currentSecret.KeyID != currentEndpoint.Signing.ActiveKeyID || currentSecret.KeyID == secret.KeyID || currentSecret.Secret == secret.Secret {
		t.Fatal("application signing rotation did not retain the endpoint with a new active key")
	}
	if rotated.Signing.ActiveKeyID != rotated.Operation.KeyID || rotated.Signing.ActiveKeyID != currentEndpoint.Signing.ActiveKeyID || rotated.Signing.OverlapUntil == nil || !reflect.DeepEqual(rotated.Signing.OverlapUntil, rotated.Operation.OverlapUntil) || !reflect.DeepEqual(rotated.Signing, currentEndpoint.Signing) {
		t.Fatal("application signing rotation differs from its original operation or current endpoint")
	}
	createTask(t, application, project, "Disabled Webhook event", nil)
	deliveries := requestJSON[struct {
		Items []json.RawMessage `json:"items"`
	}](t, application, http.MethodGet, path+"/deliveries", nil, http.StatusOK)
	if deliveries.Items == nil || len(deliveries.Items) != 0 {
		t.Fatal("disabled Webhook unexpectedly captured a delivery")
	}
	remove := mutation(currentEndpoint.ConfigVersion)
	deleted := requestJSON[applicationWebhookResult](t, application, http.MethodDelete, path, remove, http.StatusOK)
	assertOperation(deleted.Operation, remove, "endpoint.delete", "4")
	if deleted.Endpoint.ID != endpoint.ID || deleted.Endpoint.Lifecycle != "deleted" || deleted.Endpoint.ConfigVersion != "4" {
		t.Fatal("application Webhook deletion did not return the same endpoint tombstone")
	}
	if read := requestJSON[applicationWebhookEndpoint](t, application, http.MethodGet, path, nil, http.StatusOK); !reflect.DeepEqual(read, deleted.Endpoint) {
		t.Fatal("application Webhook tombstone readback differs")
	}
	for _, value := range []string{secret.Secret, currentSecret.Secret} {
		if strings.Contains(f.process.logs.String(), value) {
			t.Fatal("Webhook signing material appeared in Server diagnostics")
		}
	}
}
