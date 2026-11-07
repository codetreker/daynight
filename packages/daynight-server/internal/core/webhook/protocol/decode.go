package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// Decode verifies a complete v1 CloudEvent, including unknown and duplicate
// fields, field presence, identity, subject and type-specific constraints.
func Decode(body []byte) (string, Fact, error) {
	var f Fact
	if len(body) > MaxBodyBytes || len(body) == 0 {
		return "", f, fmt.Errorf("invalid event size")
	}
	if err := checkJSON(body); err != nil {
		return "", f, err
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		return "", f, err
	}
	if err := keys(top, nil, "specversion", "id", "source", "type", "subject", "time", "datacontenttype", "data"); err != nil {
		return "", f, err
	}
	var v struct {
		SpecVersion     string          `json:"specversion"`
		ID              string          `json:"id"`
		Source          string          `json:"source"`
		Type            string          `json:"type"`
		Subject         string          `json:"subject"`
		Time            string          `json:"time"`
		DataContentType string          `json:"datacontenttype"`
		Data            json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &v); err != nil {
		return "", f, err
	}
	if v.SpecVersion != "1.0" || v.DataContentType != "application/json" || !strings.HasPrefix(v.Type, "cc.daynight.") || !strings.HasSuffix(v.Type, ".v1") {
		return "", f, fmt.Errorf("invalid envelope")
	}
	f.Type = strings.TrimSuffix(strings.TrimPrefix(v.Type, "cc.daynight."), ".v1")
	occurred, err := parseTime(v.Time)
	if err != nil {
		return "", f, err
	}
	f.OccurredAt = occurred
	var d map[string]json.RawMessage
	if err = json.Unmarshal(v.Data, &d); err != nil {
		return "", f, fmt.Errorf("invalid data: %w", err)
	}
	var fields []string
	var nullable map[string]bool
	switch f.Type {
	case Created:
		fields = []string{"projectId", "taskId", "taskVersion", "status", "paused"}
	case StatusChanged:
		fields = []string{"projectId", "taskId", "taskVersion", "previousStatus", "status"}
	case Paused:
		fields = []string{"projectId", "taskId", "taskVersion", "paused"}
	case Deleted:
		fields = []string{"projectId", "taskId", "taskVersion", "deletedAt"}
	case StepUpdated:
		fields = []string{"projectId", "taskId", "taskVersion", "stepId", "action", "fromPosition", "toPosition", "previousStatus", "status", "changedFields"}
		nullable = map[string]bool{"fromPosition": true, "toPosition": true, "previousStatus": true, "status": true}
	case ThreadPosted:
		fields = []string{"projectId", "taskId", "messageId", "createdAt", "position", "replyTo"}
		nullable = map[string]bool{"replyTo": true}
	default:
		return "", f, fmt.Errorf("invalid event type")
	}
	if err = keys(d, nullable, fields...); err != nil {
		return "", f, err
	}
	var values struct {
		ProjectID      string          `json:"projectId"`
		TaskID         string          `json:"taskId"`
		TaskVersion    string          `json:"taskVersion"`
		Status         *string         `json:"status"`
		PreviousStatus *string         `json:"previousStatus"`
		Paused         bool            `json:"paused"`
		DeletedAt      string          `json:"deletedAt"`
		StepID         string          `json:"stepId"`
		Action         string          `json:"action"`
		FromPosition   *string         `json:"fromPosition"`
		ToPosition     *string         `json:"toPosition"`
		ChangedFields  []string        `json:"changedFields"`
		MessageID      string          `json:"messageId"`
		CreatedAt      string          `json:"createdAt"`
		Position       json.RawMessage `json:"position"`
		ReplyTo        *string         `json:"replyTo"`
	}
	if err = json.Unmarshal(v.Data, &values); err != nil {
		return "", f, err
	}
	f.ProjectID, f.TaskID = values.ProjectID, values.TaskID
	f.Paused, f.StepID, f.Action, f.ChangedFields, f.MessageID, f.ReplyTo = values.Paused, values.StepID, values.Action, values.ChangedFields, values.MessageID, values.ReplyTo
	if values.Status != nil {
		f.Status = *values.Status
	}
	if values.PreviousStatus != nil {
		f.PreviousStatus = *values.PreviousStatus
	}
	if f.Type != ThreadPosted {
		f.TaskVersion, err = positiveInt(values.TaskVersion)
		if err != nil {
			return "", f, err
		}
	}
	if f.Type == Deleted {
		t, e := parseTime(values.DeletedAt)
		if e != nil {
			return "", f, e
		}
		f.DeletedAt = &t
	}
	if f.Type == StepUpdated {
		f.FromPosition, err = parsePosition(values.FromPosition)
		if err != nil {
			return "", f, err
		}
		f.ToPosition, err = parsePosition(values.ToPosition)
		if err != nil {
			return "", f, err
		}
	}
	if f.Type == ThreadPosted {
		t, e := parseTime(values.CreatedAt)
		if e != nil {
			return "", f, e
		}
		f.CreatedAt = &t
		var p map[string]json.RawMessage
		if e = json.Unmarshal(values.Position, &p); e != nil {
			return "", f, e
		}
		if e = keys(p, nil, "createdAt", "messageId"); e != nil {
			return "", f, e
		}
		var pos position
		if e = json.Unmarshal(values.Position, &pos); e != nil {
			return "", f, e
		}
		if pos.CreatedAt != values.CreatedAt || pos.MessageID != values.MessageID {
			return "", f, fmt.Errorf("invalid thread position")
		}
	}
	canonical, err := Render(v.ID, f)
	if err != nil {
		return "", f, err
	}
	var rendered struct {
		Source  string `json:"source"`
		Subject string `json:"subject"`
	}
	if err = json.Unmarshal(canonical, &rendered); err != nil {
		return "", f, err
	}
	if v.Source != rendered.Source || v.Subject != rendered.Subject {
		return "", f, fmt.Errorf("invalid source or subject")
	}
	return v.ID, f, nil
}

func keys(m map[string]json.RawMessage, nullable map[string]bool, required ...string) error {
	if len(m) != len(required) {
		return fmt.Errorf("missing or unknown field")
	}
	for _, k := range required {
		v, ok := m[k]
		if !ok || (!nullable[k] && bytes.Equal(bytes.TrimSpace(v), []byte("null"))) {
			return fmt.Errorf("missing or null field %s", k)
		}
	}
	return nil
}
func parseTime(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil || !validTime(t) || wireTime(t) != s {
		return time.Time{}, fmt.Errorf("invalid time")
	}
	return t, nil
}
func positiveInt(s string) (int64, error) {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil || n <= 0 || strconv.FormatInt(n, 10) != s {
		return 0, fmt.Errorf("invalid positive integer")
	}
	return n, nil
}
func parsePosition(s *string) (*int64, error) {
	if s == nil {
		return nil, nil
	}
	n, err := strconv.ParseInt(*s, 10, 64)
	if err != nil || n < 0 || strconv.FormatInt(n, 10) != *s {
		return nil, fmt.Errorf("invalid position")
	}
	return &n, nil
}

func checkJSON(data []byte) error {
	d := json.NewDecoder(bytes.NewReader(data))
	if err := checkValue(d); err != nil {
		return err
	}
	if _, err := d.Token(); err != io.EOF {
		return fmt.Errorf("trailing JSON")
	}
	return nil
}
func checkValue(d *json.Decoder) error {
	token, err := d.Token()
	if err != nil {
		return err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]bool{}
		for d.More() {
			token, err = d.Token()
			if err != nil {
				return err
			}
			key, ok := token.(string)
			if !ok || seen[key] {
				return fmt.Errorf("duplicate or invalid JSON field")
			}
			seen[key] = true
			if err = checkValue(d); err != nil {
				return err
			}
		}
		token, err = d.Token()
		if err != nil || token != json.Delim('}') {
			return fmt.Errorf("invalid JSON object")
		}
	case '[':
		for d.More() {
			if err = checkValue(d); err != nil {
				return err
			}
		}
		token, err = d.Token()
		if err != nil || token != json.Delim(']') {
			return fmt.Errorf("invalid JSON array")
		}
	default:
		return fmt.Errorf("invalid JSON")
	}
	return nil
}
