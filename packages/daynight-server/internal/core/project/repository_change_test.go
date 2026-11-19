package project

import "testing"

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
