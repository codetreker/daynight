package core

type TaskAssignee struct {
	UserID           string
	Name             *string
	AvatarURL        *string
	HasProjectAccess bool
}

type TaskAssignees struct {
	Items             []TaskAssignee
	UnresolvedUserIDs []string
}
