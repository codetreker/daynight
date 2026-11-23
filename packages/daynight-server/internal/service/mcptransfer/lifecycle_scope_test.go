package mcptransfer

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type policyDAO struct {
	store.PrivateTransferDAO
	auth model.CredentialAuthorization
	err  error
}

func (d policyDAO) CurrentTransferAuthorization(_ context.Context, p model.Principal) (model.CredentialAuthorization, error) {
	if p != d.auth.Principal && d.err == nil {
		return model.CredentialAuthorization{}, model.Unauthenticated(nil)
	}
	return d.auth, d.err
}

func TestTransferScopeAdmissionFailsClosed(t *testing.T) {
	actor := Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}, AuthorityKind: "pat"}
	actor.AuthorityID = actor.Principal.CredentialID
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"attachment:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	auth := model.CredentialAuthorization{Principal: actor.Principal, Profile: model.ScopedPATProfile, Policy: &policy}
	legacy := &Lifecycle{}
	if err := legacy.requireScope(t.Context(), nil, actor, scopepolicy.AttachmentRead); err != nil {
		t.Fatal(err)
	}
	s := &Lifecycle{scoped: true}
	if err := s.requireScope(t.Context(), nil, actor, scopepolicy.AttachmentRead); err == nil {
		t.Fatal("missing current reader accepted")
	}
	readErr := errors.New("policy read failed")
	if err := s.requireScope(t.Context(), policyDAO{err: readErr}, actor, scopepolicy.AttachmentRead); !errors.Is(err, readErr) {
		t.Fatalf("policy error: %v", err)
	}
	wrong := auth
	wrong.Profile = model.ScopedMCPProfile
	if err := s.requireScope(t.Context(), policyDAO{auth: wrong}, actor, scopepolicy.AttachmentRead); err == nil {
		t.Fatal("mismatched profile accepted")
	}
	if err := s.authorizeScopeDirection(t.Context(), policyDAO{auth: auth}, actor, "download"); err != nil {
		t.Fatal(err)
	}
	if err := s.authorizeScopeDirection(t.Context(), policyDAO{auth: auth}, actor, "upload"); !errors.Is(err, scopepolicy.ErrInsufficientScope) {
		t.Fatalf("upload: %v", err)
	}
	if err := s.authorizeScopeDirection(t.Context(), policyDAO{auth: auth}, actor, "other"); !errors.Is(err, ErrConflict) {
		t.Fatalf("direction: %v", err)
	}
}
