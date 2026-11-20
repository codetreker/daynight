package worker

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

const selectedProject = "a0000000-0000-4000-8000-000000000001"

type selectionsDAO struct {
	candidates []store.WorkerSelectionID
	targets    map[store.WorkerSelectionID]*store.WorkerSelectionTarget
	writes     map[store.WorkerSelectionID]store.WorkerSelectionTarget
	failure    error
}

func (d *selectionsDAO) ProjectSelectionCandidates(_ context.Context, id string) ([]store.WorkerSelectionID, error) {
	if id != selectedProject {
		panic("unexpected project")
	}
	return d.candidates, d.failure
}
func (d *selectionsDAO) LockProjectSelection(_ context.Context, id store.WorkerSelectionID) (*store.WorkerSelectionTarget, error) {
	return d.targets[id], nil
}
func (d *selectionsDAO) SaveProjectSelection(_ context.Context, id store.WorkerSelectionID, revision int64, raw json.RawMessage) error {
	d.writes[id] = store.WorkerSelectionTarget{Revision: revision, Raw: raw}
	return d.failure
}

func TestRemoveProjectSelections(t *testing.T) {
	id, gone, unselected := store.WorkerSelectionID{UserID: "a", WorkerID: "b"}, store.WorkerSelectionID{UserID: "a", WorkerID: "c"}, store.WorkerSelectionID{UserID: "b", WorkerID: "a"}
	d := &selectionsDAO{candidates: []store.WorkerSelectionID{id, gone, unselected}, targets: map[store.WorkerSelectionID]*store.WorkerSelectionTarget{
		id:         {Revision: 7, Raw: json.RawMessage(`{"extra":{"future":1234567890123456789},"projects":[{"projectId":"other","future":true},{"projectId":"` + selectedProject + `","nativeOverrides":{}},{"projectId":"tail","nested":[1,2]}]}`)},
		unselected: {Revision: 9, Raw: json.RawMessage(`{"projects":[{"projectId":"other"}]}`)},
	}, writes: map[store.WorkerSelectionID]store.WorkerSelectionTarget{}}
	if count, err := RemoveProjectSelectionsCount(t.Context(), d, selectedProject); err != nil || count != 1 {
		t.Fatalf("count=%d error=%v", count, err)
	}
	got := d.writes[id]
	if len(d.writes) != 1 || got.Revision != 8 {
		t.Fatalf("writes: %+v", d.writes)
	}
	var actual, want map[string]json.RawMessage
	if err := json.Unmarshal(got.Raw, &actual); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(`{"extra":{"future":1234567890123456789},"projects":[{"projectId":"other","future":true},{"projectId":"tail","nested":[1,2]}]}`), &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, want) {
		t.Fatalf("configuration: %s", got.Raw)
	}
}

func TestRemoveProjectSelectionsEmptyAndFailure(t *testing.T) {
	id := store.WorkerSelectionID{UserID: "a", WorkerID: "b"}
	newDAO := func(revision int64) *selectionsDAO {
		return &selectionsDAO{candidates: []store.WorkerSelectionID{id}, targets: map[store.WorkerSelectionID]*store.WorkerSelectionTarget{id: {Revision: revision, Raw: json.RawMessage(`{"projects":[{"projectId":"` + selectedProject + `"}]}`)}}, writes: map[store.WorkerSelectionID]store.WorkerSelectionTarget{}}
	}
	d := newDAO(1)
	if count, err := RemoveProjectSelectionsCount(t.Context(), d, selectedProject); err != nil || count != 1 {
		t.Fatalf("count=%d error=%v", count, err)
	}
	if string(d.writes[id].Raw) != `{"projects":[]}` {
		t.Fatalf("last selection: %s", d.writes[id].Raw)
	}
	d = newDAO(math.MaxInt64)
	var fault *model.Fault
	if count, err := RemoveProjectSelectionsCount(t.Context(), d, selectedProject); !errors.As(err, &fault) || fault.Code != "version_exhausted" || count != 0 || len(d.writes) != 0 {
		t.Fatalf("exhaustion: count=%d %v %+v", count, err, d.writes)
	}
	d = newDAO(1)
	d.failure = errors.New("unavailable")
	if count, err := RemoveProjectSelectionsCount(t.Context(), d, selectedProject); !errors.Is(err, d.failure) || count != 0 || len(d.writes) != 0 {
		t.Fatalf("query failure: count=%d %v", count, err)
	}
}
