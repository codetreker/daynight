package model

type TaskAssignee struct {
	UserID           string
	Version          string
	Name             *string
	AvatarURL        *string
	HasProjectAccess bool
}

type TaskAssigneeVersion struct {
	UserID           string
	Version          string
	HasProjectAccess bool
}

type TaskAssignees struct {
	Items             []TaskAssignee
	UnresolvedUserIDs []string
}

// TaskAssigneeFact is an unprojected catalogue row.
type TaskAssigneeFact struct {
	UserID                      string
	ProfileID, Name, AvatarURL  *string
	HasProjectAccess, Qualified bool
}
