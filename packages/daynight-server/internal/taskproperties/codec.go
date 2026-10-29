package taskproperties

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/jsonobject"
)

type pullRequestDocument struct {
	URL   string `json:"url"`
	Title string `json:"title"`
}

type document struct {
	PullRequests []pullRequestDocument `json:"pullRequests"`
	Worker       *workerDocument       `json:"worker"`
}

func Encode(properties core.TaskProperties) string {
	value := document{PullRequests: make([]pullRequestDocument, len(properties.PullRequests)), Worker: encodeWorker(properties.Worker)}
	for index, item := range properties.PullRequests {
		value.PullRequests[index] = pullRequestDocument{URL: item.URL, Title: item.Title}
	}
	// This fixed document contains only strings and arrays, which cannot fail JSON encoding.
	data, _ := json.Marshal(value)
	return string(data)
}

func Decode(data []byte) (core.TaskProperties, error) {
	fields, err := jsonobject.Decode(data, "properties", "pullRequests", "worker")
	if err != nil {
		return core.TaskProperties{}, err
	}
	items, err := decodePullRequests(fields["pullRequests"])
	if err != nil {
		return core.TaskProperties{}, err
	}
	raw, exists := fields["worker"]
	if !exists {
		return core.TaskProperties{}, fmt.Errorf("properties.worker is required")
	}
	worker, err := decodeWorker(raw)
	if err != nil {
		return core.TaskProperties{}, err
	}
	return core.TaskProperties{PullRequests: items, Worker: worker}, nil
}

type writableProperty struct {
	name           string
	required       bool
	stringArgument bool
	reset          json.RawMessage
	fields         []writableProperty
	decode         func(json.RawMessage, *core.TaskPropertiesPatch) error
}

var writableProperties = []writableProperty{
	{name: "pullRequests", reset: json.RawMessage(`[]`), decode: func(raw json.RawMessage, patch *core.TaskPropertiesPatch) error {
		values, err := decodePullRequests(raw)
		if err != nil {
			return err
		}
		patch.PullRequests = &values
		return nil
	}},
	{name: "worker", fields: []writableProperty{
		{name: "signaling", required: true, stringArgument: true, reset: json.RawMessage(`""`), decode: func(raw json.RawMessage, patch *core.TaskPropertiesPatch) error {
			value, err := stringValue(raw, "properties.worker.signaling")
			if err != nil {
				return err
			}
			patch.WorkerSignaling = &value
			return nil
		}},
	}},
}

func DecodePatch(data []byte) (core.TaskPropertiesPatch, error) {
	patch := core.TaskPropertiesPatch{}
	if err := decodePropertyFields(data, "properties", writableProperties, &patch); err != nil {
		return core.TaskPropertiesPatch{}, err
	}
	return patch, nil
}

func decodePropertyFields(data []byte, path string, definitions []writableProperty, patch *core.TaskPropertiesPatch) error {
	allowed := make([]string, len(definitions))
	for index, definition := range definitions {
		allowed[index] = definition.name
	}
	fields, err := jsonobject.Decode(data, path, allowed...)
	if err != nil {
		return err
	}
	for _, definition := range definitions {
		fieldPath := path + "." + definition.name
		raw, exists := fields[definition.name]
		if !exists {
			if definition.required {
				return fmt.Errorf("%s is required", fieldPath)
			}
			continue
		}
		if definition.decode != nil {
			err = definition.decode(raw, patch)
		} else {
			err = decodePropertyFields(raw, fieldPath, definition.fields, patch)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func decodePullRequests(raw []byte) ([]core.PullRequestProperty, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("properties.pullRequests must be an array")
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, fmt.Errorf("properties.pullRequests must be an array")
	}
	values := make([]core.PullRequestProperty, 0, len(items))
	for index, item := range items {
		path := fmt.Sprintf("properties.pullRequests[%d]", index)
		fields, err := jsonobject.Decode(item, path, "url", "title")
		if err != nil {
			return nil, err
		}
		url, err := stringField(fields, "url", path)
		if err != nil {
			return nil, err
		}
		title, err := stringField(fields, "title", path)
		if err != nil {
			return nil, err
		}
		values = append(values, core.PullRequestProperty{URL: url, Title: title})
	}
	return values, nil
}

func stringField(fields map[string]json.RawMessage, key, path string) (string, error) {
	return stringValue(fields[key], path+"."+key)
}

func stringValue(raw json.RawMessage, path string) (string, error) {
	var value string
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil {
		return "", fmt.Errorf("%s is required and must be a string", path)
	}
	return value, nil
}
