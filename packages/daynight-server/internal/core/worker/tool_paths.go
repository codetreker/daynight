package worker

import (
	"encoding/json"
	"regexp"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

const MaxToolPathBytes = 4096

var absoluteToolPath = regexp.MustCompile(`^(/|[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+([\\/]|$))`)

func validToolPath(value string) bool {
	return len(value) <= MaxToolPathBytes && configurationText(value) && absoluteToolPath.MatchString(value)
}

func parseToolPathChoice(raw json.RawMessage) (*model.ToolPathChoice, error) {
	fields, err := configurationObject(raw, "tool path choice", true, "kind", "path")
	if err != nil {
		return nil, err
	}
	var choice model.ToolPathChoice
	if err := configurationDecode(fields["kind"], &choice.Kind); err != nil {
		return nil, err
	}
	keys := []string{"kind"}
	if choice.Kind == "path" {
		keys = append(keys, "path")
	}
	if _, err := configurationObject(raw, "tool path choice", false, keys...); err != nil {
		return nil, err
	}
	if choice.Kind == "path" {
		if err := configurationDecode(fields["path"], &choice.Path); err != nil || !validToolPath(choice.Path) {
			return nil, invalidInput("Tool path must be absolute UTF-8 text without control characters and at most 4096 bytes.")
		}
	} else if choice.Kind != "auto" {
		return nil, invalidInput("Tool path kind must be auto or path.")
	}
	return &choice, nil
}

func parseToolPaths(raw json.RawMessage, allowNull bool) (model.WorkerToolPaths, error) {
	var value model.WorkerToolPaths
	fields, err := configurationObject(raw, "toolPaths", false, "codex", "copilot", "herdr")
	if err != nil {
		return value, err
	}
	for tool, target := range map[string]**model.ToolPathChoice{"codex": &value.Codex, "copilot": &value.Copilot, "herdr": &value.Herdr} {
		if allowNull && configurationNull(fields[tool]) {
			continue
		}
		*target, err = parseToolPathChoice(fields[tool])
		if err != nil {
			return value, err
		}
	}
	return value, nil
}

func adoptToolPaths(value, bootstrap model.WorkerToolPaths) model.WorkerToolPaths {
	if value.Codex == nil {
		value.Codex = bootstrap.Codex
	}
	if value.Copilot == nil {
		value.Copilot = bootstrap.Copilot
	}
	if value.Herdr == nil {
		value.Herdr = bootstrap.Herdr
	}
	return value
}

func clearsToolPaths(current, value model.WorkerToolPaths) bool {
	return current.Codex != nil && value.Codex == nil || current.Copilot != nil && value.Copilot == nil || current.Herdr != nil && value.Herdr == nil
}
