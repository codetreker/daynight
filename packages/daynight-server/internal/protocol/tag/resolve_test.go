package tag

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

func TestResolveEncodingAndLimit(t *testing.T) {
	refs := []model.TagReference{{ID: "id", Name: "<&😀"}}
	var output bytes.Buffer
	if _, err := EncodeResolve(&output, refs); err != nil {
		t.Fatal(err)
	}
	expected, err := json.Marshal(ResolveResponse{Items: []Reference{{ID: "id", Name: "<&😀"}}})
	if err != nil || output.String() != string(expected)+"\n" {
		t.Fatalf("wire encoding %q vs %q: %v", output.String(), expected, err)
	}
	output.Reset()
	if _, err := EncodeResolve(&output, nil); err != nil || output.String() != "{\"items\":[]}\n" {
		t.Fatalf("empty: %q, %v", output.String(), err)
	}
	base := len(`{"items":[{"id":"id","name":""}]}`) + 1
	exact := []model.TagReference{{ID: "id", Name: strings.Repeat("a", MaxResolveBytes-base)}}
	n, err := EncodeResolve(io.Discard, exact)
	if err != nil || n != MaxResolveBytes {
		t.Fatalf("exact budget: n=%d err=%v", n, err)
	}
	exact[0].Name += "a"
	_, err = EncodeResolve(io.Discard, exact)
	var exactViolation *limit.Violation
	if !errors.As(err, &exactViolation) {
		t.Fatalf("one byte over budget accepted: %v", err)
	}
	// Name is escaped to six bytes per character, exercising the actual wire budget.
	oversized := []model.TagReference{{ID: "id", Name: strings.Repeat("&", MaxResolveBytes/6)}}
	_, err = EncodeResolve(io.Discard, oversized)
	var violation *limit.Violation
	if !errors.As(err, &violation) {
		t.Fatalf("oversized response accepted: %v", err)
	}
}
