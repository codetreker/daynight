package model

import "testing"

func TestEligibilityUsesCurrentProjectOwnershipAndActorVisibility(t *testing.T) {
	name, team := "Project", "team"
	facts := EligibilityFacts{ProjectLive: true, ProjectName: &name, TeamID: &team, TeamPresent: true, OwnerAccess: true, ActorAccess: true}
	for _, tc := range []struct {
		name             string
		owner            Owner
		alter            func(*EligibilityFacts)
		status           string
		visible, failure bool
	}{
		{"personal", Owner{Kind: "personal", ID: "owner"}, func(*EligibilityFacts) {}, "eligible", true, false},
		{"actor unreadable", Owner{Kind: "personal", ID: "owner"}, func(f *EligibilityFacts) { f.ActorAccess = false }, "eligible", false, false},
		{"owner revoked", Owner{Kind: "personal", ID: "owner"}, func(f *EligibilityFacts) { f.OwnerAccess = false }, "access_revoked", false, false},
		{"team", Owner{Kind: "team", ID: team}, func(*EligibilityFacts) {}, "eligible", true, false},
		{"team moved", Owner{Kind: "team", ID: "other"}, func(*EligibilityFacts) {}, "owner_scope_changed", false, false},
		{"removed project", Owner{Kind: "personal", ID: "owner"}, func(f *EligibilityFacts) {
			f.ProjectLive = false
			f.ProjectName = nil
			f.TeamID = nil
			f.TeamPresent = false
		}, "resource_unavailable", false, false},
		{"missing name", Owner{Kind: "personal", ID: "owner"}, func(f *EligibilityFacts) { f.ProjectName = nil }, "", false, true},
		{"missing ownership", Owner{Kind: "personal", ID: "owner"}, func(f *EligibilityFacts) { f.TeamID = nil }, "", false, true},
		{"missing Team", Owner{Kind: "personal", ID: "owner"}, func(f *EligibilityFacts) { f.TeamPresent = false }, "", false, true},
		{"invalid owner", Owner{Kind: "invalid"}, func(*EligibilityFacts) {}, "", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			candidate := facts
			tc.alter(&candidate)
			got, err := EvaluateEligibility(tc.owner, candidate)
			if (err != nil) != tc.failure || got.Status != tc.status || (got.ProjectName != nil) != tc.visible {
				t.Fatalf("eligibility=%+v error=%v", got, err)
			}
			if tc.visible && got.ProjectName != facts.ProjectName {
				t.Fatal("eligible Project name changed")
			}
		})
	}
}
