// Package protocol defines the immutable webhook event wire format.
package protocol

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"time"

	"github.com/google/uuid"
)

const (
	Created       = "task.created"
	StatusChanged = "task.status_changed"
	Paused        = "task.paused"
	Deleted       = "task.deleted"
	StepUpdated   = "task.step_updated"
	ThreadPosted  = "task.thread_posted"
	MediaType     = "application/cloudevents+json"
	MaxBodyBytes  = 65536
)

// Fact contains only the data allowed by the corresponding v1 event schema.
// Zero values mean inapplicable fields except Paused, which is meaningful for
// Created and always true for Paused. Positions are zero-based.
type Fact struct {
	Type, ProjectID, TaskID  string
	OccurredAt               time.Time
	TaskVersion              int64
	Status, PreviousStatus   string
	Paused                   bool
	DeletedAt                *time.Time
	StepID, Action           string
	FromPosition, ToPosition *int64
	ChangedFields            []string
	MessageID                string
	CreatedAt                *time.Time
	ReplyTo                  *string
}

type envelope struct {
	SpecVersion     string `json:"specversion"`
	ID              string `json:"id"`
	Source          string `json:"source"`
	Type            string `json:"type"`
	Subject         string `json:"subject"`
	Time            string `json:"time"`
	DataContentType string `json:"datacontenttype"`
	Data            any    `json:"data"`
}
type base struct {
	ProjectID string `json:"projectId"`
	TaskID    string `json:"taskId"`
}
type createdData struct {
	base
	TaskVersion string `json:"taskVersion"`
	Status      string `json:"status"`
	Paused      bool   `json:"paused"`
}
type statusData struct {
	base
	TaskVersion    string `json:"taskVersion"`
	PreviousStatus string `json:"previousStatus"`
	Status         string `json:"status"`
}
type pausedData struct {
	base
	TaskVersion string `json:"taskVersion"`
	Paused      bool   `json:"paused"`
}
type deletedData struct {
	base
	TaskVersion string `json:"taskVersion"`
	DeletedAt   string `json:"deletedAt"`
}
type stepData struct {
	base
	TaskVersion    string   `json:"taskVersion"`
	StepID         string   `json:"stepId"`
	Action         string   `json:"action"`
	FromPosition   *string  `json:"fromPosition"`
	ToPosition     *string  `json:"toPosition"`
	PreviousStatus *string  `json:"previousStatus"`
	Status         *string  `json:"status"`
	ChangedFields  []string `json:"changedFields"`
}
type position struct {
	CreatedAt string `json:"createdAt"`
	MessageID string `json:"messageId"`
}
type threadData struct {
	base
	MessageID string   `json:"messageId"`
	CreatedAt string   `json:"createdAt"`
	Position  position `json:"position"`
	ReplyTo   *string  `json:"replyTo"`
}

var stepID = regexp.MustCompile(`^[0-9a-f]{8}$`)

func validUUID(s string) bool { u, err := uuid.Parse(s); return err == nil && u.String() == s }
func taskStatus(s string) bool {
	return s == "todo" || s == "in_progress" || s == "done" || s == "cancelled"
}
func stepStatus(s string) bool {
	return s == "todo" || s == "in_progress" || s == "done" || s == "skipped"
}
func validTime(t time.Time) bool  { return !t.IsZero() && t.Year() >= 1 && t.Year() <= 9999 }
func wireTime(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }
func strptr(s string) *string     { return &s }
func positionString(n *int64) *string {
	if n == nil {
		return nil
	}
	s := strconv.FormatInt(*n, 10)
	return &s
}

// Render validates a v1 fact and returns its deterministic structured JSON bytes.
func Render(eventID string, f Fact) ([]byte, error) {
	if !validUUID(eventID) || !validUUID(f.ProjectID) || !validUUID(f.TaskID) || !validTime(f.OccurredAt) {
		return nil, fmt.Errorf("invalid event identity or time")
	}
	if f.Type != ThreadPosted && f.TaskVersion <= 0 {
		return nil, fmt.Errorf("invalid task version")
	}
	b := base{f.ProjectID, f.TaskID}
	version := strconv.FormatInt(f.TaskVersion, 10)
	subject := "tasks/" + f.TaskID
	var data any
	// Validate fields unrelated to the selected event rather than ignoring them.
	switch f.Type {
	case Created:
		if !taskStatus(f.Status) || f.PreviousStatus != "" || f.DeletedAt != nil || hasStep(f) || hasThread(f) {
			return nil, fmt.Errorf("invalid created fact")
		}
		data = createdData{b, version, f.Status, f.Paused}
	case StatusChanged:
		if !taskStatus(f.Status) || !taskStatus(f.PreviousStatus) || f.Status == f.PreviousStatus || f.Paused || f.DeletedAt != nil || hasStep(f) || hasThread(f) {
			return nil, fmt.Errorf("invalid status fact")
		}
		data = statusData{b, version, f.PreviousStatus, f.Status}
	case Paused:
		if !f.Paused || f.Status != "" || f.PreviousStatus != "" || f.DeletedAt != nil || hasStep(f) || hasThread(f) {
			return nil, fmt.Errorf("invalid paused fact")
		}
		data = pausedData{b, version, true}
	case Deleted:
		if f.DeletedAt == nil || !validTime(*f.DeletedAt) || !f.DeletedAt.Equal(f.OccurredAt) || f.Status != "" || f.PreviousStatus != "" || f.Paused || hasStep(f) || hasThread(f) {
			return nil, fmt.Errorf("invalid deleted fact")
		}
		data = deletedData{b, version, wireTime(*f.DeletedAt)}
	case StepUpdated:
		if !stepID.MatchString(f.StepID) || f.Paused || f.DeletedAt != nil || hasThread(f) {
			return nil, fmt.Errorf("invalid step fact")
		}
		fields := append([]string{}, f.ChangedFields...)
		for i, field := range fields {
			if (field != "description" && field != "title") || (i > 0 && fields[i-1] >= field) {
				return nil, fmt.Errorf("invalid changed fields")
			}
		}
		var previous, status *string
		switch f.Action {
		case "created", "deleted":
			if f.FromPosition != nil || f.ToPosition != nil || f.PreviousStatus != "" || f.Status != "" || len(fields) != 0 {
				return nil, fmt.Errorf("invalid step action")
			}
		case "moved":
			if f.FromPosition == nil || f.ToPosition == nil || *f.FromPosition < 0 || *f.ToPosition < 0 || *f.FromPosition == *f.ToPosition || f.PreviousStatus != "" || f.Status != "" || len(fields) != 0 {
				return nil, fmt.Errorf("invalid step move")
			}
		case "status_changed":
			if f.FromPosition != nil || f.ToPosition != nil || !stepStatus(f.PreviousStatus) || !stepStatus(f.Status) || f.PreviousStatus == f.Status {
				return nil, fmt.Errorf("invalid step status")
			}
			previous, status = strptr(f.PreviousStatus), strptr(f.Status)
		case "updated":
			if f.FromPosition != nil || f.ToPosition != nil || f.PreviousStatus != "" || f.Status != "" || len(fields) == 0 {
				return nil, fmt.Errorf("invalid step update")
			}
		default:
			return nil, fmt.Errorf("invalid step action")
		}
		subject += "/steps"
		data = stepData{b, version, f.StepID, f.Action, positionString(f.FromPosition), positionString(f.ToPosition), previous, status, fields}
	case ThreadPosted:
		if f.TaskVersion != 0 || f.Status != "" || f.PreviousStatus != "" || f.Paused || f.DeletedAt != nil || hasStep(f) || !validUUID(f.MessageID) || f.CreatedAt == nil || !validTime(*f.CreatedAt) || !f.CreatedAt.Equal(f.OccurredAt) || (f.ReplyTo != nil && !validUUID(*f.ReplyTo)) {
			return nil, fmt.Errorf("invalid thread fact")
		}
		subject += "/thread/" + f.MessageID
		timestamp := wireTime(*f.CreatedAt)
		data = threadData{b, f.MessageID, timestamp, position{timestamp, f.MessageID}, f.ReplyTo}
	default:
		return nil, fmt.Errorf("invalid event type")
	}
	encoded, err := json.Marshal(envelope{"1.0", eventID, "urn:daynight:project:" + f.ProjectID, "cc.daynight." + f.Type + ".v1", subject, wireTime(f.OccurredAt), "application/json", data})
	if err != nil {
		return nil, fmt.Errorf("encode event: %w", err)
	}
	if len(encoded) > MaxBodyBytes {
		return nil, fmt.Errorf("event body exceeds limit")
	}
	return encoded, nil
}
func hasStep(f Fact) bool {
	return f.StepID != "" || f.Action != "" || f.FromPosition != nil || f.ToPosition != nil || len(f.ChangedFields) != 0
}
func hasThread(f Fact) bool { return f.MessageID != "" || f.CreatedAt != nil || f.ReplyTo != nil }
