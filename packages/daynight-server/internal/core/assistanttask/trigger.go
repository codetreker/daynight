package assistanttask

import (
	"encoding/json"
	"strconv"
	"time"
)

func normalizeTrigger(raw json.RawMessage) (json.RawMessage, error) {
	canonical, err := canonicalJSON(raw)
	if err != nil {
		return nil, err
	}
	if string(canonical) == "null" {
		return canonical, nil
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(canonical, &fields) != nil || fields == nil {
		return nil, invalid("A trigger must be an interval or daily object.")
	}
	var kind string
	if json.Unmarshal(fields["kind"], &kind) != nil {
		return nil, invalid("A trigger kind is required.")
	}
	switch kind {
	case "interval":
		if len(fields) != 2 {
			return nil, invalid("Interval triggers accept only kind and minutes.")
		}
		minutes, err := strconv.ParseInt(string(fields["minutes"]), 10, 64)
		if err != nil || minutes < 1 {
			return nil, invalid("Trigger interval must be a positive whole number of minutes.")
		}
	case "daily":
		if len(fields) != 3 {
			return nil, invalid("Daily triggers require kind, time and timeZone.")
		}
		var clock, zone string
		if json.Unmarshal(fields["time"], &clock) != nil || json.Unmarshal(fields["timeZone"], &zone) != nil || len(clock) != 5 {
			return nil, invalid("Daily trigger time and time zone are invalid.")
		}
		if _, err := time.Parse("15:04", clock); err != nil {
			return nil, invalid("Daily trigger time must be HH:MM.")
		}
		if zone == "" || zone == "Local" {
			return nil, invalid("Daily trigger time zone must be explicit.")
		}
		if _, err := time.LoadLocation(zone); err != nil {
			return nil, invalid("Daily trigger time zone must be an IANA name.")
		}
	default:
		return nil, invalid("Trigger kind must be interval or daily.")
	}
	return canonical, nil
}
