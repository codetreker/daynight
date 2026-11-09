// Package taskwork owns the bounded work-overview representation shared by
// HTTP and MCP. Ordinary Task representations keep their separate contracts.
package taskwork

import (
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"time"
)

const MaxResponseBytes = 256 << 10

type Page struct {
	Groups     []Group   `json:"groups"`
	NextCursor *string   `json:"nextCursor"`
	ObservedAt time.Time `json:"observedAt"`
	Partial    bool      `json:"partial"`
}
type Group struct {
	GroupID           string      `json:"groupId"`
	Kind              string      `json:"kind"`
	DisplayTaskID     string      `json:"displayTaskId"`
	TitlePreview      string      `json:"titlePreview"`
	TitleTruncated    bool        `json:"titleTruncated"`
	AssignedTo        string      `json:"assignedTo"`
	AggregationScope  string      `json:"aggregationScope"`
	MemberCount       int64       `json:"memberCount"`
	MatchedCount      int64       `json:"matchedCount"`
	InProgressCount   int64       `json:"inProgressCount"`
	RootCount         int64       `json:"rootCount"`
	Roots             []Root      `json:"roots"`
	RootsTruncated    bool        `json:"rootsTruncated"`
	Summary           Aggregation `json:"summary"`
	Targets           []Target    `json:"targets"`
	ContributorCursor *string     `json:"contributorCursor"`
	ObservedAt        time.Time   `json:"observedAt"`
}
type Root struct {
	TaskID         string `json:"taskId"`
	TitlePreview   string `json:"titlePreview"`
	TitleTruncated bool   `json:"titleTruncated"`
}
type Aggregation struct {
	Indicator    *string   `json:"indicator"`
	WorkingCount int64     `json:"workingCount"`
	NoticeCount  int64     `json:"noticeCount"`
	WarningCount int64     `json:"warningCount"`
	UnknownCount int64     `json:"unknownCount"`
	Complete     bool      `json:"complete"`
	ObservedAt   time.Time `json:"observedAt"`
}
type Target struct {
	TaskID          string             `json:"taskId"`
	AssignedTo      *string            `json:"assignedTo"`
	MatchesAssignee bool               `json:"matchesAssignee"`
	SessionID       *string            `json:"sessionId"`
	Indicator       *string            `json:"indicator"`
	Reason          string             `json:"reason"`
	Send            sp.TaskSessionSend `json:"send"`
}
