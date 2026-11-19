package worker

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestProjectReviewParticipation(t *testing.T) {
	for _, tc := range []struct {
		value model.WorkerReviewParticipation
		json  string
	}{
		{model.WorkerReviewParticipation{Version: 1}, `{"enabled":false,"version":"1"}`},
		{model.WorkerReviewParticipation{Enabled: true, Version: math.MaxInt64}, `{"enabled":true,"version":"9223372036854775807"}`},
	} {
		encoded, err := json.Marshal(ProjectReviewParticipation(tc.value))
		if err != nil || string(encoded) != tc.json {
			t.Fatalf("review participation projection: %s error=%v", encoded, err)
		}
	}
}
