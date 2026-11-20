package scopepolicy

// WebhookCapabilities describes the actual mounted management and delivery
// branches. Management can remain available while expansion and dispatch are
// disabled, allowing existing configurations to be narrowed or deleted.
type WebhookCapabilities struct {
	Management             bool
	ConfigurationExpansion bool
	Dispatch               bool
}

// FilterWebhookAvailability removes unavailable webhook scopes from an
// already profile-filtered catalog. It does not change the registry or the
// validity of previously issued scopes.
func FilterWebhookAvailability(entries []Entry, capabilities WebhookCapabilities) []Entry {
	available := make([]Entry, 0, len(entries))
	for _, entry := range entries {
		if entry.Group == "webhook" {
			if !capabilities.Management {
				continue
			}
			if entry.ID == "webhook:deliver" && !capabilities.ConfigurationExpansion && !capabilities.Dispatch {
				continue
			}
		}
		available = append(available, entry)
	}
	return available
}
