package webhook

import (
	"bytes"
	"errors"
	"math"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

const (
	userID      = "11111111-1111-4111-8111-111111111111"
	teamID      = "22222222-2222-4222-8222-222222222222"
	projectID   = "33333333-3333-4333-8333-333333333333"
	operationID = "44444444-4444-4444-8444-444444444444"
)

var testNow = time.Date(2026, 11, 7, 0, 0, 0, 123456789, time.UTC)
var personalOwner = webhookmodel.Owner{Kind: webhookmodel.PersonalOwner, ID: userID}
var managerAccess = webhookmodel.OwnerAccess{CanRead: true, CanManage: true}

func testOperation() Operation {
	return Operation{ID: operationID, IssuedAt: testNow.Format(time.RFC3339Nano), ExpectedUserID: userID, RequestSHA256: strings.Repeat("a", 64)}
}

func testDestination() webhookmodel.Destination {
	return webhookmodel.Destination{Kind: "http", AdapterVersion: 1, Configuration: webhookmodel.HTTPConfiguration{URL: "https://receiver.example/secret/path?token=private"}}
}

func testProjects(read bool) []webhookmodel.ProjectAccess {
	name := "Project"
	return []webhookmodel.ProjectAccess{{ProjectID: projectID, ProjectName: &name, OwnerTeamID: teamID, Present: true, CanRead: read}}
}

func testEndpoint(t *testing.T) webhookmodel.Endpoint {
	t.Helper()
	prepared, err := PrepareCreate(CreateInput{Operation: testOperation(), Name: "Release", Enabled: true, Destination: testDestination(), Subscriptions: []SubscriptionInput{{ProjectID: projectID, EventTypes: []string{"task.created", "task.paused"}}}}, personalOwner, managerAccess, testProjects(true), testNow)
	if err != nil {
		t.Fatal(err)
	}
	prepared.Endpoint.EncryptedDestination = []byte("encrypted destination")
	prepared.Endpoint.SigningKeys[0].EncryptedSecret = []byte("encrypted signing key")
	return prepared.Endpoint
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != code {
		t.Fatalf("got %v; want fault %q", err, code)
	}
}

func TestInputNormalizationAndFingerprint(t *testing.T) {
	input := CreateInput{Operation: testOperation(), Name: "  发布  ", Destination: testDestination(), Subscriptions: []SubscriptionInput{{ProjectID: projectID, EventTypes: []string{"task.paused", "task.created"}}}}
	normalized, err := NormalizeCreate(input)
	if err != nil || normalized.Name != "发布" || !slices.Equal(normalized.Subscriptions[0].EventTypes, []string{"task.created", "task.paused"}) {
		t.Fatalf("normalized %#v: %v", normalized, err)
	}
	first, err := Fingerprint(webhookmodel.EndpointCreate, personalOwner, "", normalized)
	if err != nil {
		t.Fatal(err)
	}
	normalized.RequestSHA256 = strings.Repeat("b", 64)
	second, err := Fingerprint(webhookmodel.EndpointCreate, personalOwner, "", normalized)
	if err != nil || first != second {
		t.Fatalf("actual-byte hash changed semantic fingerprint: %s %s %v", first, second, err)
	}
	normalized.IssuedAt = "2026-11-07T00:00:00.123456789+00:00"
	third, err := Fingerprint(webhookmodel.EndpointCreate, personalOwner, "", normalized)
	if err != nil || third == first {
		t.Fatal("original issuedAt lexeme must participate in immutable intent")
	}
	if slices.Equal(input.Subscriptions[0].EventTypes, normalized.Subscriptions[0].EventTypes) {
		t.Fatal("normalization changed caller's event selection")
	}
	catalog := Catalog()
	catalog[0].Key = "modified"
	if Catalog()[0].Key != "task.created" || RegisteredEvent("modified") || !RegisteredEvent("task.thread_posted") || len(Catalog()) != 6 {
		t.Fatal("event catalog is not independently owned")
	}
}

func TestVersionAndOperationTimeBoundaries(t *testing.T) {
	for _, value := range []string{"", "0", "01", "+1", "-1", "1.0", "9223372036854775808"} {
		_, err := ParseVersion(value)
		requireCode(t, err, "invalid_input")
	}
	if version, err := ParseVersion("9007199254740993"); err != nil || version != 9007199254740993 {
		t.Fatalf("large exact version %d: %v", version, err)
	}
	policy := webhookmodel.DefaultPolicy()
	for _, offset := range []time.Duration{-5 * time.Minute, time.Minute} {
		operation := testOperation()
		operation.IssuedAt = testNow.Add(offset).Format(time.RFC3339Nano)
		if err := CheckOperationTime(operation, testNow, policy); err != nil {
			t.Fatalf("boundary %v: %v", offset, err)
		}
	}
	operation := testOperation()
	operation.IssuedAt = testNow.Add(-5*time.Minute - time.Nanosecond).Format(time.RFC3339Nano)
	requireCode(t, CheckOperationTime(operation, testNow, policy), "operation_expired")
	operation.IssuedAt = testNow.Add(time.Minute + time.Nanosecond).Format(time.RFC3339Nano)
	requireCode(t, CheckOperationTime(operation, testNow, policy), "invalid_operation_time")
	for _, value := range []string{"2026-11-07T00:00:00+01:00", "2026-11-07T00:00:00.1234567890Z", "2026-11-07T00:00:00,123Z", "2026-11-07T00:00:00-00:00", "bad"} {
		operation.IssuedAt = value
		requireCode(t, ValidateOperation(operation), "invalid_input")
	}
	operation = testOperation()
	operation.RequestSHA256 = strings.Repeat("A", 64)
	requireCode(t, ValidateOperation(operation), "invalid_input")
	policy.ManualAttemptLimit++
	if err := ValidatePolicy(policy); err == nil {
		t.Fatal("unsupported policy must fail visibly")
	}
}

func TestDestinationValidationAndOriginRedaction(t *testing.T) {
	for _, value := range []string{"http://receiver.example/path", "https://user:secret@receiver.example/path", "https://receiver.example/path#fragment", "https://receiver.example/path#", "https://receiver.example:0/path", "https://receiver.example:65536/path", "https://receiver.example/\n", "https://receiver.example/" + strings.Repeat("x", 4096)} {
		destination := testDestination()
		destination.Configuration.URL = value
		requireCode(t, ValidateDestination(destination), "invalid_input")
	}
	destination := testDestination()
	origin, err := DestinationOrigin(destination)
	if err != nil || origin != "https://receiver.example" || strings.Contains(origin, "secret") || strings.Contains(origin, "token") {
		t.Fatalf("origin leaked private destination: %q %v", origin, err)
	}
	destination.Kind = "platform"
	requireCode(t, ValidateDestination(destination), "destination_unsupported")
	input := CreateInput{Operation: testOperation(), Name: "name\n", Destination: testDestination()}
	_, err = NormalizeCreate(input)
	requireCode(t, err, "invalid_input")
}

func TestScopeAuthorityAndOriginalReceiptBinding(t *testing.T) {
	requireCode(t, RequireOwner(personalOwner, teamID, managerAccess, true), "forbidden")
	requireCode(t, RequireOwner(webhookmodel.Owner{Kind: webhookmodel.TeamOwner, ID: teamID}, userID, webhookmodel.OwnerAccess{CanRead: true}, true), "forbidden")
	op := testOperation()
	receipt := webhookmodel.OperationReceipt{OperationID: op.ID, Kind: webhookmodel.EndpointCreate, IssuedAt: op.IssuedAt, RequestSHA256: op.RequestSHA256, Fingerprint: "fingerprint", ActorUserID: userID, Owner: personalOwner, EndpointID: teamID}
	if err := MatchReceipt(receipt, op, webhookmodel.EndpointCreate, personalOwner, "", "fingerprint"); err != nil {
		t.Fatal(err)
	}
	if err := RequireReceiptRead(personalOwner, userID, managerAccess, receipt); err != nil {
		t.Fatal(err)
	}
	receipt.IssuedAt = "2026-11-07T00:00:00Z"
	requireCode(t, MatchReceipt(receipt, op, webhookmodel.EndpointCreate, personalOwner, "", "fingerprint"), "operation_conflict")
	teamOwner := webhookmodel.Owner{Kind: webhookmodel.TeamOwner, ID: teamID}
	receipt.Owner, receipt.ActorUserID = teamOwner, projectID
	requireCode(t, RequireReceiptRead(teamOwner, userID, webhookmodel.OwnerAccess{CanRead: true}, receipt), "forbidden")
	if err := RequireReceiptRead(teamOwner, userID, managerAccess, receipt); err != nil {
		t.Fatal(err)
	}
}

func TestSubscriptionIdentityAndBindingHistory(t *testing.T) {
	initial := testEndpoint(t)
	oldSubscription := initial.Subscriptions[0]
	oldEvents := activeEvents(oldSubscription)
	keepID := oldSubscription.ID
	selections := []SubscriptionInput{{ID: &keepID, ProjectID: projectID, EventTypes: []string{"task.paused"}}}
	prepared, err := PreparePatch(PatchInput{Operation: testOperation(), IfVersion: initial.ConfigVersion, Subscriptions: &selections}, initial, webhookmodel.Destination{}, managerAccess, testProjects(false), testNow.Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if !prepared.Changed || prepared.Endpoint.DestinationRevision != initial.DestinationRevision || prepared.Endpoint.Subscriptions[0].ID != keepID || prepared.Endpoint.Subscriptions[0].Bindings[0].ID != initial.Subscriptions[0].Bindings[0].ID {
		t.Fatal("shrinking a revoked scope changed retained subscription identity")
	}
	if len(activeEvents(initial.Subscriptions[0])) != 2 || len(oldEvents) != 2 {
		t.Fatal("patch mutated the old endpoint")
	}
	removedID := ""
	for _, binding := range prepared.Endpoint.Subscriptions[0].Bindings {
		if binding.EventType == "task.created" {
			removedID = binding.ID
			if binding.DeletedAt == nil {
				t.Fatal("removed binding was not retained as retired proof")
			}
		}
	}
	selections[0].EventTypes = []string{"task.created", "task.paused"}
	restored, err := PreparePatch(PatchInput{Operation: testOperation(), IfVersion: prepared.Endpoint.ConfigVersion, Subscriptions: &selections}, prepared.Endpoint, webhookmodel.Destination{}, managerAccess, testProjects(true), testNow.Add(2*time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if len(restored.Endpoint.Subscriptions[0].Bindings) != 3 {
		t.Fatal("binding history was discarded")
	}
	for _, binding := range restored.Endpoint.Subscriptions[0].Bindings {
		if binding.EventType == "task.created" && binding.DeletedAt == nil && binding.ID == removedID {
			t.Fatal("readded binding inherited retired identity")
		}
	}
	freshSelection := []SubscriptionInput{{ProjectID: projectID, EventTypes: []string{"task.created", "task.paused"}}}
	replaced, err := PreparePatch(PatchInput{Operation: testOperation(), IfVersion: restored.Endpoint.ConfigVersion, Subscriptions: &freshSelection}, restored.Endpoint, webhookmodel.Destination{}, managerAccess, testProjects(true), testNow.Add(3*time.Minute))
	if err != nil || len(replaced.Endpoint.Subscriptions) != 2 || replaced.Endpoint.Subscriptions[0].DeletedAt == nil || replaced.Endpoint.Subscriptions[1].ID == keepID {
		t.Fatalf("replacement reused old subscription: %#v %v", replaced.Endpoint.Subscriptions, err)
	}
	selections[0].ProjectID = teamID
	_, err = PreparePatch(PatchInput{Operation: testOperation(), IfVersion: initial.ConfigVersion, Subscriptions: &selections}, initial, webhookmodel.Destination{}, managerAccess, testProjects(true), testNow)
	requireCode(t, err, "invalid_input")
}

func TestRevokedCleanupAndExplicitConfirmation(t *testing.T) {
	initial := testEndpoint(t)
	initial.Subscriptions[0].AuthorizationState = webhookmodel.AuthorizationConfirmationRequired
	initial.Subscriptions[0].AuthorizationEpoch = 7
	name := "Renamed"
	patched, err := PreparePatch(PatchInput{Operation: testOperation(), IfVersion: initial.ConfigVersion, Name: &name}, initial, webhookmodel.Destination{}, managerAccess, testProjects(false), testNow.Add(time.Minute))
	if err != nil || patched.Endpoint.Subscriptions[0].AuthorizationState != webhookmodel.AuthorizationConfirmationRequired {
		t.Fatalf("name edit implicitly confirmed revoked scope: %v", err)
	}
	confirmed, err := PreparePatch(PatchInput{Operation: testOperation(), IfVersion: initial.ConfigVersion, ConfirmProjectIDs: []string{projectID}}, initial, webhookmodel.Destination{}, managerAccess, testProjects(true), testNow.Add(time.Minute))
	if err != nil || !confirmed.Changed || confirmed.Endpoint.Subscriptions[0].AuthorizationState != webhookmodel.AuthorizationActive || confirmed.Endpoint.Subscriptions[0].AuthorizationEpoch != 7 {
		t.Fatalf("explicit confirmation changed the old epoch: %#v %v", confirmed, err)
	}
	again, err := PreparePatch(PatchInput{Operation: testOperation(), IfVersion: confirmed.Endpoint.ConfigVersion, ConfirmProjectIDs: []string{projectID}}, confirmed.Endpoint, webhookmodel.Destination{}, managerAccess, testProjects(true), testNow.Add(2*time.Minute))
	if err != nil || again.Changed || again.Endpoint.ConfigVersion != confirmed.Endpoint.ConfigVersion || again.Endpoint.Subscriptions[0].Bindings[0].ID != initial.Subscriptions[0].Bindings[0].ID {
		t.Fatalf("redundant confirmation mutated valid proof: %#v %v", again, err)
	}
	paused := false
	stopped, err := PreparePatch(PatchInput{Operation: testOperation(), IfVersion: initial.ConfigVersion, Enabled: &paused}, initial, webhookmodel.Destination{}, managerAccess, testProjects(false), testNow)
	if err != nil {
		t.Fatal(err)
	}
	enabled := true
	_, err = PreparePatch(PatchInput{Operation: testOperation(), IfVersion: stopped.Endpoint.ConfigVersion, Enabled: &enabled}, stopped.Endpoint, webhookmodel.Destination{}, managerAccess, testProjects(false), testNow)
	requireCode(t, err, "forbidden")
	deleted, err := PrepareDelete(DeleteInput{Operation: testOperation(), IfVersion: initial.ConfigVersion}, initial, managerAccess, testNow)
	if err != nil || deleted.Endpoint.DeletedAt == nil || deleted.Endpoint.ActiveKeyID != "" || len(deleted.Endpoint.SigningKeys) != 0 || len(deleted.Endpoint.EncryptedDestination) != 0 || deleted.Endpoint.Subscriptions[0].DeletedAt == nil {
		t.Fatalf("cleanup failed with revoked resources: %#v %v", deleted, err)
	}
}

func TestNoOpStaleVersionAndDestinationRevision(t *testing.T) {
	initial := testEndpoint(t)
	name := initial.Name
	unchanged, err := PreparePatch(PatchInput{Operation: testOperation(), IfVersion: initial.ConfigVersion, Name: &name}, initial, webhookmodel.Destination{}, managerAccess, nil, testNow.Add(time.Minute))
	if err != nil || unchanged.Changed || unchanged.Endpoint.ConfigVersion != initial.ConfigVersion || !unchanged.Endpoint.UpdatedAt.Equal(initial.UpdatedAt) {
		t.Fatalf("same-value edit changed configuration: %#v %v", unchanged, err)
	}
	_, err = PreparePatch(PatchInput{Operation: testOperation(), IfVersion: initial.ConfigVersion + 1, Name: &name}, initial, webhookmodel.Destination{}, managerAccess, nil, testNow)
	requireCode(t, err, "version_conflict")
	name = "Different"
	renamed, err := PreparePatch(PatchInput{Operation: testOperation(), IfVersion: initial.ConfigVersion, Name: &name}, initial, webhookmodel.Destination{}, managerAccess, nil, testNow)
	if err != nil || renamed.Endpoint.DestinationRevision != initial.DestinationRevision {
		t.Fatalf("name changed destination revision: %v", err)
	}
	destination := testDestination()
	sameDestination, err := PreparePatch(PatchInput{Operation: testOperation(), IfVersion: initial.ConfigVersion, Destination: &destination}, initial, testDestination(), managerAccess, nil, testNow)
	if err != nil || sameDestination.Changed || sameDestination.Destination != nil {
		t.Fatalf("same destination created new revision: %v", err)
	}
	destination.Configuration.URL = "https://other.example/new"
	changed, err := PreparePatch(PatchInput{Operation: testOperation(), IfVersion: initial.ConfigVersion, Destination: &destination}, initial, testDestination(), managerAccess, nil, testNow)
	if err != nil || changed.Endpoint.DestinationRevision != initial.DestinationRevision+1 || changed.Destination == nil || len(changed.Endpoint.EncryptedDestination) != 0 {
		t.Fatalf("changed destination reused old cipher/revision: %v", err)
	}
	initial.ConfigVersion = math.MaxInt64
	_, err = PreparePatch(PatchInput{Operation: testOperation(), IfVersion: math.MaxInt64, Name: &name}, initial, webhookmodel.Destination{}, managerAccess, nil, testNow)
	if err == nil {
		t.Fatal("version overflow must fail")
	}
}

func TestSigningOverlapAndResourceBoundAAD(t *testing.T) {
	initial := testEndpoint(t)
	rotated, err := PrepareRotation(RotateInput{Operation: testOperation(), IfVersion: initial.ConfigVersion, Mode: "overlap"}, initial, managerAccess, testNow)
	if err != nil || len(rotated.Endpoint.SigningKeys) != 2 || rotated.Endpoint.DestinationRevision != initial.DestinationRevision || rotated.NewSigningKeyID == initial.ActiveKeyID {
		t.Fatalf("rotation failed: %#v %v", rotated, err)
	}
	_, err = PrepareRotation(RotateInput{Operation: testOperation(), IfVersion: rotated.Endpoint.ConfigVersion, Mode: "overlap"}, rotated.Endpoint, managerAccess, testNow.Add(time.Hour))
	requireCode(t, err, "resource_conflict")
	immediate, err := PrepareRotation(RotateInput{Operation: testOperation(), IfVersion: rotated.Endpoint.ConfigVersion, Mode: "immediate"}, rotated.Endpoint, managerAccess, testNow.Add(time.Hour))
	if err != nil || len(immediate.Endpoint.SigningKeys) != 1 {
		t.Fatalf("immediate rotation retained old overlap: %v", err)
	}
	expired, err := PrepareRotation(RotateInput{Operation: testOperation(), IfVersion: rotated.Endpoint.ConfigVersion, Mode: "overlap"}, rotated.Endpoint, managerAccess, testNow.Add(24*time.Hour))
	if err != nil || len(expired.Endpoint.SigningKeys) != 2 {
		t.Fatalf("expired overlap blocked rotation: %v", err)
	}
	first, err := EndpointAssociatedData(initial)
	if err != nil {
		t.Fatal(err)
	}
	other := initial
	other.DestinationRevision++
	second, err := EndpointAssociatedData(other)
	if err != nil || bytes.Equal(first, second) {
		t.Fatal("destination revision did not change authenticated context")
	}
	third, err := SigningAssociatedData(initial, initial.ActiveKeyID)
	if err != nil || bytes.Equal(first, third) {
		t.Fatal("record purpose did not change authenticated context")
	}
	if _, err := AssociatedData(personalOwner, initial.ID, "invalid", "1"); err == nil {
		t.Fatal("unsupported encrypted record purpose must fail")
	}
}

func TestEligibilityAndConfigurationCost(t *testing.T) {
	endpoint := testEndpoint(t)
	subscription := endpoint.Subscriptions[0]
	facts := testProjects(true)[0]
	eligibility, err := EligibilityFor(personalOwner, subscription, facts)
	if err != nil || eligibility != webhookmodel.Eligible {
		t.Fatalf("eligible: %q %v", eligibility, err)
	}
	subscription.AuthorizationState = webhookmodel.AuthorizationConfirmationRequired
	eligibility, err = EligibilityFor(personalOwner, subscription, facts)
	if err != nil || eligibility != webhookmodel.ConfirmationRequired {
		t.Fatal("regained access implicitly became eligible")
	}
	facts.CanRead = false
	eligibility, _ = EligibilityFor(personalOwner, subscription, facts)
	if eligibility != webhookmodel.AccessRevoked {
		t.Fatal("current access loss was hidden")
	}
	facts.Present = false
	eligibility, _ = EligibilityFor(personalOwner, subscription, facts)
	if eligibility != webhookmodel.ResourceUnavailable {
		t.Fatal("missing resource was hidden")
	}
	facts = testProjects(true)[0]
	eligibility, _ = EligibilityFor(webhookmodel.Owner{Kind: webhookmodel.TeamOwner, ID: userID}, subscription, facts)
	if eligibility != webhookmodel.OwnerScopeChanged {
		t.Fatal("ownership transfer was hidden")
	}
	cost, err := ConfigurationCost(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if cost.Records != 5 || cost.Bytes != 5*(2<<10)+int64(len(endpoint.EncryptedDestination)+len(endpoint.SigningKeys[0].EncryptedSecret)) || cost.ActiveRecords != cost.Records {
		t.Fatalf("configuration byte accounting: %#v", cost)
	}
	deleted, err := PrepareDelete(DeleteInput{Operation: testOperation(), IfVersion: endpoint.ConfigVersion}, endpoint, managerAccess, testNow)
	if err != nil {
		t.Fatal(err)
	}
	retained, err := ConfigurationCost(deleted.Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	if retained.Records != 4 || retained.ActiveRecords != 0 || retained.ActiveBytes != 0 {
		t.Fatalf("retired proof accounting: %#v", retained)
	}
	delta := CostDifference(retained, cost)
	if delta.Records != -1 || delta.ActiveRecords != -5 {
		t.Fatalf("configuration transition cost: %#v", delta)
	}
}
