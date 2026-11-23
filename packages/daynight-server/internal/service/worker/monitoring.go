package worker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/monitoring"
)

type monitoringRules struct {
	scopes            func(monitoring.Observation) ([]string, []string)
	validateExecution func(monitoring.Observation, store.WorkerMonitoringSources, string, string) error
	project           func(*monitoring.DetailResponse, store.WorkerMonitoringSources) error
	summaryScopes     func([]monitoring.StoredSummary) ([]string, []string)
	projectSummary    func(monitoring.StoredSummary, store.WorkerMonitoringSources) (json.RawMessage, error)
}

func defaultMonitoringRules() monitoringRules {
	return monitoringRules{scopes: workercore.MonitoringScopes, validateExecution: workercore.ValidateMonitoringExecution, project: workercore.ProjectMonitoring,
		summaryScopes: workercore.MonitoringSummaryScopes, projectSummary: workercore.ProjectMonitoringSummary}
}

func validateMonitoringIDs(ids []string) error {
	if len(ids) < 1 || len(ids) > 100 {
		return &model.Fault{Code: "invalid_input", Message: "Monitoring requires 1 to 100 distinct worker IDs."}
	}
	seen := make(map[string]bool, len(ids))
	for _, id := range ids {
		canonical, err := model.CanonicalID(id)
		if err != nil || canonical != id || seen[id] {
			return &model.Fault{Code: "invalid_input", Message: "Monitoring requires distinct canonical worker IDs."}
		}
		seen[id] = true
	}
	return nil
}

// SetMonitoringStore binds the independently owned monitoring dependency during assembly.
func (s *Workers) SetMonitoringStore(m store.MonitoringStore) { s.monitoring = m }
func monitoringUnavailable(err error) error {
	return &model.Fault{Code: "monitoring_unavailable", Message: "Worker monitoring is unavailable.", Cause: err}
}
func (s *Workers) monitoringResources(ctx context.Context, principal model.Principal, ids []string, projects, tasks []string, operations ...scopepolicy.Operation) (store.WorkerMonitoringSources, error) {
	var sources store.WorkerMonitoringSources
	var refusal error
	err := s.store.ReadSnapshot(ctx, func(snapshot store.SnapshotScope) error {
		if err := s.readAdmission(ctx, snapshot, principal, operations...); err != nil {
			return err
		}
		now, err := snapshot.ObservedAt(ctx)
		if err != nil {
			return err
		}
		dao, ok := snapshot.WorkerDAO().(store.WorkerMonitoringReader)
		if !ok {
			return fmt.Errorf("monitoring resource reader unavailable")
		}
		found, err := dao.MonitoringWorkers(ctx, principal.UserID, ids, now)
		if err != nil {
			return err
		}
		admitted := make(map[string]bool, len(found))
		for _, id := range found {
			admitted[id] = true
		}
		for _, id := range ids {
			if !admitted[id] {
				refusal = &model.Fault{Code: "not_found", Message: "Worker was not found."}
				return nil
			}
		}
		if len(projects) > 0 || len(tasks) > 0 {
			sources, err = dao.MonitoringSources(ctx, principal.UserID, projects, tasks)
		}
		return err
	})
	if err != nil {
		return sources, fmt.Errorf("read monitoring resources: %w", err)
	}
	return sources, refusal
}
func (s *Workers) PutMonitoring(ctx context.Context, p model.Principal, workerID string, expected *string, o monitoring.Observation) (monitoring.Receipt, error) {
	return s.putMonitoring(ctx, p, workerID, expected, o, defaultMonitoringRules())
}

// SaveDirectMonitoring saves one complete observation without consulting the prior value.
func (s *Workers) SaveDirectMonitoring(ctx context.Context, p model.Principal, workerID string, direct monitoring.DirectObservation) (monitoring.DirectReceipt, string, error) {
	return s.saveDirectMonitoring(ctx, p, workerID, direct, defaultMonitoringRules())
}

func (s *Workers) saveDirectMonitoring(ctx context.Context, p model.Principal, workerID string, direct monitoring.DirectObservation, rules monitoringRules) (monitoring.DirectReceipt, string, error) {
	var empty monitoring.DirectReceipt
	if err := model.RequirePrincipal(p); err != nil {
		return empty, "", err
	}
	if err := validateMonitoringIDs([]string{workerID}); err != nil {
		return empty, "", err
	}
	raw, err := json.Marshal(direct)
	if err != nil {
		return empty, "", &model.Fault{Code: "invalid_input", Message: "Invalid worker monitoring observation."}
	}
	direct, err = monitoring.ParseDirectObservation(raw)
	if err != nil {
		return empty, "", err
	}
	sample, err := uuid.NewRandom()
	if err != nil {
		return empty, "", monitoringUnavailable(err)
	}
	sampleID := sample.String()
	o := monitoring.LegacyObservationForDirect(direct, sampleID)
	projects, tasks := rules.scopes(o)
	sources, err := s.monitoringResources(ctx, p, []string{workerID}, projects, tasks, scopepolicy.WorkerReport)
	if err != nil {
		return empty, "", err
	}
	if err = rules.validateExecution(o, sources, p.UserID, workerID); err != nil {
		return empty, "", err
	}
	if s.monitoring == nil {
		return empty, "", monitoringUnavailable(nil)
	}
	body, err := json.Marshal(o)
	if err != nil {
		return empty, "", err
	}
	summary, err := monitoring.Summary(o)
	if err != nil {
		return empty, "", err
	}
	receipt, err := s.monitoring.Save(ctx, store.MonitoringIdentity{UserID: p.UserID, WorkerID: workerID}, store.MonitoringCandidate{RunID: sampleID, Sequence: "1", Body: body, Summary: summary})
	if err != nil {
		if errors.Is(err, store.ErrMonitoringWriteOutcomeUnknown) {
			return empty, "", &model.Fault{Code: "monitoring_write_outcome_unknown", Message: "Monitoring write outcome is unknown.", Cause: err}
		}
		return empty, "", monitoringUnavailable(err)
	}
	return monitoring.DirectReceipt{ReceivedAt: receipt.ReceivedAt, ExpiresAt: receipt.ExpiresAt}, sampleID, nil
}

func (s *Workers) putMonitoring(ctx context.Context, p model.Principal, workerID string, expected *string, o monitoring.Observation, rules monitoringRules) (monitoring.Receipt, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return monitoring.Receipt{}, err
	}
	if err := validateMonitoringIDs([]string{workerID}); err != nil {
		return monitoring.Receipt{}, err
	}
	if expected != nil {
		canonical, err := model.CanonicalID(*expected)
		if err != nil || canonical != *expected {
			return monitoring.Receipt{}, &model.Fault{Code: "invalid_input", Message: "Monitoring revision must be a canonical UUID."}
		}
	}
	raw, err := json.Marshal(o)
	if err != nil {
		return monitoring.Receipt{}, &model.Fault{Code: "invalid_input", Message: "Invalid worker monitoring observation."}
	}
	o, err = monitoring.ParseObservation(raw)
	if err != nil {
		return monitoring.Receipt{}, err
	}
	projects, tasks := rules.scopes(o)
	sources, err := s.monitoringResources(ctx, p, []string{workerID}, projects, tasks, scopepolicy.WorkerReport)
	if err != nil {
		return monitoring.Receipt{}, err
	}
	if err = rules.validateExecution(o, sources, p.UserID, workerID); err != nil {
		return monitoring.Receipt{}, err
	}
	if s.monitoring == nil {
		return monitoring.Receipt{}, monitoringUnavailable(nil)
	}
	body, err := json.Marshal(o)
	if err != nil {
		return monitoring.Receipt{}, err
	}
	summary, err := monitoring.Summary(o)
	if err != nil {
		return monitoring.Receipt{}, err
	}
	res, err := s.monitoring.CompareAndSet(ctx, store.MonitoringIdentity{UserID: p.UserID, WorkerID: workerID}, expected, store.MonitoringCandidate{RunID: o["runId"].(string), Sequence: o["sequence"].(string), Body: body, Summary: summary})
	if err != nil {
		if errors.Is(err, store.ErrMonitoringWriteOutcomeUnknown) {
			return monitoring.Receipt{}, &model.Fault{Code: "monitoring_write_outcome_unknown", Message: "Monitoring write outcome is unknown.", Cause: err}
		}
		return monitoring.Receipt{}, monitoringUnavailable(err)
	}
	switch res.Kind {
	case store.MonitoringAccepted, store.MonitoringDuplicate:
		if res.Receipt != nil {
			return *res.Receipt, nil
		}
		return monitoring.Receipt{}, monitoringUnavailable(errors.New("missing monitoring receipt"))
	case store.MonitoringRevisionConflict:
		return monitoring.Receipt{}, &model.Fault{Code: "monitoring_revision_conflict", Message: "Monitoring revision conflict."}
	case store.MonitoringSequenceStale:
		return monitoring.Receipt{}, &model.Fault{Code: "monitoring_sequence_stale", Message: "Monitoring sequence is stale."}
	case store.MonitoringSampleConflict:
		return monitoring.Receipt{}, &model.Fault{Code: "monitoring_sample_conflict", Message: "Monitoring sample conflicts."}
	case store.MonitoringStateLost:
		return monitoring.Receipt{}, &model.Fault{Code: "monitoring_state_lost", Message: "Monitoring state was lost."}
	default:
		return monitoring.Receipt{}, monitoringUnavailable(errors.New("invalid monitoring result"))
	}
}
func (s *Workers) GetMonitoring(ctx context.Context, p model.Principal, id string) (monitoring.DetailResponse, error) {
	return s.getMonitoring(ctx, p, id, defaultMonitoringRules())
}

func (s *Workers) getMonitoring(ctx context.Context, p model.Principal, id string, rules monitoringRules) (monitoring.DetailResponse, error) {
	var out monitoring.DetailResponse
	if err := model.RequirePrincipal(p); err != nil {
		return out, err
	}
	if err := validateMonitoringIDs([]string{id}); err != nil {
		return out, err
	}
	if _, err := s.monitoringResources(ctx, p, []string{id}, nil, nil, scopepolicy.WorkerRead); err != nil {
		return out, err
	}
	if s.monitoring == nil {
		return out, monitoringUnavailable(nil)
	}
	read, err := s.monitoring.Read(ctx, store.MonitoringIdentity{UserID: p.UserID, WorkerID: id})
	if err != nil {
		return out, monitoringUnavailable(err)
	}
	out = monitoring.DetailResponse{ObservedAt: read.ObservedAt, State: "absent", DetailCoverage: "complete", PermissionProjection: "current"}
	if read.Value == nil {
		return out, nil
	}
	o, err := monitoring.ParseStoredObservation(read.Value.Body)
	if err != nil {
		return monitoring.DetailResponse{}, monitoringUnavailable(&store.MonitoringError{Kind: "format", Cause: err})
	}
	projects, tasks := rules.scopes(o)
	sources, err := s.monitoringResources(ctx, p, []string{id}, projects, tasks, scopepolicy.WorkerRead)
	if err != nil {
		return monitoring.DetailResponse{}, err
	}
	receipt := read.Value.Receipt
	out.State = "available"
	out.Revision = &receipt.Revision
	out.RunID = &receipt.RunID
	out.Sequence = &receipt.Sequence
	out.ReceivedAt = &receipt.ReceivedAt
	out.ExpiresAt = &receipt.ExpiresAt
	out.Data = o
	out.DetailCoverage = o["detailCoverage"].(string)
	if err = rules.project(&out, sources); err != nil {
		return monitoring.DetailResponse{}, monitoringUnavailable(err)
	}
	return out, nil
}
func (s *Workers) QueryMonitoring(ctx context.Context, p model.Principal, ids []string) (monitoring.QueryResponse, error) {
	return s.queryMonitoring(ctx, p, ids, defaultMonitoringRules())
}

func (s *Workers) queryMonitoring(ctx context.Context, p model.Principal, ids []string, rules monitoringRules) (monitoring.QueryResponse, error) {
	var out monitoring.QueryResponse
	if err := model.RequirePrincipal(p); err != nil {
		return out, err
	}
	if err := validateMonitoringIDs(ids); err != nil {
		return out, err
	}
	if _, err := s.monitoringResources(ctx, p, ids, nil, nil, scopepolicy.WorkerRead); err != nil {
		return out, err
	}
	if s.monitoring == nil {
		return out, monitoringUnavailable(nil)
	}
	identities := make([]store.MonitoringIdentity, len(ids))
	for i, id := range ids {
		identities[i] = store.MonitoringIdentity{UserID: p.UserID, WorkerID: id}
	}
	read, err := s.monitoring.ReadSummaries(ctx, identities)
	if err != nil {
		return out, monitoringUnavailable(err)
	}
	if len(read.Values) != len(ids) {
		return out, monitoringUnavailable(errors.New("invalid monitoring summary count"))
	}
	stored := make([]monitoring.StoredSummary, len(ids))
	for i, v := range read.Values {
		if v == nil {
			continue
		}
		stored[i], err = monitoring.ParseStoredSummary(v.Summary)
		if err != nil {
			return monitoring.QueryResponse{}, monitoringUnavailable(&store.MonitoringError{Kind: "format", Cause: err})
		}
	}
	projects, tasks := rules.summaryScopes(stored)
	// Access may change while Redis is being read. Recheck all Workers and
	// qualify references together in the same current PostgreSQL snapshot.
	sources, err := s.monitoringResources(ctx, p, ids, projects, tasks, scopepolicy.WorkerRead)
	if err != nil {
		return monitoring.QueryResponse{}, err
	}
	out = monitoring.QueryResponse{ObservedAt: read.ObservedAt, Items: make([]monitoring.QueryItem, 0, len(ids))}
	for i, v := range read.Values {
		item := monitoring.QueryItem{WorkerID: ids[i], State: "absent"}
		if v != nil {
			item.State = "available"
			item.Revision = &v.Receipt.Revision
			item.ReceivedAt = &v.Receipt.ReceivedAt
			item.ExpiresAt = &v.Receipt.ExpiresAt
			summary, err := rules.projectSummary(stored[i], sources)
			if err != nil {
				return monitoring.QueryResponse{}, monitoringUnavailable(err)
			}
			item.Summary = summary
		}
		out.Items = append(out.Items, item)
	}
	encoded, err := json.Marshal(out)
	if err != nil || len(encoded)+1 > monitoring.MaxQuery {
		return monitoring.QueryResponse{}, monitoringUnavailable(errors.New("monitoring summary exceeds response budget"))
	}
	return out, nil
}
