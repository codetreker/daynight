package webhook

import (
	"bytes"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func TestFingerprintBindsOwnerTargetKindAndVersion(t *testing.T) {
	endpoint := testEndpoint(t)
	input := PatchInput{Operation: testOperation(), IfVersion: 1, ConfirmProjectIDs: []string{projectID}}
	input, err := NormalizePatch(input)
	if err != nil {
		t.Fatal(err)
	}
	original, err := Fingerprint(webhookmodel.EndpointPatch, personalOwner, endpoint.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	input.IfVersion++
	changed, err := Fingerprint(webhookmodel.EndpointPatch, personalOwner, endpoint.ID, input)
	if err != nil || changed == original {
		t.Fatal("configuration CAS version was absent from operation intent")
	}
	otherOwner := webhookmodel.Owner{Kind: webhookmodel.TeamOwner, ID: teamID}
	changed, err = Fingerprint(webhookmodel.EndpointPatch, otherOwner, endpoint.ID, input)
	if err != nil || changed == original {
		t.Fatal("owner namespace was absent from operation intent")
	}
	for _, operation := range []struct {
		kind  webhookmodel.OperationKind
		input any
	}{
		{kind: webhookmodel.EndpointPatch, input: input},
		{kind: webhookmodel.EndpointDelete, input: DeleteInput{Operation: testOperation(), IfVersion: 1}},
		{kind: webhookmodel.SecretRotate, input: RotateInput{Operation: testOperation(), IfVersion: 1, Mode: "immediate"}},
	} {
		if _, err := Fingerprint(operation.kind, personalOwner, endpoint.ID, operation.input); err != nil {
			t.Fatal(err)
		}
		if _, err := Fingerprint(operation.kind, personalOwner, "", operation.input); err == nil {
			t.Fatal("resource operation without its target was fingerprinted")
		}
	}
	for _, input := range []any{CreateInput{}, PatchInput{}, DeleteInput{}, RotateInput{}, struct{}{}, nil} {
		if _, err := Fingerprint("unknown", personalOwner, endpoint.ID, input); err == nil {
			t.Fatalf("unexpected fingerprint input accepted: %#v", input)
		}
	}
	if _, err := Fingerprint(webhookmodel.EndpointPatch, personalOwner, "invalid", input); err == nil {
		t.Fatal("invalid target was fingerprinted")
	}
	if _, err := Fingerprint(webhookmodel.EndpointPatch, webhookmodel.Owner{Kind: "invalid", ID: userID}, endpoint.ID, input); err == nil {
		t.Fatal("invalid owner was fingerprinted")
	}
}

func TestAuthenticatedContextCannotCrossOwnersRecordsOrPurposes(t *testing.T) {
	endpoint := testEndpoint(t)
	first, err := AssociatedData(personalOwner, endpoint.ID, "signing-key", endpoint.ActiveKeyID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := AssociatedData(webhookmodel.Owner{Kind: webhookmodel.TeamOwner, ID: teamID}, endpoint.ID, "signing-key", endpoint.ActiveKeyID)
	if err != nil || bytes.Equal(first, second) {
		t.Fatal("different owner produced the same authenticated context")
	}
	third, err := AssociatedData(personalOwner, endpoint.ID, "delivery-destination", endpoint.ActiveKeyID)
	if err != nil || bytes.Equal(first, third) {
		t.Fatal("different purpose produced the same authenticated context")
	}
	fourth, err := AssociatedData(personalOwner, endpoint.ID, "signing-key", projectID)
	if err != nil || bytes.Equal(first, fourth) {
		t.Fatal("different record produced the same authenticated context")
	}
	for _, item := range []struct {
		owner    webhookmodel.Owner
		endpoint string
		purpose  string
		record   string
	}{
		{webhookmodel.Owner{Kind: "unknown", ID: userID}, endpoint.ID, "signing-key", projectID},
		{personalOwner, "invalid", "signing-key", projectID},
		{personalOwner, endpoint.ID, "endpoint-current", "0"},
		{personalOwner, endpoint.ID, "signing-key", "not-an-id"},
	} {
		if _, err := AssociatedData(item.owner, item.endpoint, item.purpose, item.record); err == nil {
			t.Fatal("invalid authenticated-context component was accepted")
		}
	}
}

func TestManagementPermissionAndMalformedOperationReachDomainBoundary(t *testing.T) {
	endpoint := testEndpoint(t)
	bad := testOperation()
	bad.ID = "bad"
	for _, err := range []error{
		func() error { _, err := NormalizeDelete(DeleteInput{Operation: bad, IfVersion: 1}); return err }(),
		func() error {
			_, err := NormalizeRotation(RotateInput{Operation: bad, IfVersion: 1, Mode: "immediate"})
			return err
		}(),
		func() error {
			_, err := PrepareCreate(CreateInput{Operation: bad}, personalOwner, managerAccess, nil, testNow)
			return err
		}(),
		func() error {
			_, err := PreparePatch(PatchInput{Operation: bad}, endpoint, webhookmodel.Destination{}, managerAccess, nil, testNow)
			return err
		}(),
		func() error {
			_, err := PrepareDelete(DeleteInput{Operation: bad}, endpoint, managerAccess, testNow)
			return err
		}(),
		func() error {
			_, err := PrepareRotation(RotateInput{Operation: bad}, endpoint, managerAccess, testNow)
			return err
		}(),
	} {
		requireCode(t, err, "invalid_input")
	}
	name := "Name"
	_, err := PreparePatch(PatchInput{Operation: testOperation(), IfVersion: endpoint.ConfigVersion, Name: &name}, endpoint, webhookmodel.Destination{}, webhookmodel.OwnerAccess{CanRead: true}, nil, testNow)
	requireCode(t, err, "forbidden")
	_, err = PrepareDelete(DeleteInput{Operation: testOperation(), IfVersion: endpoint.ConfigVersion}, endpoint, webhookmodel.OwnerAccess{CanRead: true}, testNow)
	requireCode(t, err, "forbidden")
	_, err = PrepareRotation(RotateInput{Operation: testOperation(), IfVersion: endpoint.ConfigVersion, Mode: "immediate"}, endpoint, webhookmodel.OwnerAccess{CanRead: true}, testNow)
	requireCode(t, err, "forbidden")
	receipt := webhookmodel.OperationReceipt{Owner: personalOwner}
	requireCode(t, RequireReceiptRead(personalOwner, userID, webhookmodel.OwnerAccess{}, receipt), "forbidden")
	receipt.Owner = webhookmodel.Owner{Kind: webhookmodel.TeamOwner, ID: teamID}
	if err := RequireReceiptRead(personalOwner, userID, managerAccess, receipt); err == nil {
		t.Fatal("stored receipt namespace mismatch was silently accepted")
	}
	if err := RequireOwner(webhookmodel.Owner{Kind: "bad", ID: userID}, userID, managerAccess, true); err == nil {
		t.Fatal("invalid owner was authorized")
	}
	if err := RequireOwner(personalOwner, "bad", managerAccess, true); err == nil {
		t.Fatal("invalid actor was authorized")
	}
	_, err = PrepareRotation(RotateInput{Operation: testOperation(), IfVersion: endpoint.ConfigVersion + 1, Mode: "immediate"}, endpoint, managerAccess, testNow)
	requireCode(t, err, "version_conflict")
	_, err = NormalizeDelete(DeleteInput{Operation: testOperation(), IfVersion: 0})
	requireCode(t, err, "invalid_input")
	if err := ValidatePolicy(webhookmodel.DefaultPolicy()); err != nil {
		t.Fatal(err)
	}
	bad.IssuedAt = "bad"
	if err := CheckOperationTime(bad, testNow, webhookmodel.DefaultPolicy()); err == nil {
		t.Fatal("invalid original timestamp received a fresh time default")
	}
	endpoint.DeletedAt = &testNow
	_, err = PrepareRotation(RotateInput{Operation: testOperation(), IfVersion: endpoint.ConfigVersion, Mode: "immediate"}, endpoint, managerAccess, testNow)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted endpoint could rotate signing key: %v", err)
	}
}
