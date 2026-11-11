# Final acceptance

Use to determine whether the complete task or Goal requested by the user meets confirmed requirements.
Define the acceptance scope, requirement sources, actual delivery inputs, and observable completion conditions during creation or breakdown; do not limit acceptance to an implementation fragment or helper script.

## Verify complete outcomes

Read the complete confirmed requirements and changes, actual deliverables, and acceptance criteria.
Use manual verification, existing checks, or temporary helpers as needed to verify required implementation and actual PR merges.
Conclusions must cover the entire agreed scope; do not report the original task or Goal as having passed when required outcomes are unmet or unverified.
Done and cancelled both end scheduling, but only done claims successful delivery.
A cancelled task satisfies dependency readiness without proving its output exists;
acceptance must assess the current confirmed requirements and actual combined
results rather than count cancelled tasks as delivered requirements.

Deliver requirement-based conclusions, defects, unverified items, and the evaluated sources, key observations, and material limitations needed to support those conclusions in the owning resource. For a whole Goal, the acceptance Task produces the conclusion on the Goal and identifies the Goal ID and exact path; Task-specific results remain on their Tasks.
Content ownership follows the [task content standard](task-content.md); managed acceptance must also meet the evidence attachment requirements of the [complete delivery standard](delivery.md#worker-delivery-results).
Keep verification commands, debugging history, and progress in the session unless they are themselves required deliverables.

## Helper boundaries

Keep temporary acceptance scripts in the project's temporary area.
Do not commit them, integrate them into repository tests, fixtures, runners, CI, or tooling, or make an ongoing verification system an acceptance deliverable.
Completing or passing a helper script does not prove that user requirements are met and does not create a separate PR requirement for it.
Review findings in helpers do not authorize scope expansion.

Implementation and authorized defect fixes still retain normal unit, integration, and regression tests and required repository checks.
User-requested persistent tests or automation are separately confirmed development deliverables, not something inferred from an acceptance task.
Fix product defects only within the authorized implementation scope; handle the rest under [authorization and scope](authorization.md).
