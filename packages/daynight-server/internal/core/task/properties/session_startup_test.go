package properties

import (
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestRemovingWorkerClearsStartupWithoutMutatingSource(t *testing.T) {
	worker := workerFixture()
	original, err := WithWorker(model.TaskProperties{"sessionStartup": json.RawMessage(`{"retained":true}`), "paused": json.RawMessage(`true`)}, &worker)
	if err != nil {
		t.Fatal(err)
	}
	result, err := WithWorker(original, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := result["worker"]; ok {
		t.Fatal("worker was not cleared")
	}
	if _, ok := result["sessionStartup"]; ok {
		t.Fatal("startup evidence survived worker removal")
	}
	if _, ok := original["worker"]; !ok || string(original["sessionStartup"]) != `{"retained":true}` || string(result["paused"]) != `true` {
		t.Fatal("worker removal changed the input or unrelated values")
	}
	result["paused"][0] = 'X'
	if string(original["paused"]) != `true` {
		t.Fatal("worker removal shared property bytes")
	}
}
