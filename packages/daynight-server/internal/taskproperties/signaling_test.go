package taskproperties

import (
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func TestWorkerSignalingPreservesOpaqueStringValues(t *testing.T) {
	for _, value := range []string{"", "xxx", "  ", "line\n中文\x00<worker>\u2028"} {
		worker := workerFixture()
		worker.Signaling = value
		properties := core.TaskProperties{PullRequests: []core.PullRequestProperty{}, Worker: &worker}
		result, err := Decode([]byte(Encode(properties)))
		if err != nil || !reflect.DeepEqual(result, properties) {
			t.Fatalf("signaling did not round trip: %#v %v", result, err)
		}
	}
}

func TestWorkerSignalingPatchOnlyAcceptsItsRequiredString(t *testing.T) {
	for _, value := range []string{`""`, `"xxx"`, `" \n中文\u0000"`} {
		patch, err := DecodePatch([]byte(`{"worker":{"signaling":` + value + `},"pullRequests":[]}`))
		if err != nil || patch.WorkerSignaling == nil || patch.PullRequests == nil {
			t.Fatalf("valid signaling patch refused: %#v %v", patch, err)
		}
	}
	for _, value := range []string{
		`null`, `false`, `[]`, `{}`, `{"signaling":null}`, `{"signaling":1}`,
		`{"signaling":"x","signaling":"y"}`, `{"signaling":"x","phase":"executing"}`,
		`{"signaling":"x","claimId":"ignored"}`, `{"signaling":"x","unknown":true}`,
	} {
		if _, err := DecodePatch([]byte(`{"worker":` + value + `}`)); err == nil {
			t.Fatalf("invalid or protected worker patch accepted: %s", value)
		}
	}
}
