package model

import (
	"testing"
	"time"
)

func TestThreadPositionRetainsMessageIdentityAndDatabasePrecision(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000001"
	for _, test := range []struct {
		name         string
		milliseconds int
	}{
		{name: ".000", milliseconds: 0},
		{name: ".120", milliseconds: 120},
		{name: ".123", milliseconds: 123},
	} {
		t.Run(test.name, func(t *testing.T) {
			stamp := time.Date(2026, 11, 3, 10, 20, 30, test.milliseconds*int(time.Millisecond), time.UTC)
			message := ThreadMessage{TaskID: "00000000-0000-4000-8000-000000000002", ID: id, CreatedAt: stamp, Body: "initial body"}
			position := message.Position()
			if position.ID != id || position.CreatedAt != stamp || position.CreatedAt.Location() != time.UTC {
				t.Fatalf("message position lost identity or precision: %#v", position)
			}
			message.Body = "another body"
			message.Author = ThreadAuthor{UserID: "00000000-0000-4000-8000-000000000004"}
			if message.Position() != position {
				t.Fatal("display fields changed the pagination boundary")
			}
			// The same UUID may belong to another task. Position is interpreted
			// within the selected task, rather than acting as a global identity.
			message.TaskID = "00000000-0000-4000-8000-000000000003"
			if message.Position() != position {
				t.Fatal("task-local UUID collision changed the composite position")
			}
			message.CreatedAt = stamp.Add(time.Millisecond)
			if !message.Position().CreatedAt.After(position.CreatedAt) || position.CreatedAt != stamp {
				t.Fatal("retained position changed with a later message value")
			}
		})
	}
}
