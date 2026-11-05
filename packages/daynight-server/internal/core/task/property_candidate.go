package task

import (
	"encoding/json"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
)

func PropertyInput(name, input string) (json.RawMessage, error) {
	value, err := properties.ParseInput(name, input)
	if err != nil {
		return nil, PropertyInputError(err)
	}
	return value, nil
}

func CheckPropertyWritable(name string) error {
	return PropertyInputError(properties.CheckWritable(name))
}

func SetPropertyCandidate(current model.Task, name string, value json.RawMessage) (store.TaskWrite, bool) {
	values := CurrentWrite(current)
	values.Properties[name] = value
	return values, !taskproperty.Equal(current.Properties, values.Properties)
}

func RemovePropertyCandidate(current model.Task, name string) (store.TaskWrite, bool) {
	values := CurrentWrite(current)
	delete(values.Properties, name)
	return values, !taskproperty.Equal(current.Properties, values.Properties)
}
