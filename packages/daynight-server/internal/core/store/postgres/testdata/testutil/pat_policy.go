package testutil

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"

// PATPolicy supplies an explicit full policy for fixtures testing credential
// validity independently of business-scope selection.
func PATPolicy() *scopepolicy.Policy {
	entries, err := scopepolicy.Catalog(scopepolicy.PAT)
	if err != nil {
		panic(err)
	}
	ids := make([]scopepolicy.ScopeID, len(entries))
	for i, entry := range entries {
		ids[i] = entry.ID
	}
	ids, err = scopepolicy.Normalize(scopepolicy.PAT, ids)
	if err != nil {
		panic(err)
	}
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, ids, 1)
	if err != nil {
		panic(err)
	}
	return &policy
}
