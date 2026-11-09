package taskproperty_test

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
)

func encodedProperties(t *testing.T, properties model.TaskProperties) string {
	t.Helper()
	value, err := taskproperty.Encode(properties)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func propertyFixture(t *testing.T, requests []model.PullRequestProperty, worker *model.WorkerClaim) model.TaskProperties {
	t.Helper()
	properties := model.TaskProperties{}
	if requests != nil {
		items := make([]map[string]string, len(requests))
		for index, request := range requests {
			items[index] = map[string]string{"url": request.URL, "title": request.Title}
		}
		value, err := json.Marshal(items)
		if err != nil {
			t.Fatal(err)
		}
		value, err = taskproperty.NormalizeValue("pullRequests", value)
		if err != nil {
			t.Fatal(err)
		}
		properties["pullRequests"] = value
	}
	if worker != nil {
		raw, err := taskproperty.EncodeWorker(worker)
		if err != nil {
			t.Fatal(err)
		}
		properties["worker"] = raw
	}
	return properties
}

func pullRequestsValue(t *testing.T, properties model.TaskProperties) []model.PullRequestProperty {
	t.Helper()
	value, err := taskproperty.PullRequests(properties)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestCodecRejectsInvalidInputStructures(t *testing.T) {
	for _, invalid := range []string{
		`null`, `[]`, `{`, `{} {}`, `{"unknown":[]}`, `{"worker":null}`, `{"pullRequests":[],"pullRequests":[]}`, `{"pullRequests":null}`, `{"pullRequests":{}}`,
		`{"paused":null}`, `{"paused":"true"}`, `{"paused":1}`, `{"paused":[]}`, `{"paused":{}}`, `{"paused":true,"paused":false}`,
		`{"pullRequests":[null]}`, `{"pullRequests":[{}]}`, `{"pullRequests":[{"url":null,"title":"x"}]}`,
		`{"pullRequests":[{"url":"x"}]}`, `{"pullRequests":[{"url":"x","title":1}]}`,
		`{"pullRequests":[{"url":"x","title":"y","extra":true}]}`, `{"pullRequests":[{"url":"x","title":"y","title":"z"}]}`,
	} {
		t.Run(invalid, func(t *testing.T) {
			_, err := taskproperty.Decode([]byte(invalid))
			var invalidValue *taskproperty.ValidationError
			if !errors.As(err, &invalidValue) {
				t.Fatalf("invalid property inputs must retain validation type: %v", err)
			}
		})
	}
}

func TestCodecNormalizationPreservesDecodedTextAndValueSemantics(t *testing.T) {
	left, err := taskproperty.Decode([]byte(`{"pullRequests":[{"title":"\ud800","url":"a\u0000b"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	right, err := taskproperty.Decode([]byte(`{"pullRequests":[ { "url":"a\u0000b", "title":"�" } ]}`))
	if err != nil || !taskproperty.Equal(left, right) {
		t.Fatalf("equivalent decoded text changed: %s vs %s (%v)", left, right, err)
	}
	if value := pullRequestsValue(t, left)[0]; value.URL != "a\x00b" || value.Title != "�" {
		t.Fatalf("typed string semantics changed: %#v", value)
	}
	_, err = taskproperty.Encode(model.TaskProperties{"pullRequests": json.RawMessage(`null`)})
	var invalidValue *taskproperty.ValidationError
	if !errors.As(err, &invalidValue) {
		t.Fatalf("Encode silently accepted invalid values: %v", err)
	}
}
