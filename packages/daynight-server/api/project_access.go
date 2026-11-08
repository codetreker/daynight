package api

import (
	"time"

	profileprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/profile"
)

type ProjectGrant struct {
	ProjectID string    `json:"projectId"`
	UserID    string    `json:"userId"`
	Role      string    `json:"role"`
	Version   int64     `json:"version"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type TeamRef = profileprotocol.TeamRef

type ProjectInheritance struct {
	Team TeamRef `json:"team"`
	Role string  `json:"role"`
}

type ProjectAccess struct {
	ProjectID     string           `json:"projectId"`
	OwnerTeam     TeamRef          `json:"ownerTeam"`
	Ownership     ProjectOwnership `json:"ownership"`
	TeamRole      *string          `json:"teamRole"`
	CanTransfer   bool             `json:"canTransfer"`
	EffectiveRole string           `json:"effectiveRole"`
	DirectGrant   *ProjectGrant    `json:"directGrant"`
}
