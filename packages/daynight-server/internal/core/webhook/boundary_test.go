package webhook

import (
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func TestMalformedSelectionCannotCreateOrReplaceIdentity(t *testing.T) {
	base := CreateInput{Operation: testOperation(), Name: "Name", Destination: testDestination(), Subscriptions: []SubscriptionInput{}}
	for _, mutate := range []func(*CreateInput){
		func(input *CreateInput) { input.Name = strings.Repeat("x", 121) },
		func(input *CreateInput) { input.Name = "\xff" },
		func(input *CreateInput) { input.Subscriptions = nil },
		func(input *CreateInput) {
			input.Subscriptions = []SubscriptionInput{{ProjectID: projectID, EventTypes: []string{}}}
		},
		func(input *CreateInput) {
			input.Subscriptions = []SubscriptionInput{{ProjectID: projectID, EventTypes: []string{"task.paused", "task.paused"}}}
		},
		func(input *CreateInput) {
			input.Subscriptions = []SubscriptionInput{{ProjectID: projectID, EventTypes: []string{"unregistered.event"}}}
		},
		func(input *CreateInput) {
			input.Subscriptions = []SubscriptionInput{{ProjectID: "not-a-project", EventTypes: []string{"task.created"}}}
		},
		func(input *CreateInput) { input.ExpectedUserID = "00000000-0000-0000-0000-000000000000" },
	} {
		input := base
		mutate(&input)
		_, err := NormalizeCreate(input)
		requireCode(t, err, "invalid_input")
	}
	id := teamID
	base.Subscriptions = []SubscriptionInput{{ID: &id, ProjectID: projectID, EventTypes: []string{"task.created"}}}
	_, err := NormalizeCreate(base)
	requireCode(t, err, "invalid_input")
	selections := append(base.Subscriptions, base.Subscriptions...)
	_, err = NormalizePatch(PatchInput{Operation: testOperation(), IfVersion: 1, Subscriptions: &selections})
	requireCode(t, err, "invalid_input")
	var null []SubscriptionInput
	_, err = NormalizePatch(PatchInput{Operation: testOperation(), IfVersion: 1, Subscriptions: &null})
	requireCode(t, err, "invalid_input")
	_, err = NormalizePatch(PatchInput{Operation: testOperation(), IfVersion: 1})
	requireCode(t, err, "invalid_input")
	_, err = NormalizePatch(PatchInput{Operation: testOperation(), IfVersion: 1, ConfirmProjectIDs: []string{projectID, projectID}})
	requireCode(t, err, "invalid_input")
	base.Subscriptions = make([]SubscriptionInput, 51)
	_, err = NormalizeCreate(base)
	requireCode(t, err, "subscription_capacity")
}

func TestExpansionFencesOnlyRequiredFinalProjects(t *testing.T) {
	current := testEndpoint(t)
	current.Enabled = false
	input := PatchInput{Operation: testOperation(), IfVersion: current.ConfigVersion}
	newProject := operationID
	selections := []SubscriptionInput{{ProjectID: newProject, EventTypes: []string{"task.created"}}}
	input.Subscriptions = &selections
	enabled := true
	input.Enabled = &enabled
	if required := RequiredProjectIDs(current, input); !slices.Equal(required, []string{newProject}) || !IsExpansion(current, input) {
		t.Fatalf("removed old scope still required for enabling final selection: %v", required)
	}
	name := "Only name"
	input = PatchInput{Operation: testOperation(), IfVersion: current.ConfigVersion, Name: &name}
	if IsExpansion(current, input) || len(RequiredProjectIDs(current, input)) != 0 {
		t.Fatal("name editing unnecessarily required revoked source qualification")
	}
	currentID := current.Subscriptions[0].ID
	selections = []SubscriptionInput{{ID: &currentID, ProjectID: projectID, EventTypes: []string{"task.created"}}}
	input.Subscriptions = &selections
	if IsExpansion(current, input) {
		t.Fatal("shrinking selection was classified as expansion")
	}
	selections[0].EventTypes = []string{"task.created", "task.thread_posted"}
	if !IsExpansion(current, input) || !slices.Equal(RequiredProjectIDs(current, input), []string{projectID}) {
		t.Fatal("new event binding did not require a source fence")
	}
	_, err := PreparePatch(input, current, webhookmodel.Destination{}, managerAccess, testProjects(false), testNow)
	requireCode(t, err, "forbidden")
	input.Subscriptions = nil
	input.Enabled = &enabled
	if !slices.Equal(RequiredProjectIDs(current, input), []string{projectID}) {
		t.Fatal("enable required wrong final scopes")
	}
}

func TestQualificationCorruptionAndMissingAuthorityRemainErrors(t *testing.T) {
	endpoint := testEndpoint(t)
	input := CreateInput{Operation: testOperation(), Name: "Name", Destination: testDestination(), Subscriptions: []SubscriptionInput{{ProjectID: projectID, EventTypes: []string{"task.created"}}}}
	_, err := PrepareCreate(input, personalOwner, managerAccess, nil, testNow)
	var domainFault *model.Fault
	if err == nil || errors.As(err, &domainFault) {
		t.Fatalf("missing qualification became a default or permission denial: %v", err)
	}
	duplicate := append(testProjects(true), testProjects(true)...)
	_, err = PrepareCreate(input, personalOwner, managerAccess, duplicate, testNow)
	if err == nil {
		t.Fatal("duplicate qualification silently overwrote facts")
	}
	_, err = PrepareCreate(input, webhookmodel.Owner{Kind: webhookmodel.TeamOwner, ID: operationID}, managerAccess, testProjects(true), testNow)
	requireCode(t, err, "forbidden")
	facts := testProjects(true)[0]
	facts.ProjectID = teamID
	if _, err := EligibilityFor(personalOwner, endpoint.Subscriptions[0], facts); err == nil {
		t.Fatal("cross-project qualification was accepted")
	}
	facts = testProjects(true)[0]
	endpoint.Subscriptions[0].AuthorizationEpoch = 0
	if _, err := EligibilityFor(personalOwner, endpoint.Subscriptions[0], facts); err == nil {
		t.Fatal("invalid stored epoch became valid eligibility")
	}
	if err := ValidateOwner(webhookmodel.Owner{Kind: "unknown", ID: userID}); err == nil {
		t.Fatal("unknown owner kind became personal")
	}
}

func TestDeletedObjectAndCorruptSigningStateCannotResume(t *testing.T) {
	endpoint := testEndpoint(t)
	deleted, err := PrepareDelete(DeleteInput{Operation: testOperation(), IfVersion: endpoint.ConfigVersion}, endpoint, managerAccess, testNow)
	if err != nil {
		t.Fatal(err)
	}
	_, err = PrepareDelete(DeleteInput{Operation: testOperation(), IfVersion: deleted.Endpoint.ConfigVersion}, deleted.Endpoint, managerAccess, testNow)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("new deletion operation on tombstone succeeded: %v", err)
	}
	if keys, err := ActiveSigningKeys(deleted.Endpoint, testNow); err != nil || len(keys) != 0 {
		t.Fatalf("deleted signing secret remained available: %v", err)
	}
	endpoint.ActiveKeyID = projectID
	if _, err := ActiveSigningKeys(endpoint, testNow); err == nil {
		t.Fatal("missing current signing key silently regenerated")
	}
	endpoint = testEndpoint(t)
	expiry := testNow.Add(time.Hour)
	endpoint.SigningKeys[0].ExpiresAt = &expiry
	if _, err := ActiveSigningKeys(endpoint, testNow); err == nil {
		t.Fatal("primary signing key incorrectly used overlap expiry")
	}
	_, err = NormalizeRotation(RotateInput{Operation: testOperation(), IfVersion: 1, Mode: "unknown"})
	requireCode(t, err, "invalid_input")
}
