package model

import "fmt"

// EligibilityFacts contains current project ownership and access observations.
type EligibilityFacts struct {
	ProjectLive              bool
	ProjectName              *string
	TeamID                   *string
	TeamPresent              bool
	OwnerAccess, ActorAccess bool
}

type Eligibility struct {
	Status      string
	ProjectName *string
}

// EvaluateEligibility applies the same owner-scope rule to point and batch reads.
func EvaluateEligibility(owner Owner, facts EligibilityFacts) (Eligibility, error) {
	if owner.Kind != "personal" && owner.Kind != "team" {
		return Eligibility{}, fmt.Errorf("invalid webhook owner kind")
	}
	if !facts.ProjectLive {
		return Eligibility{Status: "resource_unavailable"}, nil
	}
	if facts.ProjectName == nil || facts.TeamID == nil || !facts.TeamPresent {
		return Eligibility{}, fmt.Errorf("live project ownership or owner Team missing")
	}
	status := "eligible"
	if owner.Kind == "personal" && !facts.OwnerAccess {
		status = "access_revoked"
	}
	if owner.Kind == "team" && *facts.TeamID != owner.ID {
		status = "owner_scope_changed"
	}
	result := Eligibility{Status: status}
	if status == "eligible" && facts.ActorAccess {
		result.ProjectName = facts.ProjectName
	}
	return result, nil
}
