package store

import (
	"reflect"
	"testing"
)

func TestSnapshotScopeExposesOnlyReadCapabilities(t *testing.T) {
	scope := reflect.TypeOf((*SnapshotScope)(nil)).Elem()
	for i := 0; i < scope.NumMethod(); i++ {
		method := scope.Method(i)
		if method.Name == "ObservedAt" {
			continue
		}
		if method.Type.NumOut() != 1 || method.Type.Out(0).Kind() != reflect.Interface {
			t.Fatalf("%s exposes a non-reader capability: %v", method.Name, method.Type)
		}
		reader := method.Type.Out(0)
		for _, forbidden := range []string{"Exec", "Pool", "Begin", "Commit", "Rollback", "CreateTask", "WriteProject", "WriteThread"} {
			if _, ok := reader.MethodByName(forbidden); ok {
				t.Errorf("%s exposes %s", method.Name, forbidden)
			}
		}
	}
}
