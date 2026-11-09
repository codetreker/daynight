package model

import "time"

// BotWorkerPreference contains only successful explicit choices for one Worker.
// Native choices are keyed by Provider and effort choices by the resolved model.
type BotWorkerPreference struct {
	Cwd      *string
	Provider *string
	Native   map[string]BotNativePreference
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

type BotNativePreference struct {
	Model   *string
	Efforts map[string]string
}
