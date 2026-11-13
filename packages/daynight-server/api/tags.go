package api

import "time"

type TagUsage struct {
	Tasks int64 `json:"tasks"`
	Goals int64 `json:"goals"`
}

type Tag struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"projectId"`
	Name      string    `json:"name"`
	Version   int64     `json:"version"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Usage     TagUsage  `json:"usage"`
}

type TagPage struct {
	Items        []Tag   `json:"items"`
	CatalogEpoch string  `json:"catalogEpoch"`
	NextCursor   *string `json:"nextCursor"`
}

type TagDeletionReceipt struct {
	ProjectID string `json:"projectId"`
	TagID     string `json:"tagId"`
	Deleted   bool   `json:"deleted"`
}
