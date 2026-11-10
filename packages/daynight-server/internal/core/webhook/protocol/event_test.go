package protocol

import (
	"bytes"
	"os"
	"strings"
	"testing"
	"time"
)

const (
	eventID   = "a0be4d96-fb33-41ba-a7bd-7885c1e94247"
	projectID = "22222222-2222-4222-8222-222222222222"
	taskID    = "33333333-3333-4333-8333-333333333333"
	messageID = "44444444-4444-4444-8444-444444444444"
)

func sampleTime() time.Time { return time.Date(2026, 11, 6, 8, 0, 0, 0, time.UTC) }
func fact(kind string) Fact {
	return Fact{Type: kind, ProjectID: projectID, TaskID: taskID, OccurredAt: sampleTime(), TaskVersion: 42}
}
func TestPublishedExample(t *testing.T) {
	f := fact(Paused)
	f.Paused = true
	b, err := Render(eventID, f)
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("testdata/event.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(b, want) {
		t.Fatalf("wire bytes differ:\n%s", b)
	}
	if len(b) != 433 {
		t.Fatalf("length=%d", len(b))
	}
}
func TestAllFactsRoundTrip(t *testing.T) {
	one, two := int64(1), int64(2)
	ts := sampleTime()
	reply := "55555555-5555-4555-8555-555555555555"
	tests := []Fact{
		func() Fact { f := fact(Created); f.Status = "proposed"; return f }(),
		func() Fact { f := fact(StatusChanged); f.PreviousStatus = "proposed"; f.Status = "done"; return f }(),
		func() Fact {
			f := fact(StatusChanged)
			f.PreviousStatus = "in_progress"
			f.Status = "proposed"
			return f
		}(),
		func() Fact { f := fact(Created); f.Status = "todo"; f.Paused = true; return f }(),
		func() Fact { f := fact(StatusChanged); f.PreviousStatus = "done"; f.Status = "cancelled"; return f }(),
		func() Fact { f := fact(Paused); f.Paused = true; return f }(),
		func() Fact { f := fact(Deleted); f.DeletedAt = &ts; return f }(),
		func() Fact { f := fact(StepUpdated); f.StepID = "00000001"; f.Action = "created"; return f }(),
		func() Fact { f := fact(StepUpdated); f.StepID = "ffffffff"; f.Action = "deleted"; return f }(),
		func() Fact {
			f := fact(StepUpdated)
			f.StepID = "abcdef01"
			f.Action = "moved"
			f.FromPosition = &one
			f.ToPosition = &two
			return f
		}(),
		func() Fact {
			f := fact(StepUpdated)
			f.StepID = "abcdef01"
			f.Action = "status_changed"
			f.PreviousStatus = "todo"
			f.Status = "skipped"
			f.ChangedFields = []string{"description", "title"}
			return f
		}(),
		func() Fact {
			f := fact(StepUpdated)
			f.StepID = "abcdef01"
			f.Action = "updated"
			f.ChangedFields = []string{"title"}
			return f
		}(),
		func() Fact {
			f := fact(ThreadPosted)
			f.TaskVersion = 0
			f.MessageID = messageID
			f.CreatedAt = &ts
			f.ReplyTo = &reply
			return f
		}(),
	}
	for _, f := range tests {
		t.Run(f.Type+"/"+f.Action, func(t *testing.T) {
			b, err := Render(eventID, f)
			if err != nil {
				t.Fatal(err)
			}
			id, got, err := Decode(b)
			if err != nil {
				t.Fatalf("decode %s: %v", b, err)
			}
			encoded, err := Render(id, got)
			if err != nil || !bytes.Equal(b, encoded) {
				t.Fatalf("round trip %s / %s: %v", b, encoded, err)
			}
		})
	}
}
func TestRejectInvalidFacts(t *testing.T) {
	f := fact(Created)
	f.Status = "todo"
	t0 := sampleTime()
	one := int64(1)
	tests := []Fact{
		func() Fact { x := f; x.ProjectID = strings.ToUpper(eventID); return x }(),
		func() Fact { x := f; x.TaskVersion = 0; return x }(),
		func() Fact { x := f; x.Status = "skipped"; return x }(),
		func() Fact { x := f; x.CreatedAt = &t0; return x }(),
		func() Fact { x := fact(StatusChanged); x.Status = "todo"; x.PreviousStatus = "todo"; return x }(),
		func() Fact { x := fact(Paused); return x }(),
		func() Fact {
			x := fact(Deleted)
			x.DeletedAt = &t0
			x.OccurredAt = x.OccurredAt.Add(time.Second)
			return x
		}(),
		func() Fact { x := fact(StepUpdated); x.StepID = "0000000A"; x.Action = "created"; return x }(),
		func() Fact { x := fact(StepUpdated); x.StepID = "00000001"; x.Action = "updated"; return x }(),
		func() Fact {
			x := fact(StepUpdated)
			x.StepID = "00000001"
			x.Action = "updated"
			x.ChangedFields = []string{"title", "description"}
			return x
		}(),
		func() Fact {
			x := fact(StepUpdated)
			x.StepID = "00000001"
			x.Action = "moved"
			x.FromPosition = &one
			x.ToPosition = &one
			return x
		}(),
		func() Fact { x := fact(ThreadPosted); x.TaskVersion = 0; x.MessageID = messageID; return x }(),
	}
	for i, x := range tests {
		if _, err := Render(eventID, x); err == nil {
			t.Errorf("case %d unexpectedly accepted: %+v", i, x)
		}
	}
}
func TestDecodeRejectsInvalidWire(t *testing.T) {
	f := fact(Paused)
	f.Paused = true
	b, err := Render(eventID, f)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	bad := []string{
		strings.Replace(s, `"paused":true`, `"paused":true,"paused":true`, 1),
		strings.Replace(s, `"paused":true`, `"paused":null`, 1),
		strings.Replace(s, `"paused":true`, `"paused":true,"unknown":0`, 1),
		strings.Replace(s, `"taskVersion":"42"`, `"taskVersion":"042"`, 1),
		strings.Replace(s, `"taskVersion":"42"`, `"taskVersion":42`, 1),
		strings.Replace(s, `tasks/33333333-3333-4333-8333-333333333333`, `tasks/44444444-4444-4444-8444-444444444444`, 1),
		strings.Replace(s, `2026-11-06T08:00:00Z`, `2026-11-06T09:00:00+01:00`, 1),
		s + `{}`,
	}
	for i, v := range bad {
		if _, _, err := Decode([]byte(v)); err == nil {
			t.Errorf("case %d unexpectedly accepted: %s", i, v)
		}
	}
}

func TestRejectMalformedJSONContainers(t *testing.T) {
	for _, input := range []string{`[`, `[1,`, `{"x":`, `{"x":[1,}`, `{"x":1`, `{"x":1,"x":2}`, `[] []`} {
		if err := checkJSON([]byte(input)); err == nil {
			t.Errorf("accepted malformed JSON %q", input)
		}
	}
}

func TestDecodeRejectsOversizedBody(t *testing.T) {
	if _, _, err := Decode(bytes.Repeat([]byte("x"), MaxBodyBytes+1)); err == nil {
		t.Fatal("oversized body accepted")
	}
}
