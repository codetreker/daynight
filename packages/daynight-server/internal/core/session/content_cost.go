package session

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"sort"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

// MaxSessionContentBytes bounds accepted logical content, independently of the
// compatibility image budget and of temporary file or database storage.
const MaxSessionContentBytes int64 = 128 * 1024 * 1024

type contentCost struct {
	TimelineBytes, IndexBytes, ResourceBytes, ResourceMetadataBytes, ManifestBytes int64
}

type contentState struct {
	ledger        *archiveLedger
	resources     []sp.Resource
	manifestBytes int64
}

type contentCapacityError struct{ cause error }

func (e *contentCapacityError) Error() string { return e.cause.Error() }
func (e *contentCapacityError) Unwrap() error { return e.cause }

// Only validated publication candidates can replace a measured component.
type actualContentChange interface{ apply(*contentState) error }
type historyContentChange struct{ ledger archiveLedger }
type resourceContentChange struct{ resource sp.Resource }
type manifestContentChange struct{ data []byte }
type sealedDescriptorsChange struct{ resources []sp.Resource }

func (c historyContentChange) apply(s *contentState) error { s.ledger = &c.ledger; return nil }
func (c resourceContentChange) apply(s *contentState) error {
	if c.resource.Status != "available" || c.resource.ByteLength == nil || c.resource.ResourceID == "" {
		return errors.New("invalid resource publication candidate")
	}
	for i, resource := range s.resources {
		if resource.ResourceID == c.resource.ResourceID {
			if !jsonEqual(encode(resource), encode(c.resource)) {
				return archiveConflict()
			}
			s.resources[i] = c.resource
			return nil
		}
	}
	if len(s.resources) >= sp.MaxSessionResources {
		return fault("quota_exceeded", "Session resource collection is full.")
	}
	s.resources = append(s.resources, c.resource)
	return nil
}
func (c sealedDescriptorsChange) apply(s *contentState) error {
	for _, resource := range c.resources {
		if resource.Status == "available" {
			continue
		}
		if resource.Status != "failed" && resource.Status != "unavailable" || resource.ResourceID == "" {
			return archiveConflict()
		}
		found := false
		for _, current := range s.resources {
			if current.ResourceID == resource.ResourceID {
				if !jsonEqual(encode(current), encode(resource)) {
					return archiveConflict()
				}
				found = true
				break
			}
		}
		if !found {
			if len(s.resources) >= sp.MaxSessionResources {
				return fault("quota_exceeded", "Session resource collection is full.")
			}
			s.resources = append(s.resources, resource)
		}
	}
	return nil
}

func (c manifestContentChange) apply(s *contentState) error {
	s.manifestBytes = int64(len(c.data))
	return nil
}

func checkedContentSum(a, b int64) (int64, error) {
	if a < 0 || b < 0 || a > math.MaxInt64-b {
		return 0, errors.New("invalid content size")
	}
	return a + b, nil
}

func measureContent(s contentState) (contentCost, error) {
	var cost contentCost
	var err error
	if s.ledger != nil {
		cost.TimelineBytes = 14
		for i, entry := range s.ledger.Entries {
			if i > 0 {
				cost.TimelineBytes, err = checkedContentSum(cost.TimelineBytes, 1)
				if err != nil {
					return cost, err
				}
			}
			cost.TimelineBytes, err = checkedContentSum(cost.TimelineBytes, int64(entry.ByteLength))
			if err != nil {
				return cost, err
			}
		}
		entries := s.ledger.Entries
		if entries == nil {
			entries = []archiveLedgerEntry{}
		}
		occurrences := s.ledger.Occurrences
		if occurrences == nil {
			occurrences = []archiveLedgerOccurrence{}
		}
		index, err := sp.MarshalWire(struct {
			Entries     []archiveLedgerEntry      `json:"entries"`
			Occurrences []archiveLedgerOccurrence `json:"occurrences"`
		}{entries, occurrences})
		if err != nil {
			return cost, err
		}
		cost.IndexBytes = int64(len(index))
	}
	resources := append([]sp.Resource(nil), s.resources...)
	sort.Slice(resources, func(i, j int) bool { return resources[i].ResourceID < resources[j].ResourceID })
	for i, r := range resources {
		if r.ResourceID == "" || i > 0 && resources[i-1].ResourceID == r.ResourceID {
			return cost, errors.New("invalid committed resource")
		}
		if r.Status != "available" {
			if r.Status != "failed" && r.Status != "unavailable" {
				return cost, errors.New("invalid committed resource")
			}
			continue
		}
		if r.ByteLength == nil {
			return cost, errors.New("invalid committed resource")
		}
		length, e := strconv.ParseInt(*r.ByteLength, 10, 64)
		if e != nil {
			return cost, errors.New("invalid committed resource length")
		}
		cost.ResourceBytes, err = checkedContentSum(cost.ResourceBytes, length)
		if err != nil {
			return cost, err
		}
	}
	if len(resources) > 0 {
		data, err := sp.MarshalWire(struct {
			Resources []sp.Resource `json:"resources"`
		}{resources})
		if err != nil {
			return cost, err
		}
		cost.ResourceMetadataBytes = int64(len(data))
	}
	cost.ManifestBytes = s.manifestBytes
	return cost, nil
}

func checkContentReplacement(s contentState, change actualContentChange) (contentCost, error) {
	if err := change.apply(&s); err != nil {
		return contentCost{}, err
	}
	cost, err := measureContent(s)
	if err != nil {
		return cost, err
	}
	var total int64
	for _, part := range []int64{cost.TimelineBytes, cost.IndexBytes, cost.ResourceBytes, cost.ResourceMetadataBytes, cost.ManifestBytes} {
		total, err = checkedContentSum(total, part)
		if err != nil {
			return cost, err
		}
	}
	if total > MaxSessionContentBytes {
		return cost, fault("quota_exceeded", "Session content capacity is exhausted.")
	}
	return cost, nil
}

// The caller already holds the authorized Session row lock. Read all component
// facts in that same transaction immediately before saving the publication.
func checkContentPublication(ctx context.Context, tx *operationTx, id string, change actualContentChange) error {
	media, err := resourceDAO(tx)
	if err != nil {
		return err
	}
	rows, err := media.ListSessionResources(ctx, id)
	if err != nil {
		return err
	}
	state := contentState{}
	for _, row := range rows {
		if row.Resource.Status == "available" || row.Resource.Status == "failed" || row.Resource.Status == "unavailable" {
			state.resources = append(state.resources, row.Resource)
		}
	}
	dao, err := archiveDAO(tx)
	if err != nil {
		return err
	}
	bundle, err := dao.SessionArchiveBundle(ctx, id)
	if err != nil && !errors.Is(err, model.ErrNotFound) {
		return err
	}
	if err == nil {
		var ledger archiveLedger
		if err = json.Unmarshal(bundle.Ledger, &ledger); err != nil {
			return errors.New("invalid persisted archive ledger")
		}
		if ledger.HistoryID != "" {
			state.ledger = &ledger
		}
		if bundle.Phase == "committed" || bundle.Phase == "verified" {
			state.manifestBytes, err = strconv.ParseInt(bundle.ManifestLength, 10, 64)
			if err != nil || state.manifestBytes < 0 {
				return errors.New("invalid published manifest length")
			}
		}
	}
	if sealed, ok := change.(sealedDescriptorsChange); ok {
		candidate := state
		candidate.resources = append([]sp.Resource(nil), state.resources...)
		if err = sealed.apply(&candidate); err != nil {
			return err
		}
		if len(candidate.resources) == len(state.resources) {
			return nil
		}
	}
	_, err = checkContentReplacement(state, change)
	var refusal *model.Fault
	if errors.As(err, &refusal) && refusal.Code == "quota_exceeded" {
		return &contentCapacityError{cause: err}
	}
	return err
}
