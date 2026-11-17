package worker

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	workerprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/worker"
)

func TestArchiveSessionsInputAndLegacyPreservation(t *testing.T) {
	caps := workerprotocol.Capabilities{ArchiveSessions: true}
	for _, enabled := range []bool{false, true} {
		document := configurationInputDocument()
		document["archiveSessions"] = enabled
		value, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), caps)
		if err != nil || value.ArchiveSessions == nil || *value.ArchiveSessions != enabled {
			t.Fatalf("input %v: %+v %v", enabled, value, err)
		}
	}
	for _, invalid := range []any{nil, "false", 0, []any{}} {
		document := configurationInputDocument()
		document["archiveSessions"] = invalid
		if _, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), caps); err == nil {
			t.Fatalf("accepted %v", invalid)
		}
	}
	document := configurationInputDocument()
	if _, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), caps); err == nil {
		t.Fatal("missing field accepted")
	}
	document["archiveSessions"] = false
	if _, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{}); err == nil {
		t.Fatal("unnegotiated field accepted")
	}
	delete(document, "archiveSessions")
	value, err := ParseWorkerConfigurationProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{})
	if err != nil || !value.PreserveArchiveSessions {
		t.Fatalf("legacy input: %+v %v", value, err)
	}
	disabled := false
	dao := configuredDAO("7")
	dao.current.Desired.Value.ArchiveSessions = &disabled
	value.MaxConcurrent = 2
	got, err := PutConfiguration(context.Background(), dao, model.Principal{UserID: "user"}, "worker", 7, value)
	if err != nil || got.Desired.Value.ArchiveSessions == nil || *got.Desired.Value.ArchiveSessions || got.Desired.Revision != "8" {
		t.Fatalf("legacy preservation: %+v %v", got, err)
	}
	_, err = PutConfiguration(context.Background(), dao, model.Principal{UserID: "user"}, "worker", 6, value)
	requireFault(t, err, "version_conflict")
	if dao.desiredWrites != 1 {
		t.Fatalf("stale write persisted: %d", dao.desiredWrites)
	}
}

func TestArchiveSessionsObservationInput(t *testing.T) {
	for _, applied := range []any{true, false, nil, "false", 1} {
		item := configurationInputItem("archiveSessions", applied)
		if applied == nil {
			item["state"] = "pending"
		}
		document := configurationInputExchange(item)
		_, err := ParseWorkerConfigurationExchangeProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{ArchiveSessions: true})
		valid := applied == true || applied == false || applied == nil
		if (err == nil) != valid {
			t.Fatalf("applied=%v err=%v", applied, err)
		}
		if _, err := ParseWorkerConfigurationExchangeProtocol(configurationInputJSON(t, document), workerprotocol.Capabilities{}); err == nil {
			t.Fatal("unnegotiated observation accepted")
		}
	}
}
