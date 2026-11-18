package task_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	tagcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/tag"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

func TestClaimWorkerTagAdmission(t *testing.T) {
	filter := model.TagNameFilter{Names: []string{"Backend", "urgent"}, Match: "all"}
	key, err := tagcore.NameFilterDigest(filter)
	if err != nil {
		t.Fatal(err)
	}
	empty, err := tagcore.NameFilterDigest(model.TagNameFilter{Names: []string{}, Match: "any"})
	if err != nil {
		t.Fatal(err)
	}
	anyKey, err := tagcore.NameFilterDigest(model.TagNameFilter{Names: []string{"backend", "urgent"}, Match: "any"})
	if err != nil {
		t.Fatal(err)
	}
	stale := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	failure := errors.New("admission read failed")
	tests := []struct {
		name        string
		raw         string
		hasTarget   bool
		tags        []model.TagReference
		key         *string
		readErr     error
		fault       string
		operational bool
	}{
		{name: "uninitialized legacy", key: nil},
		{name: "uninitialized valid proof", key: &empty},
		{name: "uninitialized stale proof", key: &key, fault: "claim_conflict"},
		{name: "empty target legacy", hasTarget: true, raw: `{"taskTagFilter":{"names":[],"match":"all"},"unrelated":{"future":true}}`},
		{name: "nonempty legacy", hasTarget: true, raw: `{"taskTagFilter":{"names":["backend","urgent"],"match":"all"}}`, fault: "worker_task_tag_filter_unsupported"},
		{name: "stale proof", hasTarget: true, raw: `{"taskTagFilter":{"names":["backend","urgent"],"match":"all"}}`, key: &stale, fault: "claim_conflict"},
		{name: "missing task tag", hasTarget: true, raw: `{"taskTagFilter":{"names":["backend","urgent"],"match":"all"}}`, key: &key, tags: []model.TagReference{{Name: "backend"}}, fault: "claim_conflict"},
		{name: "all matches", hasTarget: true, raw: `{"taskTagFilter":{"names":["urgent","BACKEND"],"match":"all"},"irrelevant":null}`, key: &key, tags: []model.TagReference{{Name: "backend"}, {Name: "URGENT"}}},
		{name: "any matches", hasTarget: true, raw: `{"taskTagFilter":{"names":["urgent","BACKEND"],"match":"any"}}`, key: &anyKey, tags: []model.TagReference{{Name: "Urgent"}}},
		{name: "any misses", hasTarget: true, raw: `{"taskTagFilter":{"names":["urgent","BACKEND"],"match":"any"}}`, key: &anyKey, tags: []model.TagReference{{Name: "other"}}, fault: "claim_conflict"},
		{name: "missing stored filter", hasTarget: true, raw: `{"other":1}`, operational: true},
		{name: "invalid stored filter", hasTarget: true, raw: `{"taskTagFilter":{"names":null,"match":"any"}}`, operational: true},
		{name: "read failure", readErr: failure, operational: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			current, owner, descriptor := workerTestCurrent(t, "")
			current.Tags = test.tags
			f := workerMockWrite(t, current, owner)
			called := 0
			f.Admission.read = func(ctx context.Context, user, worker string) (*model.WorkerDesiredConfiguration, error) {
				called++
				if ctx != f.Context || user != owner.UserID || worker != descriptor.WorkerID || called != 1 {
					t.Fatalf("admission scope: %s %s %d", user, worker, called)
				}
				if test.readErr != nil {
					return nil, test.readErr
				}
				if !test.hasTarget {
					return nil, nil
				}
				return &model.WorkerDesiredConfiguration{Raw: json.RawMessage(test.raw), ValueValid: false}, nil
			}
			if test.fault == "" && !test.operational {
				observed := current.UpdatedAt.Add(time.Second)
				worker := &model.WorkerClaim{ClaimID: descriptor.ClaimID, UserID: owner.UserID, WorkerID: descriptor.WorkerID, Machine: descriptor.Machine, Platform: descriptor.Platform, Agent: descriptor.Agent, AgentControlMode: descriptor.AgentControlMode, WorktreeID: descriptor.WorktreeID, State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: observed}
				want := workerTestResult(current)
				want.Status, want.Ready, want.StartedAt = model.TaskInProgress, false, &observed
				want.Properties = testWithWorker(t, current.Properties, worker)
				f.Task.ObservedAtFn = func(context.Context) (time.Time, error) { return observed, nil }
				workerExpectUpdate(t, f, workerTestValues(want), want)
			}
			got, err := f.Tasks.ClaimWorker(f.Context, owner, current.ProjectID, current.ID, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor, TaskTagFilterKey: test.key})
			if called != 1 {
				t.Fatalf("admission calls: %d", called)
			}
			if test.fault != "" {
				requireFault(t, err, test.fault)
				if !reflect.DeepEqual(got, model.Task{}) {
					t.Fatal("refusal returned task")
				}
				return
			}
			if test.operational {
				if err == nil || !reflect.DeepEqual(got, model.Task{}) {
					t.Fatalf("expected failure: %+v %v", got, err)
				}
				if test.readErr != nil && !errors.Is(err, test.readErr) {
					t.Fatalf("read error lost: %v", err)
				}
				assertOperational(t, err)
				return
			}
			if err != nil || got.Status != model.TaskInProgress {
				t.Fatalf("claim: %+v %v", got, err)
			}
		})
	}
}
