package model

// TagNameFilter selects task tags by name across projects.
type TagNameFilter struct {
	Names []string `json:"names"`
	Match string   `json:"match"`
}
