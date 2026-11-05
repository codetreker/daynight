package core

import "time"

// BotWorkerPreference contains only successful explicit choices for one Worker.
// Provider model and arguments always come from that Worker's current report.
type BotWorkerPreference struct {
	Cwd      *string
	Provider *string
}

// BotDefaultsInput is owner-scoped input used by both preview and creation.
// ObservedAt evaluates freshness after the data reads, not a shared snapshot
// boundary. Workers are ordered by their first registration time and UUID.
type BotDefaultsInput struct {
	ObservedAt        time.Time
	Workers           []WorkerSnapshot
	PreferredWorkerID *string
	WorkerPreferences map[string]BotWorkerPreference
}
