package httpx

import (
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonobject"
)

func WorkerMachineInput(raw json.RawMessage) (model.WorkerMachine, error) {
	fields, err := jsonobject.Decode(raw, "machine", "id", "name")
	if err != nil {
		return model.WorkerMachine{}, InvalidInput(err.Error())
	}
	id, err := RequiredString(fields, "id")
	if err != nil {
		return model.WorkerMachine{}, err
	}
	name, err := RequiredString(fields, "name")
	return model.WorkerMachine{ID: id, Name: name}, err
}
