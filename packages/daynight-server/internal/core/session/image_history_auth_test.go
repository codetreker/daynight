package session

import (
	"context"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestImageHistoryUsesOriginalConsumedGrantAndRejectsRenewedOldToken(t *testing.T) {
	f := setup(t)
	ctx := context.Background()
	v, e := registerAuthenticationFixture(f, ctx)
	if e != nil {
		t.Fatal(e)
	}
	f.SelectRegistrationWrite(t)
	input := sp.Grant{Protocol: sp.Protocol, ClaimID: v.ClaimID, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, ExecutionGeneration: "1", Kind: "bootstrap"}
	grant, e := grantAuthenticationFixture(f, ctx, v.SessionID, input)
	if e != nil {
		t.Fatal(e)
	}
	f.SelectGrantWrite(t)
	f.SelectSessionWrite(t)
	hello := sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: v.ControllerFence, ControllerID: f.r.ControllerID, ControllerInstanceID: f.r.ControllerInstanceID, Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0", SchemaVersion: 1, ProjectionVersion: 1}
	v, e = connectAuthenticationFixture(f, ctx, grant.Token, hello)
	if e != nil {
		t.Fatal(e)
	}
	f.SelectConnectionWrite(t)
	check := func(token string) error {
		phase := f.ControllerPhase(ctx, nil)
		defer f.dao.FinishContext(phase)
		return f.s.controllerRun(phase, v.ControllerFence, func(a *Access) error {
			p, e := a.ActiveHistoryPrincipal(f.project, f.task, v.SessionID, ActiveHistoryWriter{Fence: v.ControllerFence, Credential: token})
			if e == nil && p != f.p {
				t.Fatal("grant delegated different parent", p)
			}
			return e
		})
	}
	if e = check(grant.Token); e != nil {
		t.Fatal("original consumed grant did not delegate", e)
	}
	input.Kind = "reconnect"
	renewed, e := grantAuthenticationFixture(f, ctx, v.SessionID, input)
	if e != nil {
		t.Fatal(e)
	}
	f.SelectGrantWrite(t)
	f.SelectSessionWrite(t)
	// The next controlled row reflects SetSessionGrant's persisted consumed=false.
	f.data.Session.Consumed = false
	if e = check(grant.Token); e == nil {
		t.Fatal("renewed old grant retained history authority")
	}
	if e = check(renewed.Token); e == nil {
		t.Fatal("unconsumed replacement grant delegated existing connection")
	}
	hello.ControllerFence = v.ControllerFence
	v, e = connectAuthenticationFixture(f, ctx, renewed.Token, hello)
	if e != nil {
		t.Fatal(e)
	}
	f.SelectConnectionWrite(t)
	if e = check(renewed.Token); e != nil {
		t.Fatal("new consumed grant failed", e)
	}
	if e = check(grant.Token); e == nil {
		t.Fatal("original grant revived after reconnect")
	}
}
