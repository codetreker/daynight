package webhook

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

func TestUnserializableMetadataCannotProduceACharge(t *testing.T) {
	endpoint := testEndpoint(t)
	endpoint.CreatedAt = time.Date(10000, time.January, 1, 0, 0, 0, 0, time.UTC)
	cost, err := ConfigurationCost(endpoint)
	var marshalError *json.MarshalerError
	if !errors.As(err, &marshalError) || marshalError.Unwrap() == nil {
		t.Fatalf("timestamp serialization failure lost its cause: %v", err)
	}
	if cost.Records != 0 || cost.Bytes != 0 || cost.ActiveRecords != 0 || cost.ActiveBytes != 0 {
		t.Fatalf("unserializable metadata produced an accepted charge: %#v", cost)
	}
}

func TestImpossibleCalendarAndMalformedOriginAreRejected(t *testing.T) {
	for _, timestamp := range []string{"2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-11-07T00:00:60Z"} {
		operation := testOperation()
		operation.IssuedAt = timestamp
		requireCode(t, ValidateOperation(operation), "invalid_input")
	}
	for _, raw := range []string{"http://receiver.example/path", "https://user:secret@receiver.example/path", "https://receiver.example/%zz"} {
		destination := testDestination()
		destination.Configuration.URL = raw
		origin, err := DestinationOrigin(destination)
		requireCode(t, err, "invalid_input")
		if origin != "" {
			t.Fatal("an invalid destination exposed an accepted origin")
		}
	}
}

func TestSubscriptionCanonicalizationPreservesIdentityAndMultiplicity(t *testing.T) {
	firstID, secondID := operationID, teamID
	selections := []SubscriptionInput{
		{ID: &firstID, ProjectID: projectID, EventTypes: []string{"task.paused", "task.created"}},
		{ProjectID: projectID, EventTypes: []string{"task.paused"}},
		{ID: &secondID, ProjectID: projectID, EventTypes: []string{"task.created"}},
		{ProjectID: userID, EventTypes: []string{"task.created"}},
		{ProjectID: projectID, EventTypes: []string{"task.created"}},
		{ProjectID: projectID, EventTypes: []string{"task.paused"}},
	}
	original := slices.Clone(selections)
	first, err := NormalizePatch(PatchInput{Operation: testOperation(), IfVersion: 1, Subscriptions: &selections})
	if err != nil {
		t.Fatal(err)
	}
	reversed := slices.Clone(original)
	slices.Reverse(reversed)
	second, err := NormalizePatch(PatchInput{Operation: testOperation(), IfVersion: 1, Subscriptions: &reversed})
	if err != nil {
		t.Fatal(err)
	}
	endpointID := "55555555-5555-4555-8555-555555555555"
	firstFingerprint, err := Fingerprint(webhookmodel.EndpointPatch, personalOwner, endpointID, first)
	if err != nil {
		t.Fatal(err)
	}
	secondFingerprint, err := Fingerprint(webhookmodel.EndpointPatch, personalOwner, endpointID, second)
	if err != nil || firstFingerprint != secondFingerprint {
		t.Fatalf("row order changed semantic intent: %q %q %v", firstFingerprint, secondFingerprint, err)
	}
	retained, repeatedNew := map[string]bool{}, 0
	for _, subscription := range *first.Subscriptions {
		if subscription.ID != nil {
			retained[*subscription.ID] = true
		} else if subscription.ProjectID == projectID && slices.Equal(subscription.EventTypes, []string{"task.paused"}) {
			repeatedNew++
		}
	}
	if !retained[firstID] || !retained[secondID] || len(retained) != 2 || repeatedNew != 2 {
		t.Fatal("normalization changed stable identities or coalesced distinct new rows")
	}
	if original[0].ID == nil || *original[0].ID != firstID || !slices.Equal(original[0].EventTypes, []string{"task.paused", "task.created"}) {
		t.Fatal("normalization changed the caller's original selection")
	}
	invalidID := "not-a-subscription"
	bad := []SubscriptionInput{{ID: &invalidID, ProjectID: projectID, EventTypes: []string{"task.created"}}}
	_, err = NormalizePatch(PatchInput{Operation: testOperation(), IfVersion: 1, Subscriptions: &bad})
	requireCode(t, err, "invalid_input")
}

func TestCorruptRetainedSubscriptionCannotBeReplacedSilently(t *testing.T) {
	for _, corrupt := range []func(*webhookmodel.Endpoint){
		func(endpoint *webhookmodel.Endpoint) { endpoint.Subscriptions[0].ID = "invalid-stored-id" },
		func(endpoint *webhookmodel.Endpoint) {
			endpoint.Subscriptions = append(endpoint.Subscriptions, endpoint.Subscriptions[0])
		},
	} {
		endpoint := testEndpoint(t)
		corrupt(&endpoint)
		beforeRows := len(endpoint.Subscriptions)
		removeAll := []SubscriptionInput{}
		prepared, err := PreparePatch(PatchInput{Operation: testOperation(), IfVersion: endpoint.ConfigVersion, Subscriptions: &removeAll}, endpoint, webhookmodel.Destination{}, managerAccess, nil, testNow)
		if err == nil {
			t.Fatal("stored identity corruption was silently treated as an empty collection")
		}
		if prepared.Endpoint.ID != "" || prepared.Changed || len(endpoint.Subscriptions) != beforeRows {
			t.Fatal("rejected corruption produced or installed a partial configuration")
		}
		if beforeRows == 1 {
			var cause *model.Fault
			if !errors.As(err, &cause) || cause.Code != "invalid_input" {
				t.Fatalf("stored identity failure lost its cause: %v", err)
			}
		}
	}
}

type failingEntropy struct{ err error }

func (reader failingEntropy) Read([]byte) (int, error) { return 0, reader.err }

func TestUUIDEntropyFailureCannotReturnPartialConfiguration(t *testing.T) {
	failure := errors.New("test entropy unavailable")
	defer uuid.SetRand(nil)
	input := CreateInput{Operation: testOperation(), Name: "Release", Enabled: true, Destination: testDestination(), Subscriptions: []SubscriptionInput{{ProjectID: projectID, EventTypes: []string{"task.created"}}}}
	// Fail at the endpoint, signing key, subscription and first binding identities.
	for _, prefixBytes := range []int{0, 16, 32, 48} {
		uuid.SetRand(io.MultiReader(bytes.NewReader(make([]byte, prefixBytes)), failingEntropy{err: failure}))
		prepared, err := PrepareCreate(input, personalOwner, managerAccess, testProjects(true), testNow)
		if !errors.Is(err, failure) {
			t.Fatalf("identity entropy failure lost its cause after %d bytes: %v", prefixBytes, err)
		}
		if prepared.Endpoint.ID != "" || prepared.NewSigningKeyID != "" || prepared.Destination != nil || prepared.Changed {
			t.Fatal("identity allocation failure returned an accepted partial endpoint")
		}
	}
}
