package usage

import (
	"encoding/hex"
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func MeasurementHash(state model.UsageRecord, e model.UsageEvent) (string, error) {
	r, err := SortedReasons(e.ReasonCodes)
	if err != nil {
		return "", err
	}
	m := e.Metrics
	return Hash([]any{"daynight.usage.measurement.v1", state.Provider, state.NativeSessionID, e.SourceKey, e.ProfileID, state.ProviderVersion, e.RevisionAuthority, e.SourceRevision, e.Finality, e.Disposition, e.AggregationRole, e.IncludedInSourceKey, e.NativeTurnID, e.NativeCallID, e.Model, m.Input, m.Output, m.CacheRead, m.CacheWrite, m.Reasoning, m.Total, m.ProviderTotal, e.NativeMetrics, r})
}
func StateHash(id string, e model.UsageEvent) (string, error) {
	r, err := SortedReasons(e.ReasonCodes)
	if err != nil {
		return "", err
	}
	return Hash([]any{"daynight.usage.state.v1", id, e.StateSequence, e.CollectionState, e.Capability, r, e.NativeStartedAt, e.NativeEndedAt, e.Seal})
}
func Anchor(r model.UsageRecord) string {
	if r.AnchorStateID != nil {
		return *r.AnchorStateID
	}
	if r.StateID != nil {
		return *r.StateID
	}
	return r.ID
}
func Decide(old model.UsageRecord, revision, hash, finality string, state bool) (string, error) {
	current := Value(old.SourceRevision)
	if state {
		current = Value(old.StateSequence)
	}
	if !state && Value(old.Finality) == "final" && finality == "provisional" {
		return "", conflict("finality_regression", old)
	}
	if !state && Value(old.RevisionAuthority) == "immutable" {
		if hash == old.BodyHash {
			return "duplicate", nil
		}
		return "", conflict("source_conflict", old)
	}
	a, e := strconv.ParseInt(current, 10, 64)
	if e != nil {
		return "", e
	}
	b, e := strconv.ParseInt(revision, 10, 64)
	if e != nil {
		return "", e
	}
	if b < a {
		if !state && Value(old.Finality) == "provisional" && finality == "final" {
			return "", conflict("finality_regression", old)
		}
		return "stale", nil
	}
	if b == a {
		if old.BodyHash == hash {
			return "duplicate", nil
		}
		return "", conflict("source_conflict", old)
	}
	return "replaced", nil
}
func conflict(code string, r model.UsageRecord) *model.UsageFault {
	return &model.UsageFault{Code: code, SourceKey: Value(r.SourceKey), CurrentRevision: r.SourceRevision, CurrentBodyHash: r.BodyHash}
}
func ValidateInclusion(child, parent model.UsageRecord) error {
	if Value(child.AggregationRole) != "included" || Value(parent.AggregationRole) != "counted" || Value(child.IncludedInSourceKey) != Value(parent.SourceKey) || Anchor(child) != Anchor(parent) || child.AuthorityUserID != parent.AuthorityUserID || child.Provider != parent.Provider || child.NativeSessionID != parent.NativeSessionID {
		return Fault("invalid_measurement")
	}
	return nil
}
func Measurement(state model.UsageRecord, e model.UsageEvent, id string, now time.Time) (model.UsageRecord, error) {
	hash, err := MeasurementHash(state, e)
	if err != nil {
		return model.UsageRecord{}, err
	}
	r := state
	r.ID = id
	r.Kind = "measurement"
	r.StateID = Ptr(state.ID)
	r.RegistrationID = nil
	r.SourceKey = Ptr(e.SourceKey)
	r.NativeTurnID = e.NativeTurnID
	r.NativeCallID = e.NativeCallID
	r.Model = e.Model
	r.ProfileID = e.ProfileID
	r.RevisionAuthority = Ptr(e.RevisionAuthority)
	r.SourceRevision = Ptr(e.SourceRevision)
	r.Finality = Ptr(e.Finality)
	r.Disposition = Ptr(e.Disposition)
	r.AggregationRole = Ptr(e.AggregationRole)
	r.IncludedInSourceKey = e.IncludedInSourceKey
	r.Metrics = e.Metrics
	r.NativeMetrics = e.NativeMetrics
	r.Capability = nil
	r.CollectionState = nil
	r.StateSequence = nil
	r.GrantHash = nil
	r.ParentCredentialID = nil
	r.GrantExpiresAt = nil
	r.GrantRevokedAt = nil
	r.SealedAt = nil
	r.NativeStartedAt = nil
	r.NativeEndedAt = nil
	r.ReasonCodes, _ = SortedReasons(e.ReasonCodes)
	r.ObservedAt, _ = time.Parse(time.RFC3339Nano, e.ObservedAt)
	r.CreatedAt = now
	r.UpdatedAt = now
	r.RowVersion = "1"
	r.BodyHash = hash
	return r, nil
}
func ApplyState(old model.UsageRecord, e model.UsageEvent, p Profile, now time.Time) (model.UsageRecord, error) {
	if !UUID(e.EventID) || !Sequence(e.StateSequence, false) || !Timestamp(e.ObservedAt) || e.Capability == nil || !Equal(*e.Capability, p.Capability) {
		return old, Fault("invalid_state")
	}
	if _, err := SortedReasons(e.ReasonCodes); err != nil {
		return old, err
	}
	for _, s := range []*string{e.NativeStartedAt, e.NativeEndedAt} {
		if s != nil && !Timestamp(*s) {
			return old, Fault("invalid_state")
		}
	}
	switch e.CollectionState {
	case "collecting", "complete", "partial", "unsupported", "unavailable":
	default:
		return old, Fault("invalid_state")
	}
	if p.Capability.Qualification == "unverified" {
		found := false
		for _, r := range e.ReasonCodes {
			found = found || r == "profile_unverified"
		}
		if e.CollectionState != "unavailable" || !found {
			return old, Fault("invalid_state")
		}
	}
	if e.CollectionState == "partial" || e.CollectionState == "unsupported" {
		for _, required := range ProfileReasons(p.Provider) {
			found := false
			for _, r := range e.ReasonCodes {
				found = found || r == required
			}
			if !found {
				return old, Fault("invalid_state")
			}
		}
	}
	if e.CollectionState == "complete" && (p.Capability.Completion != "complete_capable" || !e.Seal || e.NativeEndedAt == nil || len(e.ReasonCodes) > 0) {
		return old, Fault("invalid_state")
	}
	if p.Capability.Completion == "unsupported" && e.CollectionState != "unsupported" && e.CollectionState != "unavailable" {
		return old, Fault("invalid_state")
	}
	if old.SealedAt != nil && (!e.Seal || e.CollectionState == "collecting") {
		return old, Fault("finality_regression")
	}
	for _, reason := range old.ReasonCodes {
		if reason == "source_conflict" {
			found := false
			for _, r := range e.ReasonCodes {
				found = found || r == reason
			}
			if !found || e.CollectionState == "complete" || e.CollectionState == "collecting" {
				return old, Fault("source_conflict")
			}
		}
	}
	hash, err := StateHash(old.ID, e)
	if err != nil {
		return old, err
	}
	old.StateSequence = Ptr(e.StateSequence)
	old.CollectionState = Ptr(e.CollectionState)
	old.Capability = e.Capability
	old.ReasonCodes, _ = SortedReasons(e.ReasonCodes)
	old.NativeStartedAt = e.NativeStartedAt
	old.NativeEndedAt = e.NativeEndedAt
	old.ObservedAt, _ = time.Parse(time.RFC3339Nano, e.ObservedAt)
	if e.Seal && old.SealedAt == nil {
		old.SealedAt = &now
	}
	old.UpdatedAt = now
	old.BodyHash = hash
	return old, nil
}
func HashBytes(s string) []byte { b, _ := hex.DecodeString(s); return b }

func MarkConflict(r model.UsageRecord, now time.Time) (model.UsageRecord, bool, error) {
	for _, reason := range r.ReasonCodes {
		if reason == "source_conflict" && Value(r.CollectionState) == "partial" {
			return r, false, nil
		}
	}
	r.ReasonCodes = MergeReasons(r.ReasonCodes, "source_conflict")
	r.CollectionState = Ptr("partial")
	version, err := Next(r.RowVersion)
	if err != nil {
		return r, false, err
	}
	r.RowVersion = version
	r.UpdatedAt = now
	r.BodyHash, err = StateHash(r.ID, model.UsageEvent{StateSequence: Value(r.StateSequence), CollectionState: "partial", Capability: r.Capability, ReasonCodes: r.ReasonCodes, NativeStartedAt: r.NativeStartedAt, NativeEndedAt: r.NativeEndedAt, Seal: r.SealedAt != nil})
	return r, err == nil, err
}

type EffectiveFacts struct {
	Expired, Revoked, Stopped, Known bool
	GapReasons                       []string
}

func Effective(r model.UsageRecord, f EffectiveFacts) (string, []string) {
	state := Value(r.CollectionState)
	reasons := append([]string{}, r.ReasonCodes...)
	if r.SealedAt == nil && (f.Expired || f.Revoked || f.Stopped) {
		state = "unavailable"
		if f.Known {
			state = "partial"
		}
		reasons = MergeReasons(reasons, "missing_final")
		if f.Expired {
			reasons = MergeReasons(reasons, "upload_expired")
		}
		if f.Revoked {
			reasons = MergeReasons(reasons, "permission_revoked")
		}
		if f.Stopped {
			reasons = MergeReasons(reasons, "collector_failed")
		}
	}
	reasons = MergeReasons(reasons, f.GapReasons...)
	if len(f.GapReasons) > 0 && state != "collecting" {
		state = "partial"
	}
	return state, reasons
}
