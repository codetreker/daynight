package store

// TagFilter selects a normalized set of Project-local tags before pagination.
type TagFilter struct {
	TagIDs   []string `json:"tagIds"`
	TagMatch string   `json:"tagMatch"`
	Untagged bool     `json:"untagged"`
}
