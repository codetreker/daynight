package worker

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestActiveAtAndAdmission(t *testing.T) {
	if ActiveWindow != 120*time.Second {
		t.Fatalf("active window = %s, want 120s", ActiveWindow)
	}
	now := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		offset time.Duration
		active bool
	}{
		{time.Millisecond, false}, {0, true}, {-ActiveWindow + time.Nanosecond, true}, {-ActiveWindow, false}, {-ActiveWindow - time.Nanosecond, false},
	} {
		seen := now.Add(tc.offset)
		if got := ActiveAt(seen, now); got != tc.active {
			t.Errorf("offset %s: %v", tc.offset, got)
		}
		for _, count := range []int{99, 100, 101} {
			err := AdmitActiveWorker(store.WorkerAdmission{ObservedAt: now, LastSeenAt: &seen, ActiveCount: count})
			rejected := count > 100 || (count == 100 && !tc.active)
			var fault *model.Fault
			if rejected != (errors.As(err, &fault) && fault.Code == "active_worker_limit_exceeded") || (!rejected && err != nil) {
				t.Errorf("offset %s count %d: %v", tc.offset, count, err)
			}
		}
	}
	if ActiveAt(time.Time{}, now) || ActiveAt(now, time.Time{}) {
		t.Fatal("zero time is not active")
	}
	for _, count := range []int{99, 100, 101} {
		err := AdmitActiveWorker(store.WorkerAdmission{ObservedAt: now, ActiveCount: count})
		var fault *model.Fault
		if count < 100 {
			if err != nil {
				t.Fatalf("new worker count %d: %v", count, err)
			}
		} else if !errors.As(err, &fault) || fault.Code != "active_worker_limit_exceeded" {
			t.Fatalf("new worker count %d: %v", count, err)
		}
	}
}

func TestAdmissionSnapshotUsesLockedObservation(t *testing.T) {
	const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	const worker = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	locked := time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC)
	client, inventory := locked.Add(24*time.Hour), locked.Add(-time.Second)
	code := "unavailable"
	missing := model.WorkerProbe[string]{State: "error", CheckedAt: client, Code: &code}
	telemetry := model.WorkerTelemetry{
		Machine: model.WorkerMachine{ID: worker, Name: "Admission report"}, Platform: model.PlatformLinux,
		WorkingDirectory: "/workspace", SampledAt: client,
		OS:       model.WorkerProbe[model.WorkerOS]{State: "error", CheckedAt: client, Code: &code},
		CPU:      model.WorkerProbe[model.WorkerCPU]{State: "error", CheckedAt: client, Code: &code},
		Memory:   model.WorkerProbe[model.WorkerMemory]{State: "error", CheckedAt: client, Code: &code},
		Disk:     model.WorkerProbe[model.WorkerDisk]{State: "error", CheckedAt: client, Code: &code},
		Versions: model.WorkerVersions{Daynight: "1", Herdr: missing, Codex: missing, Copilot: missing},
	}
	input := model.WorkerReport{Telemetry: telemetry, TaskInventory: &model.WorkerTaskInventory{ObservedAt: inventory, Claims: []model.WorkerTaskReference{}}}
	got := SnapshotForReport(owner, worker, input, locked, []model.WorkerObservedTask{})
	want := model.WorkerSnapshot{
		UserID: owner, WorkerID: worker, CreatedAt: locked, LastReportedAt: locked,
		Telemetry:    input.Telemetry,
		TaskSnapshot: model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &locked, InventoryObservedAt: &inventory, Items: []model.WorkerObservedTask{}},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("snapshot used client time instead of the locked observation: got=%+v want=%+v", got, want)
	}
}
