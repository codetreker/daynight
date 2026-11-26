package usage

import (
	"math/big"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type Profile struct {
	Provider       string                `json:"provider"`
	ID             string                `json:"id"`
	Capability     model.UsageCapability `json:"capability"`
	SourcePrefix   string                `json:"sourcePrefix"`
	NativeKeys     []string              `json:"nativeKeys"`
	DisjointCache  bool                  `json:"-"`
	AllowInclusion bool                  `json:"-"`
}

func ProfileReasons(provider string, profileID ...string) []string {
	switch provider {
	case "copilot":
		return []string{"input_cache_semantics_unknown", "native_recovery_gap"}
	case "claude":
		return []string{"subagent_scope_unknown"}
	case "codex":
		if len(profileID) == 1 && profileID[0] == "codex-response-0.169.0-v1" {
			return []string{"native_recovery_gap", "subagent_scope_unknown", "model_unknown"}
		}
		return []string{"provider_unsupported"}
	}
	return []string{}
}

func Profiles() []Profile {
	return []Profile{
		profile("copilot", "copilot-event-1.0.11-v1", "native_event", "immutable", "included_per_event", "durable_after_ingress_only", "partial_only", "copilot-event-v1:", []string{"inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "agentId", "agentType"}, []string{"unknown", "supported", "unknown", "unknown", "optional", "unknown"}),
		profile("claude", "claude-message-input-0.3.247-v1", "root_message_input", "immutable", "unknown", "native_history_partial", "partial_only", "claude-message-input-v1:", []string{"input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"}, []string{"supported", "unknown", "supported", "supported", "unknown", "unknown"}),
		profile("codex", "codex-snapshot-unaccountable-v1", "none", "none", "unknown", "unsupported", "unsupported", "", nil, []string{"unsupported", "unsupported", "unsupported", "unsupported", "unsupported", "unsupported"}),
		profile("codex", "codex-response-0.169.0-v1", "native_event", "immutable", "unknown", "native_history_partial", "partial_only", "codex-response-v1:", []string{"inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningOutputTokens"}, []string{"supported", "supported", "optional", "unknown", "optional", "supported"}),
	}
}

var metricNames = []string{"inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens"}

func profile(provider, id, plane, revision, subagents, recovery, completion, prefix string, keys, metrics []string) Profile {
	m := map[string]string{}
	for i, k := range metricNames {
		m[k] = metrics[i]
	}
	q := "unverified"
	if id == "codex-snapshot-unaccountable-v1" {
		q = "unsupported"
	}
	return Profile{Provider: provider, ID: id, SourcePrefix: prefix, NativeKeys: keys, DisjointCache: provider == "claude", Capability: model.UsageCapability{ProfileID: id, Qualification: q, MeasurementPlane: plane, RevisionAuthority: revision, Metrics: m, Subagents: subagents, Recovery: recovery, Completion: completion}}
}
func FindProfile(id, provider string) (Profile, error) {
	for _, p := range Profiles() {
		if p.ID == id && p.Provider == provider {
			return p, nil
		}
	}
	return Profile{}, Fault("profile_unverified")
}

// Qualify applies service-owned admission policy, never a request-controlled upgrade.
func Qualify(p Profile, qualified bool) Profile {
	if qualified && p.Capability.Qualification == "unverified" {
		p.Capability.Qualification = "verified"
	}
	return p
}
func ValidateMeasurement(p Profile, e model.UsageEvent) error {
	if !UUID(e.EventID) || !UUID(e.OriginatingStateID) || !Text(e.SourceKey, 256) || !strings.HasPrefix(e.SourceKey, p.SourcePrefix) || p.SourcePrefix == "" || len(e.SourceKey) <= len(p.SourcePrefix) || e.ProfileID != p.ID || !Timestamp(e.ObservedAt) {
		return Fault("invalid_measurement")
	}
	for _, v := range []*string{e.NativeTurnID, e.NativeCallID} {
		if v != nil && !Text(*v, 256) {
			return Fault("invalid_measurement")
		}
	}
	if e.Model != nil && !Text(*e.Model, 128) {
		return Fault("invalid_measurement")
	}
	if _, err := SortedReasons(e.ReasonCodes); err != nil {
		return err
	}
	if !Sequence(e.SourceRevision, false) || e.RevisionAuthority != p.Capability.RevisionAuthority || e.RevisionAuthority == "immutable" && e.SourceRevision != "1" {
		return Fault("invalid_measurement")
	}
	if e.Finality != "final" && e.Finality != "provisional" || e.Disposition != "active" && e.Disposition != "retracted" {
		return Fault("invalid_measurement")
	}
	if e.RevisionAuthority == "immutable" && (e.Finality != "final" || e.Disposition != "active") {
		return Fault("invalid_measurement")
	}
	if e.AggregationRole != "counted" && e.AggregationRole != "included" && e.AggregationRole != "unattributed" {
		return Fault("invalid_measurement")
	}
	if e.AggregationRole == "included" && (!p.AllowInclusion || e.IncludedInSourceKey == nil || !Text(*e.IncludedInSourceKey, 256) || *e.IncludedInSourceKey == e.SourceKey) || e.AggregationRole != "included" && e.IncludedInSourceKey != nil {
		return Fault("invalid_measurement")
	}
	if p.Capability.Qualification != "verified" && e.AggregationRole == "counted" {
		return Fault("profile_unverified")
	}
	if err := Metrics(e.Metrics, p.DisjointCache); err != nil {
		return err
	}
	if e.NativeMetrics == nil {
		return Fault("invalid_measurement")
	}
	raw, err := Canonical(e.NativeMetrics)
	if err != nil || len(raw) > 4096 {
		return Fault("invalid_measurement")
	}
	allowed := map[string]bool{}
	for _, k := range p.NativeKeys {
		allowed[k] = true
	}
	for k, v := range e.NativeMetrics {
		if !allowed[k] {
			return Fault("invalid_measurement")
		}
		if v != nil {
			s, ok := v.(string)
			valid := ok && Decimal(s, 38)
			if k == "agentId" {
				valid = ok && Text(s, 256)
			}
			if k == "agentType" {
				valid = ok && (s == "main" || s == "subagent" || s == "unknown")
			}
			if k == "previousBodyHash" {
				valid = ok && len(s) == 64
				for _, r := range s {
					valid = valid && (r >= '0' && r <= '9' || r >= 'a' && r <= 'f')
				}
			}
			if !valid {
				return Fault("invalid_measurement")
			}
		}
	}
	m := e.Metrics
	if e.Disposition == "retracted" {
		if e.RevisionAuthority != "native" || e.Finality != "final" || len(e.ReasonCodes) == 0 {
			return Fault("invalid_measurement")
		}
		for _, v := range []*string{m.Input, m.Output, m.CacheRead, m.CacheWrite, m.Reasoning, m.Total, m.ProviderTotal} {
			if v != nil {
				return Fault("invalid_measurement")
			}
		}
	}
	if p.Provider == "copilot" {
		eventUUID := strings.TrimPrefix(e.SourceKey, p.SourcePrefix)
		if !UUID(eventUUID) || len(eventUUID) < 15 || eventUUID[14] != '4' || e.Model == nil || m.Input != nil || m.CacheRead != nil || m.CacheWrite != nil || m.Total != nil || m.ProviderTotal != nil {
			return Fault("invalid_measurement")
		}
		if !nativeEqual(e.NativeMetrics, "outputTokens", m.Output) || !nativeEqual(e.NativeMetrics, "reasoningTokens", m.Reasoning) {
			return Fault("invalid_measurement")
		}
	}
	if p.Provider == "claude" {
		if m.Output != nil || m.Reasoning != nil || m.Total != nil || m.ProviderTotal != nil {
			return Fault("invalid_measurement")
		}
		if !nativeEqual(e.NativeMetrics, "cache_read_input_tokens", m.CacheRead) || !nativeEqual(e.NativeMetrics, "cache_creation_input_tokens", m.CacheWrite) {
			return Fault("invalid_measurement")
		}
		sum := new(big.Int)
		known := true
		for _, k := range p.NativeKeys {
			v := e.NativeMetrics[k]
			s, ok := v.(string)
			if !ok {
				known = false
				continue
			}
			n, _ := new(big.Int).SetString(s, 10)
			sum.Add(sum, n)
		}
		if known {
			if m.Input == nil || *m.Input != sum.String() {
				return Fault("invalid_measurement")
			}
		} else if m.Input != nil {
			return Fault("invalid_measurement")
		}
	}
	if p.ID == "codex-response-0.169.0-v1" {
		call := strings.TrimPrefix(e.SourceKey, p.SourcePrefix)
		if len(call) != 64 || e.NativeCallID == nil || *e.NativeCallID != call || e.NativeTurnID == nil || e.Model != nil || m.CacheWrite != nil {
			return Fault("invalid_measurement")
		}
		for _, r := range call {
			if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
				return Fault("invalid_measurement")
			}
		}
		if !nativeEqual(e.NativeMetrics, "inputTokens", m.Input) || !nativeEqual(e.NativeMetrics, "outputTokens", m.Output) || !nativeEqual(e.NativeMetrics, "totalTokens", m.Total) || !nativeEqual(e.NativeMetrics, "totalTokens", m.ProviderTotal) {
			return Fault("invalid_measurement")
		}
		// Upstream defaults missing detail counters to zero. Only positive values
		// establish a known cache or reasoning count in this version's profile.
		for _, detail := range []struct {
			key    string
			metric *string
		}{{"cachedInputTokens", m.CacheRead}, {"reasoningOutputTokens", m.Reasoning}} {
			native := e.NativeMetrics[detail.key]
			if native == nil || native == "0" {
				if detail.metric != nil {
					return Fault("invalid_measurement")
				}
			} else if !nativeEqual(e.NativeMetrics, detail.key, detail.metric) {
				return Fault("invalid_measurement")
			}
		}
		for _, required := range ProfileReasons(p.Provider, p.ID) {
			found := false
			for _, reason := range e.ReasonCodes {
				found = found || reason == required
			}
			if !found {
				return Fault("invalid_measurement")
			}
		}
	}
	return nil
}
func nativeEqual(m map[string]any, k string, v *string) bool {
	n := m[k]
	if v == nil {
		return n == nil
	}
	s, ok := n.(string)
	return ok && s == *v
}
