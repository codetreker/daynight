package usage

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	"github.com/google/uuid"
)

type Batch struct {
	Protocol string             `json:"protocol"`
	BatchID  string             `json:"batchId"`
	Events   []model.UsageEvent `json:"events"`
}
type EventResult struct {
	EventID        string  `json:"eventId"`
	SourceKey      *string `json:"sourceKey"`
	Outcome        string  `json:"outcome"`
	RowID          string  `json:"rowId"`
	RowVersion     string  `json:"rowVersion"`
	SourceRevision *string `json:"sourceRevision"`
	StateSequence  *string `json:"stateSequence"`
	Finality       *string `json:"finality"`
	BodyHash       string  `json:"bodyHash"`
}
type BatchResult struct {
	Protocol   string        `json:"protocol"`
	BatchID    string        `json:"batchId"`
	Results    []EventResult `json:"results"`
	ObservedAt time.Time     `json:"observedAt"`
}

func result(e model.UsageEvent, r model.UsageRecord, outcome string) EventResult {
	return EventResult{EventID: e.EventID, SourceKey: r.SourceKey, Outcome: outcome, RowID: r.ID, RowVersion: r.RowVersion, SourceRevision: r.SourceRevision, StateSequence: r.StateSequence, Finality: r.Finality, BodyHash: r.BodyHash}
}
func recordConflict(ctx context.Context, dao store.UsageDAO, original model.UsageRecord, fault *model.UsageFault, eventID string, now time.Time) (*model.UsageFault, error) {
	next, changed, err := core.MarkConflict(original, now)
	if err != nil {
		return nil, err
	}
	if changed {
		if err = dao.Replace(ctx, next, original.RowVersion); err != nil {
			return nil, err
		}
	}
	if err = dao.Guard(ctx, next); err != nil {
		return nil, err
	}
	fault.EventID = eventID
	fault.DiagnosticCommitted = true
	fault.RowVersion = next.RowVersion
	return fault, nil
}

func (s *Service) Batch(ctx context.Context, id, token string, input Batch) (BatchResult, error) {
	out := BatchResult{Protocol: core.Protocol, BatchID: input.BatchID, Results: []EventResult{}}
	if input.Protocol != core.Protocol || !core.UUID(input.BatchID) || len(input.Events) < 1 || len(input.Events) > 100 {
		return out, core.Fault("invalid_batch")
	}
	seen := map[string]bool{}
	for _, e := range input.Events {
		if !core.UUID(e.EventID) || seen[e.EventID] {
			return out, core.Fault("invalid_batch")
		}
		seen[e.EventID] = true
	}
	var diagnostic *model.UsageFault
	err := s.write(ctx, func(scope store.UsageScope) error {
		dao := scope.UsageDAO()
		upload, err := dao.State(ctx, id)
		if err != nil {
			return err
		}
		session, err := dao.Session(ctx, upload.SessionID)
		if err != nil {
			return err
		}
		if _, err = s.authority(ctx, scope, session, upload.AuthorityUserID, core.Value(upload.ParentCredentialID), true); err != nil {
			return err
		}
		now, err := dao.Now(ctx)
		if err != nil {
			return err
		}
		out.ObservedAt = now
		if err = validateGrant(upload, token, now); err != nil {
			return err
		}
		states := map[string]model.UsageRecord{id: upload}
		for _, e := range input.Events {
			if e.Kind == "measurement" {
				if !core.UUID(e.OriginatingStateID) {
					return core.Fault("origin_unavailable")
				}
				if _, ok := states[e.OriginatingStateID]; !ok {
					r, e2 := dao.State(ctx, e.OriginatingStateID)
					if e2 != nil {
						return core.Fault("origin_unavailable")
					}
					if r.SessionID != upload.SessionID || core.Anchor(r) != core.Anchor(upload) || r.Provider != upload.Provider || r.NativeSessionID != upload.NativeSessionID || r.AuthorityUserID != upload.AuthorityUserID || r.GrantRevokedAt != nil || r.GrantExpiresAt == nil || !now.Before(*r.GrantExpiresAt) || core.Value(r.ParentCredentialID) != core.Value(upload.ParentCredentialID) {
						return core.Fault("origin_unavailable")
					}
					states[r.ID] = r
				}
			} else if e.Kind != "execution_state" {
				return core.Fault("invalid_batch")
			}
		}
		for _, key := range orderedIDs(states) {
			if err = dao.Guard(ctx, states[key]); err != nil {
				return err
			}
		}
		for _, e := range input.Events {
			if e.Kind == "measurement" {
				origin := states[e.OriginatingStateID]
				p, e2 := s.profile(origin.ProfileID, origin.Provider, origin.ProviderVersion)
				if e2 != nil {
					return e2
				}
				if err = core.ValidateMeasurement(p, e); err != nil {
					return err
				}
			} else {
				if len(input.Events) > 1 && e.CollectionState == "complete" {
					return core.Fault("invalid_batch")
				}
				p, e2 := s.profile(upload.ProfileID, upload.Provider, upload.ProviderVersion)
				if e2 != nil {
					return e2
				}
				validationBase := upload
				validationBase.SealedAt = nil
				validationBase.ReasonCodes = []string{}
				if _, e2 = core.ApplyState(validationBase, e, p, now); e2 != nil {
					return e2
				}
			}
		}
		type change struct {
			record   model.UsageRecord
			expected string
			insert   bool
		}
		changes := map[string]change{}
		staged := map[string]model.UsageRecord{}
		results := make([]EventResult, len(input.Events))
		order := make([]int, len(input.Events))
		for i := range order {
			order[i] = i
		}
		sort.SliceStable(order, func(i, j int) bool {
			a, b := input.Events[order[i]], input.Events[order[j]]
			ka, kb := a.Kind+":"+a.SourceKey, b.Kind+":"+b.SourceKey
			return ka < kb
		})
		for _, i := range order {
			e := input.Events[i]
			var old, candidate model.UsageRecord
			var found bool
			var key, revision, hash string
			if e.Kind == "execution_state" {
				if len(input.Events) > 1 && e.CollectionState == "complete" {
					return core.Fault("invalid_batch")
				}
				old = upload
				key = "state:" + id
				if r, ok := staged[key]; ok {
					old = r
				}
				p, e2 := s.profile(old.ProfileID, old.Provider, old.ProviderVersion)
				if e2 != nil {
					return e2
				}
				validationBase := old
				validationBase.SealedAt = nil
				validationBase.ReasonCodes = []string{}
				candidate, err = core.ApplyState(validationBase, e, p, now)
				if err != nil {
					return err
				}
				hash = candidate.BodyHash
				revision = e.StateSequence
				found = true
			} else {
				origin := states[e.OriginatingStateID]
				p, e2 := s.profile(origin.ProfileID, origin.Provider, origin.ProviderVersion)
				if e2 != nil {
					return e2
				}
				if err = core.ValidateMeasurement(p, e); err != nil {
					return err
				}
				key = "source:" + e.SourceKey
				old, found = staged[key]
				if !found {
					old, err = dao.Source(ctx, origin, e.SourceKey)
					found = err == nil
					if err != nil && !errors.Is(err, model.ErrNotFound) {
						return err
					}
				}
				if found && (old.SessionID != origin.SessionID || core.Value(old.StateID) != origin.ID || core.Anchor(old) != core.Anchor(origin)) {
					return core.Fault("origin_unavailable")
				}
				candidate, err = core.Measurement(origin, e, uuid.NewString(), now)
				if err != nil {
					return err
				}
				hash = candidate.BodyHash
				revision = e.SourceRevision
			}
			outcome := "inserted"
			if e.Kind == "measurement" && e.Disposition == "retracted" {
				previous, ok := e.NativeMetrics["previousBodyHash"].(string)
				if !found || !ok || previous != old.BodyHash || e.SourceRevision == core.Value(old.SourceRevision) {
					return core.Fault("invalid_measurement")
				}
			}
			if found {
				outcome, err = core.Decide(old, revision, hash, e.Finality, e.Kind == "execution_state")
				if err != nil {
					var fault *model.UsageFault
					if errors.As(err, &fault) && (fault.Code == "source_conflict" || fault.Code == "finality_regression") {
						originID := id
						if e.Kind == "measurement" {
							originID = e.OriginatingStateID
						}
						diagnostic, err = recordConflict(ctx, dao, states[originID], fault, e.EventID, now)
						return err
					}
					return err
				}
				if outcome == "duplicate" || outcome == "stale" {
					staged[key] = old
					results[i] = result(e, old, outcome)
					continue
				}
				if e.Kind == "execution_state" {
					p, e2 := s.profile(old.ProfileID, old.Provider, old.ProviderVersion)
					if e2 != nil {
						return e2
					}
					candidate, e2 = core.ApplyState(old, e, p, now)
					if e2 != nil {
						var fault *model.UsageFault
						if errors.As(e2, &fault) && (fault.Code == "source_conflict" || fault.Code == "finality_regression") {
							diagnostic, err = recordConflict(ctx, dao, states[id], fault, e.EventID, now)
							return err
						}
						return e2
					}
				}
				candidate.ID = old.ID
				candidate.CreatedAt = old.CreatedAt
				candidate.RowVersion, err = core.Next(old.RowVersion)
				if err != nil {
					return err
				}
			}
			staged[key] = candidate
			if existing, ok := changes[key]; ok {
				existing.record = candidate
				changes[key] = existing
			} else {
				changes[key] = change{candidate, old.RowVersion, !found}
			}
			results[i] = result(e, candidate, outcome)
		}
		keys := make([]string, 0, len(changes))
		for k := range changes {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			c := changes[k]
			if c.insert {
				err = dao.Insert(ctx, c.record)
			} else {
				err = dao.Replace(ctx, c.record, c.expected)
			}
			if err != nil {
				return err
			}
		}
		for _, key := range orderedIDs(states) {
			state := states[key]
			if change, ok := changes["state:"+key]; ok {
				state = change.record
			}
			if err = dao.Guard(ctx, state); err != nil {
				return err
			}
		}
		for i, e := range input.Events {
			key := "source:" + e.SourceKey
			if e.Kind == "execution_state" {
				key = "state:" + id
			}
			current := staged[key]
			outcome := results[i].Outcome
			if results[i].BodyHash != current.BodyHash {
				outcome = "stale"
			}
			results[i] = result(e, current, outcome)
		}
		out.Results = results
		return nil
	})
	if err != nil {
		return BatchResult{}, err
	}
	if diagnostic != nil {
		return BatchResult{}, diagnostic
	}
	return out, nil
}

type SourceState struct {
	SourceKey          string  `json:"sourceKey"`
	OriginatingStateID string  `json:"originatingStateId"`
	SourceRevision     *string `json:"sourceRevision"`
	Finality           *string `json:"finality"`
	BodyHash           string  `json:"bodyHash"`
	RowVersion         string  `json:"rowVersion"`
}
type SourcesResult struct {
	Items         []SourceState `json:"items"`
	MissingKeys   []string      `json:"missingKeys"`
	StateSequence *string       `json:"stateSequence"`
	BodyHash      string        `json:"bodyHash"`
}

func (s *Service) Sources(ctx context.Context, id, token string, keys []string) (SourcesResult, error) {
	out := SourcesResult{Items: []SourceState{}, MissingKeys: []string{}}
	if len(keys) < 1 || len(keys) > 100 {
		return out, core.Fault("invalid_batch")
	}
	seen := map[string]bool{}
	for _, k := range keys {
		if !core.Text(k, 256) || seen[k] {
			return out, core.Fault("invalid_batch")
		}
		seen[k] = true
	}
	err := s.database.ReadUsage(ctx, func(scope store.UsageScope) error {
		dao := scope.UsageDAO()
		r, err := dao.State(ctx, id)
		if err != nil {
			return err
		}
		session, err := dao.Session(ctx, r.SessionID)
		if err != nil {
			return err
		}
		if _, err = s.authority(ctx, scope, session, r.AuthorityUserID, core.Value(r.ParentCredentialID), false); err != nil {
			return err
		}
		now, err := dao.Now(ctx)
		if err != nil {
			return err
		}
		if err = validateGrant(r, token, now); err != nil {
			return err
		}
		out.StateSequence = r.StateSequence
		out.BodyHash = r.BodyHash
		for _, key := range keys {
			source, e := dao.Source(ctx, r, key)
			if errors.Is(e, model.ErrNotFound) {
				out.MissingKeys = append(out.MissingKeys, key)
				continue
			}
			if e != nil {
				return e
			}
			if core.Anchor(source) != core.Anchor(r) || source.SessionID != r.SessionID {
				return core.Fault("resource_unavailable")
			}
			out.Items = append(out.Items, SourceState{key, core.Value(source.StateID), source.SourceRevision, source.Finality, source.BodyHash, source.RowVersion})
		}
		return nil
	})
	return out, err
}
