package session

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func setAPICredential(f fixture, actor model.Principal) {
	if f.dao.OAuthBindings == nil {
		f.dao.OAuthBindings = map[string]store.OAuthBinding{}
	}
	f.dao.OAuthBindings[actor.CredentialID] = store.OAuthBinding{Resource: f.s.Origin + "/api/v1", Scope: oauth.APIScope, ClientID: oauth.APIClientID}
}

func TestAPICredentialReadsIndependentSessionWithParentPAT(t *testing.T) {
	f, v, _ := testSession(t, "none")
	actor := listCredential(t, f, f.p.UserID, model.OAuthCredential)
	setAPICredential(f, actor)
	out, err := f.s.TestSnapshot(f.BrowserPhase(t.Context(), nil), actor, v.SessionID)
	if err != nil || out.SessionID != v.SessionID {
		t.Fatalf("snapshot=%+v err=%v", out, err)
	}
	revokeContentCredential(t, f, f.p)
	_, err = f.s.TestSnapshot(f.BrowserPhase(t.Context(), nil), actor, v.SessionID)
	assertCommandAuthorization(t, err, "unauthenticated", nil)
}

func TestAPICredentialSubmitsTaskUserCommandAndPersistsActualActor(t *testing.T) {
	f, v := connectFixture(t)
	publishState(t, f, v, controlState())
	actor := listCredential(t, f, f.p.UserID, model.OAuthCredential)
	setAPICredential(f, actor)
	command := controlCommand(v, "refresh_controls")
	out, err := fixtureSubmit(f, t.Context(), actor, v, command, map[string]int{"SessionOperation": 1, "PendingSessionOperationCount": 1, "InsertSessionOperation": 1, "SaveSession": 1})
	if err != nil || out.State != "accepted" {
		t.Fatalf("command=%+v err=%v", out, err)
	}
	if f.writes.Operation == nil || f.writes.Operation.Actor != actor {
		t.Fatalf("saved Actor=%+v", f.writes.Operation)
	}
}

func TestAPICredentialDoesNotAdmitProducerRegistrationOrGrant(t *testing.T) {
	f := setup(t)
	actor := model.Principal{Kind: model.OAuthCredential, UserID: f.p.UserID, CredentialID: f.p.CredentialID}
	setAPICredential(f, actor)
	if _, err := f.s.Register(t.Context(), actor, f.project, f.task, sp.Registration{}); err == nil {
		t.Fatal("API registered producer")
	}
	if _, err := f.s.RegisterTest(t.Context(), actor, sp.TestRegistration{}); err == nil {
		t.Fatal("API registered test producer")
	}
	if _, err := f.s.Grant(t.Context(), actor, f.project, f.task, "session", sp.Grant{}); err == nil {
		t.Fatal("API issued producer grant")
	}
}

func TestAPICredentialReadsBotSessionAndPreservesCurrentBinding(t *testing.T) {
	f, out, _, _ := connectedBotFixture(t)
	actor := listCredential(t, f, f.p.UserID, model.OAuthCredential)
	setAPICredential(f, actor)
	snapshot, err := f.s.TestSnapshot(f.BrowserPhase(t.Context(), nil), actor, out.Session.SessionID)
	if err != nil || snapshot.SessionID != out.Session.SessionID {
		t.Fatalf("snapshot=%+v err=%v", snapshot, err)
	}
	botDAO(f).value.SessionID = nil
	_, err = f.s.TestSnapshot(f.BrowserPhase(t.Context(), map[string]int{"LockCredential": 0, "LockSession": 0}), actor, out.Session.SessionID)
	assertCommandAuthorization(t, err, "session_conflict", nil)
}
