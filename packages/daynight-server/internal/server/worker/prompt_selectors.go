package worker

import (
	"bytes"
	"encoding/json"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/worker"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

const workerPromptsHeader = "Daynight-Worker-Prompts"

// promptProtocol validates the complete header before any report is submitted.
func promptProtocol(header http.Header) (string, []model.PromptSelector, error) {
	versions, hasVersion := header[workerConfigurationHeader]
	values, hasPrompts := header[workerPromptsHeader]
	if !hasVersion {
		if hasPrompts {
			return "", nil, httpx.InvalidInput("Prompt selectors require Worker configuration protocol 2.")
		}
		return "", nil, nil
	}
	if len(versions) != 1 || (versions[0] != "1" && versions[0] != "2") {
		return "", nil, httpx.InvalidInput("Unsupported Worker configuration protocol.")
	}
	if versions[0] == "1" {
		if hasPrompts {
			return "", nil, httpx.InvalidInput("Prompt selectors require Worker configuration protocol 2.")
		}
		return "1", nil, nil
	}
	if !hasPrompts || len(values) != 1 {
		return "", nil, httpx.InvalidInput("Worker configuration protocol 2 requires one prompt selector header.")
	}
	selectors, err := parsePromptSelectors(values[0])
	return "2", selectors, err
}

func parsePromptSelectors(value string) ([]model.PromptSelector, error) {
	invalid := func() ([]model.PromptSelector, error) {
		return nil, httpx.InvalidInput("Prompt selectors are invalid.")
	}
	if len(value) == 0 || len(value) > 1024 || !jsonunicode.Valid([]byte(value)) {
		return invalid()
	}
	for i := 0; i < len(value); i++ {
		if value[i] > 127 || value[i] == '\r' || value[i] == '\n' {
			return invalid()
		}
	}
	var items []json.RawMessage
	if err := json.Unmarshal([]byte(value), &items); err != nil || items == nil || len(items) > 3 {
		return invalid()
	}
	selectors := make([]model.PromptSelector, 0, len(items))
	seen := make(map[model.PromptKey]bool, len(items))
	for _, item := range items {
		fields, err := jsonobject.Decode(item, "selector", "key", "knownRevision")
		if err != nil || len(fields) != 2 {
			return invalid()
		}
		keyFields, err := jsonobject.Decode(fields["key"], "key", "scope", "projectId")
		if err != nil {
			return invalid()
		}
		scope, err := httpx.RequiredString(keyFields, "scope")
		if err != nil {
			return invalid()
		}
		key := model.PromptKey{Scope: model.PromptScope(scope)}
		switch key.Scope {
		case model.PromptScopeUser, model.PromptScopeWorker:
			if len(keyFields) != 1 {
				return invalid()
			}
		case model.PromptScopeProject:
			if len(keyFields) != 2 {
				return invalid()
			}
			key.ProjectID, err = httpx.RequiredString(keyFields, "projectId")
			if err != nil {
				return invalid()
			}
			canonical, err := model.CanonicalID(key.ProjectID)
			if err != nil || canonical != key.ProjectID {
				return invalid()
			}
		default:
			return invalid()
		}
		if seen[key] {
			return invalid()
		}
		seen[key] = true
		var revision *string
		if !bytes.Equal(bytes.TrimSpace(fields["knownRevision"]), []byte("null")) {
			var text string
			if err := json.Unmarshal(fields["knownRevision"], &text); err != nil {
				return invalid()
			}
			if _, err := workercore.ConfigurationRevision(text, true); err != nil {
				return invalid()
			}
			revision = &text
		}
		selectors = append(selectors, model.PromptSelector{Key: key, KnownRevision: revision})
	}
	return selectors, nil
}
