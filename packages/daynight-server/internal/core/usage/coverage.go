package usage

import (
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func Coverage(summary model.UsageSummary, executions []store.UsageExecution, now time.Time) model.UsageSummary {
	type execution struct {
		states    []string
		supported bool
		known     bool
	}
	sessions := map[string]*execution{}
	reasons := []string{}
	for _, e := range executions {
		x := sessions[e.SessionID]
		if x == nil {
			x = &execution{}
			sessions[e.SessionID] = x
		}
		x.known = x.known || e.Known
		if e.State == nil {
			if e.Backend == "herdr" {
				x.states = append(x.states, "unsupported")
				reasons = MergeReasons(reasons, "provider_unsupported")
			} else {
				x.states = append(x.states, "unregistered")
				reasons = MergeReasons(reasons, "registration_missing")
			}
			continue
		}
		r := *e.State
		state, why := Effective(r, EffectiveFacts{Expired: r.GrantExpiresAt == nil || !now.Before(*r.GrantExpiresAt), Revoked: r.GrantRevokedAt != nil || !e.ParentValid || !e.Allowed, Stopped: e.Stopped, Known: e.Known, GapReasons: e.GapReasons})
		reasons = MergeReasons(reasons, why...)
		x.states = append(x.states, state)
		x.supported = x.supported || r.Capability != nil && r.Capability.Qualification == "verified" && r.Capability.MeasurementPlane != "none"
	}
	counts := map[string]int{}
	supported := 0
	known := false
	for _, x := range sessions {
		if x.supported {
			supported++
		}
		known = known || x.known
		state := "complete"
		for _, s := range x.states {
			if s == "collecting" {
				state = "collecting"
				break
			}
			if s != "complete" {
				if state == "complete" {
					state = s
				} else if state != s {
					state = "partial"
				}
			}
		}
		counts[state]++
	}
	n := len(sessions)
	count := func(s string) string { return strconv.Itoa(counts[s]) }
	summary.Coverage = model.UsageCoverage{Executions: strconv.Itoa(n), Supported: strconv.Itoa(supported), Collecting: count("collecting"), Complete: count("complete"), Partial: count("partial"), Unsupported: count("unsupported"), Unavailable: count("unavailable"), Unregistered: count("unregistered")}
	summary.Scope = "registered_web_executions"
	summary.ObservedAt = now
	summary.ReasonCodes = reasons
	switch {
	case counts["collecting"] > 0:
		summary.Completeness = "collecting"
	case n > 0 && counts["complete"] == n:
		summary.Completeness = "complete"
	case known || counts["partial"] > 0 || n > 0 && counts["unsupported"] != n && counts["unavailable"] != n && counts["unregistered"] != n:
		summary.Completeness = "partial"
	case counts["unavailable"] > 0:
		summary.Completeness = "unavailable"
	case n > 0 && counts["unsupported"] == n:
		summary.Completeness = "unsupported"
	default:
		summary.Completeness = "no_data"
		if n == 0 {
			summary.ReasonCodes = MergeReasons(summary.ReasonCodes, "historical_no_data")
		}
	}
	return summary
}
