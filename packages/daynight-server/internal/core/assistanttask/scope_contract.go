package assistanttask

import (
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// ScopeBranch describes operations that are jointly required for a branch.
// Multiple branches apply when the request combines their conditions.
type ScopeBranch struct {
	Name       string
	Operations []scopepolicy.Operation
}

// ScopeContract is shared by business admission and route inventory. Profiles
// describe existing user credentials, not Bot identity or claim authorization.
type ScopeContract struct {
	Profiles    []model.CredentialPolicyProfile
	Branches    []ScopeBranch
	Admission   string
	Combination string
}

var assistantScopeContracts = buildScopeContracts()

func buildScopeContracts() map[string]ScopeContract {
	result := map[string]ScopeContract{}
	add := func(names []string, branches ...ScopeBranch) {
		for _, name := range names {
			result["core.Module."+name] = ScopeContract{
				Profiles:    []model.CredentialPolicyProfile{model.ScopedPATProfile, model.SessionProfile},
				Branches:    branches,
				Admission:   "transaction credential and task visibility before effects; credential and scope rechecked before completion",
				Combination: "all selected branches",
			}
		}
	}
	branch := func(name string, ops ...scopepolicy.Operation) ScopeBranch {
		return ScopeBranch{Name: name, Operations: ops}
	}
	read, write, operate, del, inbox := scopepolicy.AssistantTaskRead, scopepolicy.AssistantTaskWrite, scopepolicy.AssistantTaskOperate, scopepolicy.AssistantTaskDelete, scopepolicy.AssistantTaskInbox
	add([]string{"Get", "List", "GetManual", "ListManuals", "ListAppendix", "RelatedAppendix", "ListProposals", "ListItems", "GetItem", "Metrics", "ListRecords", "ListEvents", "ListInquiries", "ClaimOperation", "InboxOperation", "GetInbox"}, branch("default", read))
	add([]string{"Create", "AddAppendix", "ValidateAppendix", "Propose", "Decide", "Rollback", "AddRecord"}, branch("default", write, read))
	add([]string{"Claim", "SaveItem", "AddEvent", "AckEvent", "Ask", "Answer"}, branch("default", operate, read))
	add([]string{"ClearAttention"}, branch("default", operate))
	add([]string{"EnableInbox", "RotateInbox", "DisableInbox"}, branch("default", inbox, read))
	add([]string{"Update"}, branch("response", read), branch("ordinary", write), branch("state", operate), branch("delete", del))
	add([]string{"UpdateAppendix"}, branch("edit", write, read), branch("delete", del, read))
	add([]string{"EnablePreset"}, branch("existing", operate, read), branch("create", write))
	for _, name := range []string{"Create", "List", "ClearAttention"} {
		key := "core.Module." + name
		c := result[key]
		c.Admission = "account credential before effects; credential and scope rechecked before completion"
		result[key] = c
	}
	for _, name := range []string{"ListEvents", "EnablePreset"} {
		key := "core.Module." + name
		c := result[key]
		c.Admission = "account credential before effects; task visibility when a task is selected; credential and scope rechecked before completion"
		result[key] = c
	}
	c := result["core.Module.EnablePreset"]
	c.Combination = "existing always; add create when no application task exists"
	result["core.Module.EnablePreset"] = c
	c = result["core.Module.Update"]
	c.Combination = "response always; add ordinary for ordinary fields, state for active or paused, delete for deleted"
	result["core.Module.Update"] = c
	return result
}

// ScopeContractFor returns an independent copy; unknown owners are unclassified.
func ScopeContractFor(owner string) (ScopeContract, bool) {
	c, ok := assistantScopeContracts[owner]
	if !ok {
		return ScopeContract{}, false
	}
	c.Profiles = slices.Clone(c.Profiles)
	c.Branches = slices.Clone(c.Branches)
	for i := range c.Branches {
		c.Branches[i].Operations = slices.Clone(c.Branches[i].Operations)
	}
	return c, true
}

// requiringBranches selects the exact business branches before admission. An
// unknown owner or branch deliberately leaves an empty, invalid requirement.
func (a Actor) requiringBranches(owner string, branches ...string) Actor {
	a.operations = nil
	contract, ok := ScopeContractFor("core.Module." + owner)
	if !ok || len(branches) == 0 {
		return a
	}
	for _, name := range branches {
		found := false
		for _, branch := range contract.Branches {
			if branch.Name == name {
				a.operations = append(a.operations, branch.Operations...)
				found = true
				break
			}
		}
		if !found {
			a.operations = nil
			return a
		}
	}
	return a
}
