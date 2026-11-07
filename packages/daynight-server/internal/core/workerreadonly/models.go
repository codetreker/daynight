package workerreadonly

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

type ModelInput struct {
	Provider      string  `json:"provider"`
	Cwd           *string `json:"cwd,omitempty"`
	Model         *string `json:"model,omitempty"`
	IncludeHidden *bool   `json:"includeHidden,omitempty"`
	Limit         *int    `json:"limit,omitempty"`
	Cursor        *string `json:"cursor,omitempty"`
}
type ModelOption struct {
	ID                     string   `json:"id"`
	Label                  string   `json:"label"`
	Aliases                []string `json:"aliases"`
	Hidden                 bool     `json:"hidden"`
	ReasoningEfforts       []string `json:"reasoningEfforts"`
	DefaultReasoningEffort *string  `json:"defaultReasoningEffort"`
}
type ModelDefault struct {
	Value  *string `json:"value"`
	Source string  `json:"source"`
}
type ModelDefaults struct {
	Model           ModelDefault `json:"model"`
	ReasoningEffort ModelDefault `json:"reasoningEffort"`
}
type ModelResult struct {
	SchemaVersion           int           `json:"schemaVersion"`
	Provider                string        `json:"provider"`
	Cwd                     string        `json:"cwd"`
	ConfigurationGeneration string        `json:"configurationGeneration"`
	CatalogGeneration       string        `json:"catalogGeneration"`
	Models                  []ModelOption `json:"models"`
	Defaults                ModelDefaults `json:"defaults"`
	SelectionError          *Error        `json:"selectionError"`
	NextCursor              *string       `json:"nextCursor"`
}

var configurationGenerationPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var windowsAbsolutePattern = regexp.MustCompile(`(?i)^[a-z]:[\\/]|^\\\\[^\\/]+[\\/][^\\/]+`)

func modelText(value string, limit int) bool {
	return len(value) <= limit && strings.TrimSpace(value) != "" && utf8.ValidString(value) && !strings.ContainsFunc(value, unicode.IsControl)
}
func modelPath(value string) bool {
	return modelText(value, 4096) && (strings.HasPrefix(value, "/") || windowsAbsolutePattern.MatchString(value))
}
func modelProvider(value string) bool {
	return value == "codex" || value == "claude" || value == "copilot"
}
func objectFields(raw json.RawMessage, required []string, nullable map[string]bool) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return nil, fault("invalid_input", "Model capability data must be an object.")
	}
	for _, key := range required {
		if _, ok := fields[key]; !ok {
			return nil, fault("invalid_input", "Model capability data is incomplete.")
		}
	}
	for key, value := range fields {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) && !nullable[key] {
			return nil, fault("invalid_input", "Model capability field cannot be null.")
		}
	}
	return fields, nil
}
func validateModelInput(raw json.RawMessage) error {
	var input ModelInput
	if err := Decode(raw, &input); err != nil {
		return err
	}
	if _, err := objectFields(raw, []string{"provider"}, nil); err != nil {
		return err
	}
	if !modelProvider(input.Provider) || input.Cwd != nil && !modelPath(*input.Cwd) || input.Model != nil && !modelText(*input.Model, 256) || input.Cursor != nil && !modelText(*input.Cursor, 4096) || input.Limit != nil && (*input.Limit < 1 || *input.Limit > 100) {
		return fault("invalid_input", "Model discovery input is invalid or exceeds its limits.")
	}
	return nil
}
func modelStrings(values []string, count, bytes int) bool {
	if len(values) > count {
		return false
	}
	seen := map[string]bool{}
	for _, value := range values {
		if !modelText(value, bytes) || seen[value] {
			return false
		}
		seen[value] = true
	}
	return true
}
func validateModelDefault(raw json.RawMessage, value ModelDefault, limit int) error {
	if _, err := objectFields(raw, []string{"value", "source"}, map[string]bool{"value": true}); err != nil {
		return err
	}
	if value.Value != nil && !modelText(*value.Value, limit) {
		return fault("invalid_input", "Model default value is invalid.")
	}
	switch value.Source {
	case "unknown":
		if value.Value != nil {
			return fault("invalid_input", "Unknown model default cannot contain a value.")
		}
	case "explicit", "local", "cloud":
		if value.Value == nil {
			return fault("invalid_input", "Configured model default requires a value.")
		}
	case "native":
	default:
		return fault("invalid_input", "Model default source is invalid.")
	}
	return nil
}
func validateModelResult(raw json.RawMessage) error {
	var result ModelResult
	if err := Decode(raw, &result); err != nil {
		return err
	}
	fields, err := objectFields(raw, []string{"schemaVersion", "provider", "cwd", "configurationGeneration", "catalogGeneration", "models", "defaults", "selectionError", "nextCursor"}, map[string]bool{"selectionError": true, "nextCursor": true})
	if err != nil {
		return err
	}
	if result.SchemaVersion != 1 || !modelProvider(result.Provider) || !modelPath(result.Cwd) || !configurationGenerationPattern.MatchString(result.ConfigurationGeneration) || !validID(result.CatalogGeneration) || result.Models == nil || len(result.Models) > 100 || result.NextCursor != nil && !modelText(*result.NextCursor, 4096) {
		return fault("invalid_input", "Model capability result is invalid or exceeds its limits.")
	}
	var models []json.RawMessage
	if err := json.Unmarshal(fields["models"], &models); err != nil {
		return err
	}
	seen := map[string]bool{}
	for i, option := range result.Models {
		if _, err := objectFields(models[i], []string{"id", "label", "aliases", "hidden", "reasoningEfforts", "defaultReasoningEffort"}, map[string]bool{"reasoningEfforts": true, "defaultReasoningEffort": true}); err != nil {
			return err
		}
		if !modelText(option.ID, 256) || seen[option.ID] || !modelText(option.Label, 1024) || option.Aliases == nil || !modelStrings(option.Aliases, 16, 256) || !modelStrings(option.ReasoningEfforts, 32, 64) {
			return fault("invalid_input", "Model capability option is invalid.")
		}
		seen[option.ID] = true
		if option.DefaultReasoningEffort != nil {
			found := false
			for _, effort := range option.ReasoningEfforts {
				if effort == *option.DefaultReasoningEffort {
					found = true
				}
			}
			if !found {
				return fault("invalid_input", "Native default effort is absent from model capabilities.")
			}
		}
	}
	defaults, err := objectFields(fields["defaults"], []string{"model", "reasoningEffort"}, nil)
	if err != nil {
		return err
	}
	if err := validateModelDefault(defaults["model"], result.Defaults.Model, 256); err != nil {
		return err
	}
	if err := validateModelDefault(defaults["reasoningEffort"], result.Defaults.ReasoningEffort, 64); err != nil {
		return err
	}
	if result.SelectionError != nil {
		if _, err := objectFields(fields["selectionError"], []string{"code", "message"}, nil); err != nil {
			return err
		}
		if (result.SelectionError.Code != "unknown_default" && result.SelectionError.Code != "unsupported_selection") || !modelText(result.SelectionError.Message, 1024) {
			return fault("invalid_input", "Model selection error is invalid.")
		}
	}
	return nil
}
