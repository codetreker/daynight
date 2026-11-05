package properties

import (
	"encoding/json"
	"maps"
	"slices"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
)

func CheckWritable(name string) error {
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
	result := make(model.TaskProperties, len(values))
	for _, name := range slices.Sorted(maps.Keys(values)) {
		if err := CheckWritable(name); err != nil {
			return nil, err
		}
		value, err := taskproperty.NormalizeValue(name, values[name])
		if err != nil {
			return nil, err
		}
		result[name] = value
	}
	return result, nil
}

func DecodePatch(data []byte) (model.TaskPropertiesPatch, error) {
	names := slices.Sorted(maps.Keys(taskproperty.Definitions()))
	fields, err := jsonobject.Decode(data, "properties", names...)
	if err != nil {
		return nil, &taskproperty.ValidationError{Path: "properties", Rule: err.Error(), Cause: err}
	}
	return Normalize(model.TaskProperties(fields))
}

func ParseInput(name, input string) (json.RawMessage, error) {
	if err := CheckWritable(name); err != nil {
		return nil, err
	}
	return taskproperty.ParseInput(name, input)
}

func WithWorker(values model.TaskProperties, worker *model.WorkerClaim) (model.TaskProperties, error) {
	result := taskproperty.Clone(values)
	if worker == nil {
		delete(result, "worker")
		delete(result, "sessionStartup")
		return result, nil
	}
	value, err := taskproperty.EncodeWorker(worker)
	if err != nil {
		return nil, err
	}
	result["worker"] = value
	return result, nil
}
