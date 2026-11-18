package properties

import (
	"bytes"
	"encoding/json"
	"maps"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
)

// CanonicalName maps the legacy public spelling to the persisted name.
func CanonicalName(name string) string {
	if name == "paused" {
		return "blocked"
	}
	return name
}

func CheckWritable(name string) error {
	name = CanonicalName(name)
	definition, ok := taskproperty.Definitions()[name]
	if !ok {
		return &taskproperty.ValidationError{Path: "properties", Rule: "properties contains an unknown attribute"}
	}
	if definition.ReadOnly {
		return &taskproperty.ValidationError{Path: "properties." + name, Rule: "properties." + name + " is read-only and managed by execution operations"}
	}
	return nil
}

func Normalize(values model.TaskProperties) (model.TaskProperties, error) {
	result, err := normalizeWritable(values)
	if err != nil {
		return nil, err
	}
	if err := taskproperty.Admit(result); err != nil {
		return nil, err
	}
	return result, nil
}

func normalizeWritable(values model.TaskProperties) (model.TaskProperties, error) {
	result := make(model.TaskProperties, len(values))
	for _, name := range slices.Sorted(maps.Keys(values)) {
		if err := CheckWritable(name); err != nil {
			return nil, err
		}
		canonical := CanonicalName(name)
		value, err := taskproperty.NormalizeValue(canonical, values[name])
		if err != nil {
			return nil, err
		}
		if existing, ok := result[canonical]; ok && !bytes.Equal(existing, value) {
			return nil, &taskproperty.ValidationError{Path: "properties.blocked", Rule: "properties.blocked and properties.paused must agree"}
		}
		result[canonical] = value
	}
	return result, nil
}

func DecodePatch(data []byte) (model.TaskPropertiesPatch, error) {
	names := slices.Sorted(maps.Keys(taskproperty.Definitions()))
	names = append(names, "paused")
	fields, err := jsonobject.Decode(data, "properties", names...)
	if err != nil {
		return nil, &taskproperty.ValidationError{Path: "properties", Rule: err.Error(), Cause: err}
	}
	return normalizeWritable(model.TaskProperties(fields))
}

func ParseInput(name, input string) (json.RawMessage, error) {
	name = CanonicalName(name)
	if err := CheckWritable(name); err != nil {
		return nil, err
	}
	value, err := taskproperty.ParseInput(name, input)
	if err != nil {
		return nil, err
	}
	if err := taskproperty.AdmitValue(name, value); err != nil {
		return nil, err
	}
	return value, nil
}

func WithWorker(values model.TaskProperties, worker *model.WorkerClaim) (model.TaskProperties, error) {
	result := taskproperty.Clone(values)
	if worker == nil {
		delete(result, "worker")
		delete(result, "sessionStartup")
		return result, nil
	}
	raw, err := taskproperty.EncodeWorker(worker)
	if err != nil {
		return nil, err
	}
	value, err := taskproperty.NormalizeValue("worker", raw)
	if err != nil {
		return nil, err
	}
	if err := taskproperty.AdmitValue("worker", value); err != nil {
		return nil, err
	}
	result["worker"] = value
	return result, nil
}
