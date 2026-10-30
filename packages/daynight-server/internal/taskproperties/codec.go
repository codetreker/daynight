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

func Encode(properties core.TaskProperties) (string, error) {
	normalized, err := Normalize(properties, false)
	if err != nil {
		return "", err
	}
	data, err := json.Marshal(normalized)
	return string(data), err
}

func Decode(data []byte) (core.TaskProperties, error) {
	fields, err := jsonobject.Decode(data, "properties", propertyNames()...)
	if err != nil {
		return nil, validation("properties", err.Error(), err)
	}
	return Normalize(core.TaskProperties(fields), false)
}

func DecodePatch(data []byte) (core.TaskPropertiesPatch, error) {
	fields, err := jsonobject.Decode(data, "properties", propertyNames()...)
	if err != nil {
		return nil, validation("properties", err.Error(), err)
	}
	return Normalize(core.TaskProperties(fields), true)
}

func normalizePullRequests(raw json.RawMessage) (json.RawMessage, error) {
	values, err := decodePullRequests(raw)
	if err != nil {
		return nil, err
	}
	document := make([]pullRequestDocument, len(values))
	for index, item := range values {
		document[index] = pullRequestDocument{URL: item.URL, Title: item.Title}
	}
	return json.Marshal(document)
}

func normalizeWorker(raw json.RawMessage) (json.RawMessage, error) {
	worker, err := decodeWorker(raw)
	if err != nil {
		return nil, err
	}
	return json.Marshal(encodeWorker(worker))
}

func Worker(properties core.TaskProperties) (*core.WorkerClaim, error) {
	raw, exists := properties["worker"]
	if !exists {
		return nil, nil
	}
	value, err := NormalizeValue("worker", raw, false)
	if err != nil {
		return nil, err
	}
	return decodeWorker(value)
}

func WithWorker(properties core.TaskProperties, worker *core.WorkerClaim) (core.TaskProperties, error) {
	result := Clone(properties)
	if worker == nil {
		delete(result, "worker")
		return result, nil
	}
	raw, err := json.Marshal(encodeWorker(worker))
	if err != nil {
		return nil, err
	}
	value, err := NormalizeValue("worker", raw, false)
	if err != nil {
		return nil, err
	}
	result["worker"] = value
	return result, nil
}

func PullRequests(properties core.TaskProperties) ([]core.PullRequestProperty, error) {
	raw, exists := properties["pullRequests"]
	if !exists {
		return nil, nil
	}
	value, err := NormalizeValue("pullRequests", raw, false)
	if err != nil {
		return nil, err
	}
	return decodePullRequests(value)
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
	raw, exists := fields[key]
	var value string
	if !exists || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil {
		return "", fmt.Errorf("%s.%s is required and must be a string", path, key)
	}
	return value, nil
}
