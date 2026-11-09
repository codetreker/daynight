package sessionprotocol

import (
	"encoding/json"
	"time"
)

// Controls describes provider-confirmed values and the currently offered actions.
// Requested values belong to operation payloads until the provider confirms them.
type Controls struct {
	Revision      string          `json:"revision"`
	Settings      []Setting       `json:"settings"`
	Commands      []NativeCommand `json:"commands"`
	SettingsError *string         `json:"settingsError"`
	CommandsError *string         `json:"commandsError"`
}
type Setting struct {
	ID          string          `json:"id"`
	Category    string          `json:"category"`
	Label       string          `json:"label"`
	Description *string         `json:"description"`
	Value       *string         `json:"value"`
	Options     []SettingOption `json:"options"`
	Mutable     bool            `json:"mutable"`
	Scope       string          `json:"scope"`
}
type SettingOption struct {
	Value string `json:"value"`
	Label string `json:"label"`
}
type NativeCommand struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	Description  string  `json:"description"`
	ArgumentHint *string `json:"argumentHint"`
	Available    bool    `json:"available"`
}
type UpdateSetting struct {
	SettingID                string `json:"settingId"`
	Value                    string `json:"value"`
	ExpectedControlsRevision string `json:"expectedControlsRevision"`
}
type ExecuteCommand struct {
	CommandID                string  `json:"commandId"`
	Arguments                string  `json:"arguments"`
	ExpectedControlsRevision string  `json:"expectedControlsRevision"`
	ExpectedTurnID           *string `json:"expectedTurnId"`
}

// Catalog text follows the shared controls contract; labels are not identifiers
// and provider-discovered values are preserved rather than whitespace-normalized.
func controlText(maximum int) validator {
	return func(data json.RawMessage) bool { return stringValue(data, false, maximum) }
}

var settingSchema = schema{
	"id": controlText(256), "category": enum("model", "reasoning", "permission"), "label": controlText(4096),
	"description": optional(controlText(4096)), "value": optional(controlText(4096)),
	"options": many(nested(schema{"value": controlText(4096), "label": controlText(4096)}), 0, 500, "value"),
	"mutable": boolean, "scope": enum("session", "next_turn"),
}
var nativeCommandSchema = schema{
	"id": controlText(256), "name": controlText(256), "description": controlText(4096), "argumentHint": optional(controlText(4096)), "available": boolean,
}
var controlsSchema = schema{
	"revision": sequence, "settings": many(nested(settingSchema), 0, 32, "id"), "commands": many(nested(nativeCommandSchema), 0, 500, "id"),
	"settingsError": optional(controlText(4096)), "commandsError": optional(controlText(4096)),
}

func DecodeControls(data []byte) (Controls, error) {
	return decode[Controls](data, nested(controlsSchema))
}

// Session turn starts use the same canonical UTC millisecond spelling as JS Date.
func turnStartedAt(data json.RawMessage) bool {
	var value string
	if json.Unmarshal(data, &value) != nil {
		return false
	}
	parsed, err := time.Parse("2006-01-02T15:04:05.000Z", value)
	return err == nil && parsed.UTC().Format("2006-01-02T15:04:05.000Z") == value
}
