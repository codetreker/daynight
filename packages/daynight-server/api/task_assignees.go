package api

type TaskAssignee struct {
	UserID           string  `json:"userId"`
	Name             *string `json:"name"`
	AvatarURL        *string `json:"avatarUrl"`
	HasProjectAccess bool    `json:"hasProjectAccess"`
}

type TaskAssignees struct {
	Items             []TaskAssignee `json:"items"`
	UnresolvedUserIDs []string       `json:"unresolvedUserIds"`
}
