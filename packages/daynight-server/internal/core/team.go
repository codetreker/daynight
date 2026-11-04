package core

import "time"

type TeamMember struct {
	TeamID    string
	UserID    string
	Role      ProjectRole
	Version   int64
	CreatedAt time.Time
	UpdatedAt time.Time
}

type Team struct {
	TeamRef
	Version    int64
	CreatedAt  time.Time
	UpdatedAt  time.Time
	Membership TeamMember
}
