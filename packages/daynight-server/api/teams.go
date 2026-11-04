package api

import "time"

type TeamMember struct {
	TeamID    string    `json:"teamId"`
	UserID    string    `json:"userId"`
	Role      string    `json:"role"`
	Version   int64     `json:"version"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Team struct {
	TeamRef
	Version    int64      `json:"version"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
	Membership TeamMember `json:"membership"`
}

type TeamPage struct {
	Items      []Team  `json:"items"`
	NextCursor *string `json:"nextCursor"`
}

type CreateTeamRequest struct {
	Name           string `json:"name"`
	ExpectedUserID string `json:"expectedUserId"`
}

type ChangeTeamRequest struct {
	Name           string `json:"name"`
	Version        int64  `json:"version"`
	ExpectedUserID string `json:"expectedUserId"`
}

type DeleteTeamReceipt struct {
	TeamID  string `json:"teamId"`
	Deleted bool   `json:"deleted"`
}
