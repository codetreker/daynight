package usage

import (
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestDerivedLifecycleReasonsSurviveFullCollectorReasonBudget(t *testing.T) {
	reasons := strings.Split("source_conflict,native_recovery_gap,input_cache_semantics_unknown,profile_unverified,provider_unsupported,subagent_scope_unknown,historical_no_data,registration_missing,external_review_unobserved,model_unknown,attribution_unknown,inclusion_parent_missing,local_capacity_exceeded,local_storage_failed,native_integer_unrepresentable,scope_restricted", ",")
	r := model.UsageRecord{CollectionState: Ptr("collecting"), ReasonCodes: reasons}
	state, actual := Effective(r, EffectiveFacts{Expired: true, Revoked: true, Stopped: true, Known: true})
	if state != "partial" || len(actual) != 16 || len(r.ReasonCodes) != 16 {
		t.Fatal(state, actual)
	}
	for _, required := range []string{"source_conflict", "native_recovery_gap", "input_cache_semantics_unknown", "profile_unverified", "provider_unsupported", "subagent_scope_unknown", "missing_final", "upload_expired", "permission_revoked", "collector_failed", "attribution_unknown", "inclusion_parent_missing"} {
		found := false
		for _, reason := range actual {
			found = found || reason == required
		}
		if !found {
			t.Fatal("mandatory reason displaced", required, actual)
		}
	}
}
