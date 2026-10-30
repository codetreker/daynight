package taskproperties

import (
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func encodedProperties(t *testing.T, properties core.TaskProperties) string {
	t.Helper()
	value, err := Encode(properties)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func propertyFixture(t *testing.T, requests []core.PullRequestProperty, worker *core.WorkerClaim) core.TaskProperties {
	t.Helper()
	properties := core.TaskProperties{}
	if requests != nil {
		items := make([]map[string]string, len(requests))
		for index, request := range requests {
			items[index] = map[string]string{"url": request.URL, "title": request.Title}
		}
		value, err := json.Marshal(items)
		if err != nil {
			t.Fatal(err)
		}
		value, err = NormalizeValue("pullRequests", value, false)
		if err != nil {
			t.Fatal(err)
		}
		properties["pullRequests"] = value
	}
	properties, err := WithWorker(properties, worker)
	if err != nil {
		t.Fatal(err)
	}
	return properties
}

func pullRequestsValue(t *testing.T, properties core.TaskProperties) []core.PullRequestProperty {
	t.Helper()
	value, err := PullRequests(properties)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func workerValue(t *testing.T, properties core.TaskProperties) *core.WorkerClaim {
	t.Helper()
	value, err := Worker(properties)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestCodecPreservesPropertiesAndPatchPresence(t *testing.T) {
	items := []core.PullRequestProperty{{URL: "  any\x00\ntext 中文 ", Title: ""}, {URL: "  any\x00\ntext 中文 ", Title: ""}, {URL: "", Title: strings.Repeat("long", 20000)}}
	encoded := encodedProperties(t, propertyFixture(t, items, nil))
	if strings.ContainsRune(encoded, 0) || !strings.Contains(encoded, `\u0000`) {
		t.Fatal("NUL was not escaped for PostgreSQL text")
	}
	decoded, err := Decode([]byte(encoded))
	if err != nil || !slices.Equal(pullRequestsValue(t, decoded), items) {
		t.Fatalf("property content changed: %+v, %v", decoded, err)
	}
	for _, properties := range []core.TaskProperties{{}, {"pullRequests": json.RawMessage(`[]`)}} {
		decoded, err := Decode([]byte(encodedProperties(t, properties)))
		if err != nil || !reflect.DeepEqual(decoded, properties) {
			t.Fatalf("empty storage document changed presence: %+v, %v", decoded, err)
		}
	}
	for _, properties := range []core.TaskProperties{nil, {}} {
		if got := encodedProperties(t, properties); got != `{}` {
			t.Fatalf("empty property object encoded as %s", got)
		}
	}
	patch, err := DecodePatch([]byte(`{}`))
	if err != nil || patch == nil || len(patch) != 0 {
		t.Fatalf("empty patch gained mutation intent: %+v, %v", patch, err)
	}
	patch, err = DecodePatch([]byte(`{"pullRequests":[]}`))
	if err != nil || string(patch["pullRequests"]) != `[]` || pullRequestsValue(t, patch) == nil {
		t.Fatalf("clear patch lost mutation intent: %+v, %v", patch, err)
	}
}

func TestCodecRejectsCorruptStoredStructures(t *testing.T) {
	for _, invalid := range []string{
		`null`, `[]`, `{`, `{} {}`, `{"unknown":[]}`, `{"worker":null}`, `{"pullRequests":[],"pullRequests":[]}`, `{"pullRequests":null}`, `{"pullRequests":{}}`,
		`{"pullRequests":[null]}`, `{"pullRequests":[{}]}`, `{"pullRequests":[{"url":null,"title":"x"}]}`,
		`{"pullRequests":[{"url":"x"}]}`, `{"pullRequests":[{"url":"x","title":1}]}`,
		`{"pullRequests":[{"url":"x","title":"y","extra":true}]}`, `{"pullRequests":[{"url":"x","title":"y","title":"z"}]}`,
	} {
		t.Run(invalid, func(t *testing.T) {
			_, err := Decode([]byte(invalid))
			var invalidValue *ValidationError
			if !errors.As(err, &invalidValue) {
				t.Fatalf("corrupt stored properties must retain validation type: %v", err)
			}
		})
	}
}

func TestCodecNormalizationPreservesLegacyDecodedTextAndValueSemantics(t *testing.T) {
	left, err := Decode([]byte(`{"pullRequests":[{"title":"\ud800","url":"a\u0000b"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	right, err := Decode([]byte(`{"pullRequests":[ { "url":"a\u0000b", "title":"�" } ]}`))
	if err != nil || !Equal(left, right) {
		t.Fatalf("equivalent decoded text changed: %s vs %s (%v)", left, right, err)
	}
	if value := pullRequestsValue(t, left)[0]; value.URL != "a\x00b" || value.Title != "�" {
		t.Fatalf("typed string semantics changed: %#v", value)
	}
	_, err = Encode(core.TaskProperties{"pullRequests": json.RawMessage(`null`)})
	var invalidValue *ValidationError
	if !errors.As(err, &invalidValue) {
		t.Fatalf("Encode silently accepted invalid values: %v", err)
	}
}
