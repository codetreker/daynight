package bot

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type creationReader struct {
	input      model.BotDefaultsInput
	calls      []string
	fail       map[string]error
	beforeScan func()
}

func (r *creationReader) BotPreferredWorker(context.Context, string) (*string, error) {
	r.calls = append(r.calls, "preferred")
	return r.input.PreferredWorkerID, r.fail["preferred"]
}
func (r *creationReader) BotCreationCandidate(_ context.Context, _ string, id string) (model.BotDefaultsInput, error) {
	r.calls = append(r.calls, "candidate:"+id)
	return selectTestWorker(r.input, id), r.fail["candidate"]
}
func (r *creationReader) BotCreationCandidates(context.Context, string) (model.BotDefaultsInput, error) {
	r.calls = append(r.calls, "candidates")
	if r.beforeScan != nil {
		r.beforeScan()
	}
	return r.input, r.fail["candidates"]
}
func (r *creationReader) BotCreationWorker(_ context.Context, _ string, id string) (model.BotDefaultsInput, error) {
	r.calls = append(r.calls, "worker:"+id)
	return selectTestWorker(r.input, id), r.fail["worker"]
}

func TestCreationSelectionUsesScopedReads(t *testing.T) {
	now := time.Now()
	first, second := availableWorker(workerID, now), availableWorker(botID, now)
	reader := &creationReader{input: model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{first, second}, PreferredWorkerID: ptr(botID)}}
	_, result, err := CreationDefaults(context.Background(), reader, "owner", model.BotOverrides{WorkerID: ptr(workerID)})
	if err != nil || result.Configuration == nil || result.Configuration.WorkerID != workerID || fmt.Sprint(reader.calls) != "[worker:"+workerID+"]" {
		t.Fatalf("explicit: %+v %v %v", result, err, reader.calls)
	}
	reader.calls = nil
	_, result, err = CreationDefaults(context.Background(), reader, "owner", model.BotOverrides{})
	if err != nil || result.Configuration == nil || result.Configuration.WorkerID != botID || fmt.Sprint(reader.calls) != "[preferred candidate:"+botID+" worker:"+botID+"]" {
		t.Fatalf("preferred: %+v %v %v", result, err, reader.calls)
	}
	reader.calls = nil
	reader.input.Workers[1].LastReportedAt = now.Add(-3 * time.Minute)
	_, result, err = CreationDefaults(context.Background(), reader, "owner", model.BotOverrides{})
	if err != nil || result.Configuration == nil || result.Configuration.WorkerID != workerID || fmt.Sprint(reader.calls) != "[preferred candidate:"+botID+" candidates worker:"+workerID+"]" {
		t.Fatalf("fallback: %+v %v %v", result, err, reader.calls)
	}
	_, _, err = CreationDefaults(context.Background(), reader, "owner", model.BotOverrides{WorkerID: ptr("missing")})
	assertFault(t, err, "forbidden")
}

func TestCreationSelectionOverflowAndFailures(t *testing.T) {
	now := time.Now()
	reader := &creationReader{input: model.BotDefaultsInput{ObservedAt: now}}
	for i := 0; i < 101; i++ {
		worker := availableWorker(fmt.Sprint(i), now)
		if i < 100 {
			worker.Telemetry.AssistantHost.Providers[0].Available = false
		}
		reader.input.Workers = append(reader.input.Workers, worker)
	}
	_, result, err := CreationDefaults(context.Background(), reader, "owner", model.BotOverrides{})
	assertFault(t, err, "active_worker_limit_exceeded")
	if result.Configuration != nil || fmt.Sprint(reader.calls) != "[preferred candidates]" {
		t.Fatalf("overflow: %+v %v", result, reader.calls)
	}
	for _, stage := range []string{"preferred", "candidate", "candidates", "worker"} {
		t.Run(stage, func(t *testing.T) {
			sentinel := errors.New(stage)
			r := &creationReader{input: model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{availableWorker(workerID, now)}}, fail: map[string]error{stage: sentinel}}
			if stage == "candidate" {
				r.input.PreferredWorkerID = ptr(workerID)
			}
			_, result, err := CreationDefaults(context.Background(), r, "owner", model.BotOverrides{})
			if !errors.Is(err, sentinel) || result.Configuration != nil {
				t.Fatalf("%+v %v", result, err)
			}
		})
	}
}

func TestCreationSelectionRejectsAllUsableOverflowBeforeFullWorkerRead(t *testing.T) {
	observedAt := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	candidates := make([]model.WorkerSnapshot, 101)
	for i := range candidates {
		id := fmt.Sprintf("10000000-0000-4000-8000-%012d", i+1)
		candidates[i] = availableWorker(id, observedAt)
	}
	reader := &creationReader{input: model.BotDefaultsInput{ObservedAt: observedAt, Workers: candidates}}

	input, result, err := CreationDefaults(t.Context(), reader, "owner", model.BotOverrides{})
	assertFault(t, err, "active_worker_limit_exceeded")
	if !reflect.DeepEqual(input, model.BotDefaultsInput{}) || !reflect.DeepEqual(result, BotDefaults{}) {
		t.Fatalf("usable overflow returned selection data: %+v %+v", input, result)
	}
	if !slices.Equal(reader.calls, []string{"preferred", "candidates"}) {
		t.Fatalf("usable overflow performed unexpected reads: %v", reader.calls)
	}
}

func TestCreationSelectionRechecksPreferredAtScan(t *testing.T) {
	now := time.Now()
	first, preferred := availableWorker(workerID, now), availableWorker(botID, now)
	first.LastReportedAt = now.Add(-3 * time.Minute)
	preferred.LastReportedAt = first.LastReportedAt
	r := &creationReader{input: model.BotDefaultsInput{ObservedAt: now, Workers: []model.WorkerSnapshot{first, preferred}, PreferredWorkerID: ptr(botID)}}
	r.beforeScan = func() {
		r.input.Workers[0].LastReportedAt = now
		r.input.Workers[1].LastReportedAt = now
	}
	_, result, err := CreationDefaults(context.Background(), r, "owner", model.BotOverrides{})
	if err != nil || result.Configuration == nil || result.Configuration.WorkerID != botID {
		t.Fatalf("preferred at scan: %+v %v %v", result, err, r.calls)
	}
}
