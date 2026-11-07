package webhook

import (
	"strings"
	"testing"

	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func TestFixedEnvelopeRejectsOversizedDestinationOrigin(t *testing.T) {
	endpoint := testEndpoint(t)
	input := CreateInput{Operation: testOperation(), Name: endpoint.Name, Enabled: endpoint.Enabled, Destination: testDestination(), Subscriptions: []SubscriptionInput{}}
	input.Destination.Configuration.URL = "https://" + strings.Repeat("a", 1400)
	valid, err := PrepareCreate(input, personalOwner, managerAccess, nil, testNow)
	if err != nil {
		t.Fatal(err)
	}
	metadataSize, err := metadataBytes(endpointRecordMetadata(valid.Endpoint))
	if err != nil || metadataSize < 1792 || metadataSize > 2048 {
		t.Fatalf("valid fixture is not near the metadata envelope: %d %v", metadataSize, err)
	}
	if cost, err := ConfigurationCost(valid.Endpoint); err != nil || cost.Bytes < metadataSize {
		t.Fatalf("metadata was charged below its actual envelope: %#v %v", cost, err)
	}
	input.Destination.Configuration.URL = "https://" + strings.Repeat("a", 1800)
	if err := ValidateDestination(input.Destination); err != nil {
		t.Fatalf("fixture should satisfy the independent URL limit: %v", err)
	}
	_, err = PrepareCreate(input, personalOwner, managerAccess, nil, testNow)
	requireCode(t, err, "invalid_input")
	input.Destination.Configuration.URL = "https://" + strings.Repeat("a", 4088)
	if len(input.Destination.Configuration.URL) != 4096 || ValidateDestination(input.Destination) != nil {
		t.Fatal("regression fixture must exercise a valid maximum-length structural URL")
	}
	_, err = PrepareCreate(input, personalOwner, managerAccess, nil, testNow)
	requireCode(t, err, "invalid_input")

	endpoint.DestinationOrigin = input.Destination.Configuration.URL
	_, err = ConfigurationCost(endpoint)
	requireCode(t, err, "invalid_input")
}

func TestMaximumURLPathAndQueryAreChargedAsCiphertext(t *testing.T) {
	input := CreateInput{Operation: testOperation(), Name: "Release", Enabled: true, Destination: testDestination(), Subscriptions: []SubscriptionInput{}}
	prefix := "https://receiver.example/"
	for _, url := range []string{
		prefix + strings.Repeat("a", 4096-len(prefix)),
		prefix + "?token=" + strings.Repeat("a", 4096-len(prefix)-len("?token=")),
	} {
		input.Destination.Configuration.URL = url
		prepared, err := PrepareCreate(input, personalOwner, managerAccess, nil, testNow)
		if err != nil || len(url) != 4096 || prepared.Endpoint.DestinationOrigin != "https://receiver.example" {
			t.Fatalf("bounded metadata incorrectly shortened URL capability: %v", err)
		}
		prepared.Endpoint.EncryptedDestination = []byte(strings.Repeat("x", 6000))
		cost, err := ConfigurationCost(prepared.Endpoint)
		if err != nil || cost.Bytes != cost.Records*2048+6000 {
			t.Fatalf("opaque destination bytes were not charged exactly: %#v %v", cost, err)
		}
	}
}

func TestEveryConfigurationRowProvesItsMetadataEnvelope(t *testing.T) {
	for _, fixture := range []struct {
		name   string
		mutate func(*webhookmodel.Endpoint)
	}{
		{"endpoint", func(endpoint *webhookmodel.Endpoint) { endpoint.Name = strings.Repeat("a", 2048) }},
		{"subscription", func(endpoint *webhookmodel.Endpoint) { endpoint.Subscriptions[0].ProjectID = strings.Repeat("a", 2048) }},
		{"binding", func(endpoint *webhookmodel.Endpoint) {
			endpoint.Subscriptions[0].Bindings[0].EventType = strings.Repeat("a", 2048)
		}},
		{"signing key", func(endpoint *webhookmodel.Endpoint) { endpoint.SigningKeys[0].ID = strings.Repeat("a", 2048) }},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			endpoint := testEndpoint(t)
			fixture.mutate(&endpoint)
			cost, err := ConfigurationCost(endpoint)
			requireCode(t, err, "invalid_input")
			if cost.Records != 0 || cost.Bytes != 0 {
				t.Fatal("oversized metadata produced an accepted partial charge")
			}
		})
	}
}

func TestPreparedPatchCannotInstallAnUnchargedOrigin(t *testing.T) {
	endpoint := testEndpoint(t)
	destination := testDestination()
	destination.Configuration.URL = "https://" + strings.Repeat("a", 4088)
	_, err := PreparePatch(PatchInput{Operation: testOperation(), IfVersion: endpoint.ConfigVersion, Destination: &destination}, endpoint, testDestination(), managerAccess, nil, testNow)
	requireCode(t, err, "invalid_input")
	if endpoint.DestinationRevision != 1 || endpoint.DestinationOrigin != "https://receiver.example" {
		t.Fatal("rejected metadata modified the previous endpoint")
	}
}
