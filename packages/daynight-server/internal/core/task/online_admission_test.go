package task

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type countingAdmissionDAO struct {
	store.TaskWriteDAO
	tasks        []model.Task
	current      model.Task
	reads, walks int
}

func (d *countingAdmissionDAO) Task(context.Context, string) (model.Task, error) {
	return d.current, nil
}

func (d *countingAdmissionDAO) TasksByID(context.Context, []string) ([]model.Task, error) {
	d.reads++
	return d.tasks, nil
}

func TestExternalDependencyCountBeforeNormalizationAndGraph(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	tooMany := make([]string, MaxDependencies+1)
	for i := range tooMany {
		tooMany[i] = "not-a-uuid"
	}
	_, err := CreateCandidate(id, CreateTask{Title: "Task", ExternalDependsOn: tooMany})
	fault := faultCode(t, err, "invalid_input")
	if fault.Message != "External dependencies must belong to the complete dependency set." {
		t.Fatalf("normalization preceded subset size check: %v", err)
	}
	dao := &countingAdmissionDAO{current: model.Task{ID: id, Title: "Task", Version: 2, Properties: model.TaskProperties{}}}
	_, err = PrepareUpdate(t.Context(), dao, id, UpdateTask{Version: 1, ExternalDependsOn: &tooMany})
	faultCode(t, err, "version_conflict")
	_, err = PrepareUpdate(t.Context(), dao, id, UpdateTask{Version: 2, ExternalDependsOn: &tooMany})
	fault = faultCode(t, err, "invalid_input")
	if fault.Message != "External dependencies must belong to the complete dependency set." || dao.reads != 0 || dao.walks != 0 {
		t.Fatalf("oversized external dependencies reached normalization or graph work: %v, reads=%d walks=%d", err, dao.reads, dao.walks)
	}
}

func (d *countingAdmissionDAO) Reachable(context.Context, string, string, store.DependencyReplacement) (bool, error) {
	d.walks++
	return false, nil
}

func TestOnlineCandidateAdmission(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	deps := make([]string, MaxDependencies)
	dao := &countingAdmissionDAO{}
	for i := range deps {
		deps[i] = fmt.Sprintf("00000000-0000-4000-8000-%012d", i+2)
		dao.tasks = append(dao.tasks, model.Task{ID: deps[i], Status: model.TaskDone})
	}
	values, err := CreateCandidate(id, CreateTask{Title: strings.Repeat("é", 512), Description: strings.Repeat("界", 21845) + "a", DependsOn: deps})
	if err != nil || ValidateCandidate(t.Context(), dao, id, values) != nil || dao.reads != 1 || dao.walks != 15 {
		t.Fatalf("boundary failed: reads=%d walks=%d err=%v", dao.reads, dao.walks, err)
	}
	tooMany := append(append([]string{}, deps...), "not-a-uuid")
	_, err = CreateCandidate(id, CreateTask{Title: "Task", DependsOn: tooMany})
	faultCode(t, err, "invalid_input")
	dao.reads, dao.walks = 0, 0
	err = ValidateCandidate(t.Context(), dao, id, store.TaskWrite{DependsOn: tooMany})
	faultCode(t, err, "invalid_input")
	if dao.reads != 0 || dao.walks != 0 {
		t.Fatalf("oversized dependency set triggered graph work: %+v", dao)
	}
	current := model.Task{ID: id, Title: "Task", Properties: model.TaskProperties{}}
	_, err = UpdateCandidate(current, UpdateTask{DependsOn: &tooMany})
	faultCode(t, err, "invalid_input")
	for _, input := range []CreateTask{
		{Title: strings.Repeat("é", 512) + "x"},
		{Title: "ok", Description: strings.Repeat("界", 21845) + "ab"},
		{Title: " "}, {Title: string([]byte{0xff})}, {Title: "ok", Description: "\x00"},
	} {
		_, err := CreateCandidate(id, input)
		faultCode(t, err, "invalid_input")
	}
}

func TestOnlineWorkerAdmission(t *testing.T) {
	descriptor := validDescriptor()
	user := "00000000-0000-4000-8000-000000000005"
	for _, size := range []int{256, 257} {
		descriptor.Machine.Name = strings.Repeat("x", size)
		_, err := AcquireWorker(model.Task{Properties: model.TaskProperties{}}, user, descriptor, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
		if size == 256 && err != nil {
			t.Fatal(err)
		}
		if size == 257 {
			faultCode(t, err, "invalid_input")
		}
	}
	current, worker := activeFixture(t)
	native := strings.Repeat("x", 257)
	_, changed, err := WorkerUpdateCandidate(current, worker, worker.ClaimID, UpdateWorker{NativeSessionID: ptr(&native)})
	faultCode(t, err, "invalid_input")
	if changed {
		t.Fatal("rejected update was marked changed")
	}
	if _, exists := current.Properties["sessionStartup"]; exists {
		t.Fatal("rejected update mutated original")
	}
}
