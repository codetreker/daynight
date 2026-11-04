package api

import "time"

type ProjectGrant struct {
	ProjectID string    `json:"projectId"`
	UserID    string    `json:"userId"`
	Role      string    `json:"role"`
	Version   int64     `json:"version"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type ProjectAccess struct {
	EffectiveRole string        `json:"effectiveRole"`
	DirectGrant   *ProjectGrant `json:"directGrant"`
}
