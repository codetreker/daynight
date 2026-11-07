package webhook

import "slices"

type EventDefinition struct {
	Key           string `json:"key"`
	WireType      string `json:"wireType"`
	SchemaVersion string `json:"schemaVersion"`
	ResourceKind  string `json:"resourceKind"`
}

var eventCatalog = []EventDefinition{
	{Key: "task.created", WireType: "cc.daynight.task.created.v1", SchemaVersion: "1", ResourceKind: "project"},
	{Key: "task.status_changed", WireType: "cc.daynight.task.status_changed.v1", SchemaVersion: "1", ResourceKind: "project"},
	{Key: "task.paused", WireType: "cc.daynight.task.paused.v1", SchemaVersion: "1", ResourceKind: "project"},
	{Key: "task.deleted", WireType: "cc.daynight.task.deleted.v1", SchemaVersion: "1", ResourceKind: "project"},
	{Key: "task.step_updated", WireType: "cc.daynight.task.step_updated.v1", SchemaVersion: "1", ResourceKind: "project"},
	{Key: "task.thread_posted", WireType: "cc.daynight.task.thread_posted.v1", SchemaVersion: "1", ResourceKind: "project"},
}

func Catalog() []EventDefinition { return slices.Clone(eventCatalog) }

func RegisteredEvent(key string) bool {
	return slices.ContainsFunc(eventCatalog, func(event EventDefinition) bool { return event.Key == key })
}
