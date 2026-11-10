package worker

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func completeConfigurationObservation() model.WorkerConfigurationObservation {
	item := func(kind, projectID, value string) model.WorkerConfigurationItem {
		return model.WorkerConfigurationItem{
			Key:            model.WorkerConfigurationItemKey{Kind: kind, ProjectID: projectID},
			TargetRevision: "1", AppliedValue: json.RawMessage(value), State: "applied",
		}
	}
	failedAt := time.Date(2026, time.October, 29, 0, 0, 0, 0, time.UTC)
	next := time.Date(2026, time.October, 29, 0, 0, 5, 0, time.UTC)
	preparation := item("projectPreparation", configurationInputProjectA, "null")
	preparation.State = "error"
	preparation.Error = &model.WorkerConfigurationFailure{Code: "permission_denied", Category: "repository", Phase: "prepare", OccurredAt: failedAt}
	preparation.LastFailure = &model.WorkerConfigurationFailure{Code: "permission_denied", Category: "repository", Phase: "prepare", OccurredAt: failedAt}
	preparation.NextAttemptAt = &next
	return model.WorkerConfigurationObservation{
		BaseRevision: "0", DesiredRevision: "1",
		Items: []model.WorkerConfigurationItem{
			item("maxConcurrent", "", "3"), item("pollIntervalMs", "", "60000"), item("recoveryLimit", "", "0"),
			item("native", "", `{"agent":"claude","args":[],"model":null}`), preparation,
			item("projectRemoval", configurationInputProjectB, "true"),
			item("projectNative", configurationInputProjectA, `{"agent":"claude","args":[],"model":null}`),
		},
	}
}

func observationConfigurationResource(revision string) model.WorkerConfigurationResource {
	value := model.WorkerConfiguration{
		MaxConcurrent: 3, PollIntervalMs: 60000, RecoveryLimit: 0,
		Native:   model.WorkerNativeConfiguration{Agent: model.AgentCodex, Args: []string{}},
		Projects: []model.WorkerProjectConfiguration{},
	}
	updated := time.Date(2026, time.October, 29, 0, 0, 0, 0, time.UTC)
	resource := model.WorkerConfigurationResource{
		Desired: &model.WorkerDesiredConfiguration{Revision: revision, UpdatedAt: updated, Value: value}, ObservationRevision: "0",
	}
	if revision == "2" {
		resource.Desired.Value.MaxConcurrent = 4
		resource.Desired.UpdatedAt = updated.Add(3 * time.Second)
		resource.ObservationRevision = "1"
		resource.Observation = &model.WorkerConfigurationReportedObservation{WorkerConfigurationObservation: completeConfigurationObservation(), ReportedAt: updated.Add(time.Second)}
	}
	return resource
}

func TestConfigurationObservationPreservesCompleteOutcomesAndIndependentCAS(t *testing.T) {
	const userID = "a1111111-1111-4111-8111-111111111111"
	const workerID = "b2222222-2222-4222-8222-222222222222"
	observation := func(value, base, desired, target string) *model.WorkerConfigurationObservation {
		return &model.WorkerConfigurationObservation{BaseRevision: base, DesiredRevision: desired, Items: []model.WorkerConfigurationItem{{
			Key: model.WorkerConfigurationItemKey{Kind: "maxConcurrent"}, TargetRevision: target, AppliedValue: json.RawMessage(value), State: "applied",
		}}}
	}
	cases := []struct {
		name     string
		desired  string
		input    func() model.WorkerConfigurationExchange
		accepted bool
		revision string
		write    int64
	}{
		{"complete initial outcome", "1", func() model.WorkerConfigurationExchange {
			value := completeConfigurationObservation()
			return model.WorkerConfigurationExchange{Observation: &value}
		}, true, "1", 1},
		{"stale outcome", "2", func() model.WorkerConfigurationExchange {
			return model.WorkerConfigurationExchange{Observation: observation("1", "0", "1", "1")}
		}, false, "1", 0},
		{"heartbeat", "2", func() model.WorkerConfigurationExchange { return model.WorkerConfigurationExchange{} }, false, "1", 0},
		{"fresh independent outcome", "2", func() model.WorkerConfigurationExchange {
			return model.WorkerConfigurationExchange{Observation: observation("4", "1", "2", "2")}
		}, true, "2", 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			input, wantInput := tc.input(), tc.input()
			current, wantCurrent := observationConfigurationResource(tc.desired), observationConfigurationResource(tc.desired)
			var calls []string
			d := &capacityConfigurationDAO{t: t}
			d.read = func(actual context.Context, user, worker string) (model.WorkerConfigurationResource, error) {
				calls = append(calls, "read")
				if actual != ctx || user != userID || worker != workerID || d.reads != 1 {
					t.Fatalf("configuration read differs: ctx=%v user=%q worker=%q reads=%d", actual, user, worker, d.reads)
				}
				return current, nil
			}
			if tc.accepted {
				d.observation = func(actual context.Context, user, worker string, revision int64, value model.WorkerConfigurationObservation) error {
					calls = append(calls, "observation")
					if actual != ctx || user != userID || worker != workerID || revision != tc.write || !reflect.DeepEqual(value, *wantInput.Observation) || d.reads != 1 || d.observationWrites != 1 {
						t.Fatalf("complete observation write differs: user=%q worker=%q revision=%d value=%+v reads=%d writes=%d", user, worker, revision, value, d.reads, d.observationWrites)
					}
					return nil
				}
			}
			receipt, err := ExchangeConfiguration(ctx, d, model.Principal{UserID: userID}, workerID, input)
			wantReceipt := &model.WorkerConfigurationReceipt{Desired: observationConfigurationResource(tc.desired).Desired, ObservationRevision: tc.revision, ObservationAccepted: tc.accepted}
			wantCalls, writes := []string{"read"}, 0
			if tc.accepted {
				wantCalls, writes = []string{"read", "observation"}, 1
			}
			if err != nil || !reflect.DeepEqual(receipt, wantReceipt) || !reflect.DeepEqual(calls, wantCalls) || d.reads != 1 || d.desiredWrites != 0 || d.observationWrites != writes {
				t.Fatalf("observation receipt or calls differ: got=%+v want=%+v calls=%v reads=%d desired=%d observation=%d: %v", receipt, wantReceipt, calls, d.reads, d.desiredWrites, d.observationWrites, err)
			}
			if !reflect.DeepEqual(input, wantInput) || !reflect.DeepEqual(current, wantCurrent) {
				t.Fatal("exchange changed supplied observation or independently read facts")
			}
		})
	}
}
