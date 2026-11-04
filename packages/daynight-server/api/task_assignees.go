package api

type TaskAssignee struct {
	UserID           string  `json:"userId"`
	Version          string  `json:"version"`
	Name             *string `json:"name"`
	AvatarURL        *string `json:"avatarUrl"`
	HasProjectAccess bool    `json:"hasProjectAccess"`
}

type TaskAssigneeVersion struct {
	UserID           string `json:"userId"`
	Version          string `json:"version"`
	HasProjectAccess bool   `json:"hasProjectAccess"`
}

type TaskAssignees struct {
	Items             []TaskAssignee `json:"items"`
	UnresolvedUserIDs []string       `json:"unresolvedUserIds"`
}
