package prompt

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func promptAuthorization(t *testing.T, scopes ...scopepolicy.ScopeID) model.CredentialAuthorization {
	t.Helper()
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, scopes, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile, Policy: &policy}
}

func TestAuthorizedPromptReadsAndWrites(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name   string
		scopes []scopepolicy.ScopeID
		read   bool
		write  bool
	}{
		{"read only", []scopepolicy.ScopeID{"prompt:read"}, true, false},
		{"write only", []scopepolicy.ScopeID{"prompt:write"}, false, false},
		{"both", []scopepolicy.ScopeID{"prompt:read", "prompt:write"}, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := mock(t)
			svc := testService(m)
			auth := promptAuthorization(t, tc.scopes...)
			m.snapshot()
			if tc.read {
				m.expect("metadata", store.PromptMetadata{}, nil, model.PromptPurposeWorker, user, model.PromptScopeUser, user)
			}
			got, err := svc.GetAuthorized(ctx, auth, model.PromptScopeUser, user)
			if tc.read {
				if err != nil || got.Revision != "0" {
					t.Fatalf("read: %+v, %v", got, err)
				}
			} else {
				fault(t, err, "insufficient_scope")
			}

			if tc.write {
				m.write(store.TransactionCommitted)
				m.expect("resource", model.PromptResource{Scope: model.PromptScopeUser, ScopeID: user, Revision: "0"}, nil, model.PromptPurposeWorker, user, model.PromptScopeUser, user)
				m.expect("decision", decisionResult{next: 1, changed: true}, nil, model.PromptResource{Scope: model.PromptScopeUser, ScopeID: user, Revision: "0"}, int64(0), "new")
				m.expect("create", model.PromptResource{Scope: model.PromptScopeUser, ScopeID: user, Revision: "1", Text: "new"}, nil, model.PromptPurposeWorker, user, model.PromptScopeUser, user, "new")
			} else {
				m.writeFailure(store.TransactionNotCommitted, "operation", nil)
			}
			got, err = svc.PutAuthorized(ctx, auth, model.PromptScopeUser, user, user, "0", "new")
			if tc.write {
				if err != nil || got.Text != "new" {
					t.Fatalf("write: %+v, %v", got, err)
				}
			} else {
				fault(t, err, "insufficient_scope")
			}
		})
	}
}

func TestAuthorizedPromptPreservesVisibilityAndProfiles(t *testing.T) {
	ctx := context.Background()
	m := mock(t)
	svc := testService(m)
	auth := promptAuthorization(t, "prompt:write")
	m.snapshot()
	m.expect("access", nil, model.ErrNotFound, principal, project)
	_, err := svc.GetAuthorized(ctx, auth, model.PromptScopeProject, project)
	fault(t, err, "not_found")

	auth = model.CredentialAuthorization{Principal: model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: other}, Profile: model.SessionProfile}
	m.snapshot()
	m.expect("metadata", store.PromptMetadata{}, nil, model.PromptPurposeWorker, user, model.PromptScopeUser, user)
	if _, err := svc.GetAuthorized(ctx, auth, model.PromptScopeUser, user); err != nil {
		t.Fatalf("session: %v", err)
	}

	api := model.CredentialAuthorization{Principal: model.Principal{Kind: model.OAuthCredential, UserID: user, CredentialID: other}, Profile: model.OAuthAPIProfile}
	m.snapshot()
	m.expect("metadata", store.PromptMetadata{}, nil, model.PromptPurposeWorker, user, model.PromptScopeUser, user)
	if _, err := svc.GetAuthorized(ctx, api, model.PromptScopeUser, user); err != nil {
		t.Fatalf("fixed API profile: %v", err)
	}

	invalid := model.CredentialAuthorization{Principal: principal, Profile: model.ScopedPATProfile}
	if _, err := svc.GetAuthorized(ctx, invalid, model.PromptScopeUser, user); err == nil {
		t.Fatal("missing policy accepted")
	}
	if _, err := svc.PutAuthorized(ctx, invalid, model.PromptScopeUser, user, user, "0", "new"); err == nil {
		t.Fatal("missing policy accepted")
	}
}

func TestReviewerAuthorizedUsesReviewerPurposeAndScopes(t *testing.T) {
	for _, tc := range []struct {
		name        string
		scopes      []scopepolicy.ScopeID
		read, write bool
	}{
		{"read", []scopepolicy.ScopeID{"prompt:read"}, true, false},
		{"write", []scopepolicy.ScopeID{"prompt:write"}, false, false},
		{"both", []scopepolicy.ScopeID{"prompt:read", "prompt:write"}, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := mock(t)
			svc := testService(m)
			auth := promptAuthorization(t, tc.scopes...)
			m.snapshot()
			if tc.read {
				m.expect("metadata", store.PromptMetadata{}, nil, model.PromptPurposeReviewer, user, model.PromptScopeUser, user)
			}
			value, err := svc.GetReviewerAuthorized(t.Context(), auth, model.PromptScopeUser, user)
			if tc.read {
				if err != nil || value.Revision != "0" {
					t.Fatalf("read %+v %v", value, err)
				}
			} else {
				fault(t, err, "insufficient_scope")
			}
			if tc.write {
				m.write(store.TransactionCommitted)
				empty := model.PromptResource{Scope: model.PromptScopeUser, ScopeID: user, Revision: "0"}
				m.expect("resource", empty, nil, model.PromptPurposeReviewer, user, model.PromptScopeUser, user)
				m.expect("decision", decisionResult{next: 1, changed: true}, nil, empty, int64(0), "new")
				m.expect("create", model.PromptResource{Scope: model.PromptScopeUser, ScopeID: user, Revision: "1", Text: "new"}, nil, model.PromptPurposeReviewer, user, model.PromptScopeUser, user, "new")
			} else {
				m.writeFailure(store.TransactionNotCommitted, "operation", nil)
			}
			value, err = svc.PutReviewerAuthorized(t.Context(), auth, model.PromptScopeUser, user, user, "0", "new")
			if tc.write {
				if err != nil || value.Text != "new" {
					t.Fatalf("write %+v %v", value, err)
				}
			} else {
				fault(t, err, "insufficient_scope")
			}
		})
	}
}
