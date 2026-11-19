package goaldependencies

import (
	"bytes"
	"encoding/json"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

func invalid(message string) error { return &model.Fault{Code: "invalid_input", Message: message} }

// ParseRevision preserves the complete positive int64 decimal value.
func ParseRevision(value string) (int64, error) {
	n, err := strconv.ParseInt(value, 10, 64)
	if err != nil || n < 1 || strconv.FormatInt(n, 10) != value {
		return 0, invalid("ifRevision must be a canonical positive int64 decimal string.")
	}
	return n, nil
}

func requiredString(fields map[string]json.RawMessage, key string) (string, error) {
	var result string
	if json.Unmarshal(fields[key], &result) != nil || bytes.Equal(bytes.TrimSpace(fields[key]), []byte("null")) {
		return "", invalid(key + " must be a string.")
	}
	return result, nil
}

func entries(fields map[string]json.RawMessage, key string) ([]json.RawMessage, error) {
	raw, present := fields[key]
	if !present {
		return nil, nil
	}
	var result []json.RawMessage
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &result) != nil || len(result) > taskcore.GoalPrerequisiteLimit {
		return nil, invalid(key + " must be an array of at most 30 entries.")
	}
	return result, nil
}

func reference(raw json.RawMessage, retained bool) (taskcore.GoalDependencyReference, error) {
	allowed := []string{"projectId", "goalId"}
	if retained {
		allowed = append(allowed, "edgeId")
	}
	fields, err := jsonobject.Decode(raw, "prerequisite", allowed...)
	if err != nil {
		return taskcore.GoalDependencyReference{}, invalid(err.Error())
	}
	var result taskcore.GoalDependencyReference
	if _, exists := fields["edgeId"]; exists {
		if len(fields) != 1 {
			return result, invalid("A prerequisite must identify either an edge or a Goal.")
		}
		result.EdgeID, err = requiredString(fields, "edgeId")
		if err == nil && result.EdgeID == "" {
			err = invalid("edgeId must be a UUID.")
		}
		return result, err
	}
	result.ProjectID, err = requiredString(fields, "projectId")
	if err != nil {
		return result, err
	}
	result.GoalID, err = requiredString(fields, "goalId")
	return result, err
}

// DecodeEdit is shared by transport adapters so unions and field presence have
// identical admission before a relation write is invoked.
func DecodeEdit(data []byte) (taskcore.GoalDependencyEdit, error) {
	var result taskcore.GoalDependencyEdit
	if !jsonunicode.Valid(data) {
		return result, invalid("Goal dependency input must be valid UTF-8.")
	}
	fields, err := jsonobject.Decode(data, "Goal dependency input", "ifRevision", "mode", "add", "remove", "prerequisites")
	if err != nil {
		return result, invalid(err.Error())
	}
	value, err := requiredString(fields, "ifRevision")
	if err != nil {
		return result, err
	}
	result.IfRevision, err = ParseRevision(value)
	if err != nil {
		return result, err
	}
	result.Mode, err = requiredString(fields, "mode")
	if err != nil {
		return result, err
	}
	for _, key := range []string{"add", "prerequisites", "remove"} {
		values, err := entries(fields, key)
		if err != nil {
			return result, err
		}
		if values == nil {
			continue
		}
		switch key {
		case "add":
			result.Add = make([]taskcore.GoalDependencyEndpoint, 0, len(values))
		case "remove":
			result.Remove = make([]string, 0, len(values))
		case "prerequisites":
			result.Prerequisites = make([]taskcore.GoalDependencyReference, 0, len(values))
		}
		for _, raw := range values {
			if key == "remove" {
				value, err := requiredString(map[string]json.RawMessage{"edgeId": raw}, "edgeId")
				if err != nil {
					return result, err
				}
				result.Remove = append(result.Remove, value)
				continue
			}
			ref, err := reference(raw, key == "prerequisites")
			if err != nil {
				return result, err
			}
			if key == "add" {
				result.Add = append(result.Add, taskcore.GoalDependencyEndpoint{ProjectID: ref.ProjectID, GoalID: ref.GoalID})
			} else {
				result.Prerequisites = append(result.Prerequisites, ref)
			}
		}
	}
	return result, taskcore.ValidateGoalDependencyEdit(result)
}
