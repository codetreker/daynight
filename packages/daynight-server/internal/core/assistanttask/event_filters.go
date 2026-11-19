package assistanttask

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

// eventTypeFilter validates an event page type selection and applies it to
// the store query. Selecting inbound events also excludes paused tasks: their
// inbound events stay pending until resume, and filtering in the query keeps
// a paused backlog from occupying pages that a Worker would otherwise skip.
func eventTypeFilter(query *store.AssistantTaskQuery, input PageInput) error {
	if input.Type != "" && input.ExcludeType != "" {
		return invalid("Event type and excluded type filters cannot be combined.")
	}
	for _, kind := range []string{input.Type, input.ExcludeType} {
		if kind == "" {
			continue
		}
		if _, err := eventAttention(kind); err != nil {
			return invalid("Event type filter is invalid.")
		}
	}
	query.EventType, query.ExcludeEventType = input.Type, input.ExcludeType
	query.ExcludePausedTasks = input.Type == InboundEventType
	return nil
}
