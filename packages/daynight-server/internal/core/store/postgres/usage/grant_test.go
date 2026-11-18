package usage_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
	"github.com/google/uuid"
)

func TestUsageRegistrationBindingSurvivesReconnectAndGrantRotation(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	original, err := core.ParseGrantVerifier(reg.State.GrantHash)
	if err != nil || original.TokenHash != sha256.Sum256([]byte(reg.Grant.Token)) {
		t.Fatal(original, err)
	}
	for _, change := range []func(*app.Registration){
		func(r *app.Registration) { r.StateID = uuid.NewString() },
		func(r *app.Registration) { r.RegistrationID = uuid.NewString() },
		func(r *app.Registration) { r.ProviderVersion = "changed" },
	} {
		input := f.registration
		change(&input)
		_, err = f.service.Register(ctx, f.actor, input)
		requireCode(t, err, "registration_conflict")
	}
	reconnected := f.registration
	reconnected.ControllerInstanceID = uuid.NewString()
	reconnected.ConnectionEpoch = "2"
	testutil.MustExec(t, f.db.Pool, `UPDATE task_sessions SET snapshot=jsonb_set(jsonb_set(snapshot,'{connectionEpoch}','"2"'),'{identity,controllerInstanceId}',to_jsonb($2::text)) WHERE id=$1`, f.session, reconnected.ControllerInstanceID)
	_, err = f.service.Register(ctx, f.actor, reconnected)
	requireCode(t, err, "registration_conflict")
	_, err = f.service.Register(ctx, f.actor, f.registration)
	requireCode(t, err, "registration_unavailable")
	rotated, err := f.service.Rotate(ctx, f.actor, reg.State.ID, app.GrantRequest{ExpectedRowVersion: reg.State.RowVersion, SessionID: f.session, Generation: "1", ControllerInstanceID: reconnected.ControllerInstanceID, ConnectionEpoch: "2"})
	if err != nil || rotated.Grant == nil {
		t.Fatal(rotated, err)
	}
	replacement, err := core.ParseGrantVerifier(rotated.State.GrantHash)
	if err != nil || replacement.Binding != original.Binding || replacement.TokenHash == original.TokenHash || replacement.TokenHash != sha256.Sum256([]byte(rotated.Grant.Token)) {
		t.Fatal(replacement, err)
	}
	_, err = f.service.Register(ctx, f.actor, reconnected)
	requireCode(t, err, "registration_conflict")
	_, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "1")))
	requireCode(t, err, "invalid_grant")
	testutil.MustExec(t, f.db.Pool, `UPDATE tasks SET status='done' WHERE id=$1`, f.task)
	if _, err = f.service.Batch(ctx, reg.State.ID, rotated.Grant.Token, batch(measurement(reg.State.ID, "7"))); err != nil {
		t.Fatal("late original-state report rejected after reconnect", err)
	}
	raw, err := json.Marshal(rotated.State)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{reg.Grant.Token, rotated.Grant.Token, f.actor.CredentialID, "grantHash", "parentCredentialId", "registrationBinding"} {
		if bytes.Contains(raw, []byte(secret)) {
			t.Fatal("private verifier exposed in state DTO", secret)
		}
	}
}

func TestUsageRejectsMalformedPersistedVerifierAndGuardsWholeEnvelope(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	modified := reg.State
	modified.GrantHash = append([]byte{}, reg.State.GrantHash...)
	modified.GrantHash[64] ^= 1
	_, err = f.db.WriteUsage(ctx, func(scope store.UsageScope) error { return scope.UsageDAO().Guard(ctx, modified) })
	requireCode(t, err, "usage_changed")
	for _, bad := range [][]byte{nil, make([]byte, 32), make([]byte, 65), append([]byte{2}, make([]byte, 64)...), append(reg.State.GrantHash, 0)} {
		testutil.MustExec(t, f.db.Pool, `UPDATE usage_records SET grant_hash=$2 WHERE id=$1`, reg.State.ID, bad)
		_, err = f.service.State(ctx, f.actor, reg.State.ID)
		var fault *model.UsageFault
		if !errors.Is(err, core.ErrInvalidGrantVerifier) || errors.As(err, &fault) || strings.Contains(err.Error(), reg.Grant.Token) {
			t.Fatal("malformed verifier was not a storage failure", err)
		}
	}
	testutil.MustExec(t, f.db.Pool, `UPDATE usage_records SET grant_hash=$2 WHERE id=$1`, reg.State.ID, reg.State.GrantHash)
	if _, err = f.service.State(ctx, f.actor, reg.State.ID); err != nil {
		t.Fatal(err)
	}
}
