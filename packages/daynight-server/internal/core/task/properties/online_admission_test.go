package properties

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
)

func TestOnlineValueAdmissionUsesNormalizedSize(t *testing.T) {
	type pullRequest struct {
		URL   string `json:"url"`
		Title string `json:"title"`
	}
	items := []pullRequest{{URL: strings.Repeat("a", 2048), Title: strings.Repeat("b", 1024)}, {URL: strings.Repeat("a", 2048), Title: strings.Repeat("b", 1024)}, {URL: strings.Repeat("c", 1980)}}
	base, _ := json.Marshal(items)
	items[2].Title = strings.Repeat("d", 8192-len(base))
	raw, _ := json.Marshal(items)
	if len(raw) != 8192 {
		t.Fatalf("fixture: %d", len(raw))
	}
	for _, input := range []string{string(raw), " \n " + string(raw) + " \n"} {
		value, err := ParseInput("pullRequests", input)
		if err != nil || len(value) != 8192 {
			t.Fatalf("normalized %d: %v", len(value), err)
		}
	}
	items[2].Title += "x"
	over, _ := json.Marshal(items)
	if _, err := taskproperty.NormalizeValue("pullRequests", over); err != nil {
		t.Fatalf("read normalization enforced write policy: %v", err)
	}
	patch := append(append([]byte(`{"pullRequests":`), over...), '}')
	if _, err := DecodePatch(patch); err != nil {
		t.Fatalf("structural decoding enforced write policy before version check: %v", err)
	}
	for _, fn := range []func() error{
		func() error { _, err := ParseInput("pullRequests", string(over)); return err },
		func() error {
			_, err := Normalize(model.TaskProperties{"paused": json.RawMessage(`true`), "pullRequests": over})
			return err
		},
	} {
		var violation *limit.Violation
		if err := fn(); !errors.As(err, &violation) || violation.Actual != 8193 {
			t.Fatalf("expected value limit: %v", err)
		}
	}
}
