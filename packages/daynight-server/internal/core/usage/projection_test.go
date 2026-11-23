package usage

import (
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestDerivedGapsAffectSealedStateAndSummaryConsistently(t *testing.T) {
	now := time.Now().UTC()
	for _, name := range []string{"collecting", "complete", "partial", "unavailable", "unsupported"} {
		r := model.UsageRecord{CollectionState: Ptr(name), SealedAt: &now, ReasonCodes: []string{}}
		gaps := []string{"attribution_unknown", "inclusion_parent_missing"}
		state, reasons := Effective(r, EffectiveFacts{GapReasons: gaps})
		want := "partial"
		if name == "collecting" {
			want = name
		}
		if state != want || strings.Join(reasons, ",") != "attribution_unknown,inclusion_parent_missing" {
			t.Fatal(state, reasons)
		}
		summary := Coverage(model.UsageSummary{}, []store.UsageExecution{{SessionID: "one", State: &r, GapReasons: gaps}}, now)
		if summary.Completeness != want || !Equal(summary.ReasonCodes, reasons) {
			t.Fatal(summary)
		}
	}
}

func TestConflictReasonCapacityPreservesStickyAndProfileLimits(t *testing.T) {
	now := time.Now().UTC()
	r := model.UsageRecord{ID: "state", Provider: "copilot", RowVersion: "1", StateSequence: Ptr("2"), CollectionState: Ptr("collecting"), ReasonCodes: strings.Split("attribution_unknown,collector_failed,external_review_unobserved,upload_expired,inclusion_parent_missing,input_cache_semantics_unknown,local_capacity_exceeded,local_storage_failed,missing_final,model_unknown,native_integer_unrepresentable,native_recovery_gap,permission_revoked,registration_missing,scope_restricted,subagent_scope_unknown", ",")}
	next, changed, err := MarkConflict(r, now)
	if err != nil || !changed || next.RowVersion != "2" || Value(next.StateSequence) != "2" || len(next.ReasonCodes) != 16 {
		t.Fatal(next, changed, err)
	}
	for _, reason := range []string{"source_conflict", "native_recovery_gap", "input_cache_semantics_unknown", "missing_final", "upload_expired", "permission_revoked"} {
		found := false
		for _, actual := range next.ReasonCodes {
			found = found || actual == reason
		}
		if !found {
			t.Fatal("lost mandatory reason", reason, next.ReasonCodes)
		}
	}
	again, changed, err := MarkConflict(next, now.Add(time.Hour))
	if err != nil || changed || again.RowVersion != "2" || !again.UpdatedAt.Equal(now) {
		t.Fatal(again, changed, err)
	}
	current := model.UsageRecord{SourceRevision: Ptr("2"), RevisionAuthority: Ptr("native"), Finality: Ptr("provisional"), BodyHash: "current"}
	if _, err = Decide(current, "1", "old-final", "final", false); err == nil {
		t.Fatal("stale ACK would regress known finality")
	}
}
