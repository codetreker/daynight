package project

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestClassifyRepository(t *testing.T) {
	a, b := int64(11), int64(12)
	for _, tc := range []struct {
		name, current, target, oldIdentity, newIdentity string
		evidence                                        RepositoryEvidence
		want                                            string
		id                                              *int64
	}{
		{"unchanged", "a", "a", "x", "x", RepositoryEvidence{OldID: &a, TargetID: &b}, "unchanged", nil},
		{"equivalent", "a", "b", "x", "x", RepositoryEvidence{}, "same_repository", nil},
		{"replacement", "a", "b", "x", "x", RepositoryEvidence{OldID: &a, TargetID: &b}, "different_repository", &b},
		{"renamed", "a", "b", "x", "github.com/org/new", RepositoryEvidence{OldID: &a, OldFullName: "Org/New"}, "same_repository", &a},
		{"same id", "a", "b", "x", "y", RepositoryEvidence{OldID: &a, TargetID: &a}, "same_repository", &a},
		{"unknown", "a", "b", "x", "y", RepositoryEvidence{UnverifiedReason: "no_github_access"}, "unverified", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, id, reason := ClassifyRepository(tc.current, tc.target, tc.oldIdentity, tc.newIdentity, tc.evidence)
			if got != tc.want || !SameRepositoryID(id, tc.id) || (got == "unverified") != (reason != nil) {
				t.Fatalf("got %s, %v, %v", got, id, reason)
			}
		})
	}
}

func TestValidateRepositoryChange(t *testing.T) {
	actor := model.Principal{UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "44444444-4444-4444-8444-444444444444", Kind: model.SessionCredential}
	id := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	for _, tc := range []struct {
		name, projectID, address, expected string
		wantErr                            bool
	}{
		{"valid", id, "git@github.com:Org/Repo.git", actor.UserID, false},
		{"identity changed", id, "https://github.com/Org/Repo", "22222222-2222-4222-8222-222222222222", true},
		{"invalid project", "not-uuid", "https://github.com/Org/Repo", actor.UserID, true},
		{"invalid address", id, "https://user:password@github.com/Org/Repo", actor.UserID, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			gotID, identity, err := ValidateRepositoryChange(actor, tc.projectID, tc.address, tc.expected)
			if tc.wantErr {
				if err == nil || gotID != "" || identity != "" {
					t.Fatalf("expected refusal: %q %q %v", gotID, identity, err)
				}
				return
			}
			if err != nil || gotID != id || identity != "github.com/Org/Repo" {
				t.Fatalf("validated: %q %q %v", gotID, identity, err)
			}
		})
	}
}
