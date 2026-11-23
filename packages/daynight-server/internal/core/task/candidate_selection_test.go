package task

import (
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestCandidateSelectionBindsWorkerAndFilterSemantics(t *testing.T) {
	project := "f47ac10b-58cc-11cf-a447-001122334455"
	user := "f47ac10b-58cc-11cf-a447-001122334456"
	worker := "f47ac10b-58cc-11cf-a447-001122334457"
	filter := model.TagNameFilter{Names: []string{"Backend", "urgent"}, Match: "any"}
	request := ListRequest{PageRequest: model.PageRequest{Limit: 1}, AutomaticCandidate: true, CandidateWorkerID: &worker, CandidateTagFilter: &filter}
	selection, err := SelectList(project, user, request)
	if err != nil {
		t.Fatal(err)
	}
	page, err := ProjectList(selection, store.TaskPage{Items: []model.Task{{ID: project, CreatedAt: time.Now().UTC()}}, HasMore: true})
	if err != nil || page.NextCursor == nil {
		t.Fatalf("page: %+v %v", page, err)
	}
	request.Cursor = page.NextCursor
	filter = model.TagNameFilter{Names: []string{"URGENT", "backend", "Backend"}, Match: "any"}
	if _, err := SelectList(project, user, request); err != nil {
		t.Fatalf("equivalent filter: %v", err)
	}
	filter.Match = "all"
	if _, err := SelectList(project, user, request); err == nil {
		t.Fatal("accepted changed match mode")
	}
	filter.Match = "any"
	other := "f47ac10b-58cc-11cf-a447-001122334458"
	request.CandidateWorkerID = &other
	if _, err := SelectList(project, user, request); err == nil {
		t.Fatal("accepted changed worker")
	}
	request.CandidateWorkerID = &worker
	if _, err := SelectList(project, other, request); err == nil {
		t.Fatal("accepted changed principal")
	}
	request.Cursor = nil
	request.AutomaticCandidate = false
	if _, err := SelectList(project, user, request); err == nil {
		t.Fatal("accepted non-candidate request")
	}
	request.AutomaticCandidate = true
	request.WorkerID = &worker
	if _, err := SelectList(project, user, request); err == nil {
		t.Fatal("accepted inventory worker")
	}
	request.WorkerID = nil
	request.CandidateTagFilter = nil
	if _, err := SelectList(project, user, request); err == nil {
		t.Fatal("accepted missing filter")
	}
}
