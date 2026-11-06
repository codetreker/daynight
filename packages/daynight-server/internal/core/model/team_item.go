package model

import "time"

type TeamItemTarget struct {
	Kind, TeamID, UserID, ProjectID string
}

type TeamItemAuthority struct {
	Principal                 Principal
	Kind, ID, Resource, Scope string
}

type TeamItemField struct {
	Name      string
	IsNull    bool
	SizeBytes int64
}

// TeamItemMetadata contains only fixed-size resource facts. Text fields in the
// resource models are omitted and described by Fields instead.
type TeamItemMetadata struct {
	Team       *Team
	Member     *TeamMember
	Project    *Project
	Fields     []TeamItemField
	ModifiedAt []time.Time
	Revision   string
}
