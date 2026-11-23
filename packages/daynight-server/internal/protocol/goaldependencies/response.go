package goaldependencies

import (
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
)

type Target struct {
	ProjectID   string           `json:"projectId"`
	ProjectName string           `json:"projectName"`
	GoalID      string           `json:"goalId"`
	Title       string           `json:"title"`
	Status      model.TaskStatus `json:"status"`
	Kind        string           `json:"kind"`
}

type Prerequisite struct {
	EdgeID *string `json:"edgeId,omitempty"`
	Target *Target `json:"target"`
}

type Relationships struct {
	GoalID            string         `json:"goalId"`
	CanEdit           bool           `json:"canEdit"`
	Revision          *string        `json:"revision,omitempty"`
	CompletionBlocked bool           `json:"completionBlocked"`
	Prerequisites     []Prerequisite `json:"prerequisites"`
	Successors        []Target       `json:"successors"`
	NextCursor        *string        `json:"nextCursor"`
}

type Receipt struct {
	GoalID   string `json:"goalId"`
	Revision string `json:"revision"`
	Changed  bool   `json:"changed"`
}

func target(value taskcore.GoalDependencyTarget) Target {
	return Target{ProjectID: value.ProjectID, ProjectName: value.ProjectName, GoalID: value.GoalID, Title: value.Title, Status: value.Status, Kind: value.Kind}
}

func MapRelationships(value taskcore.GoalDependencies) Relationships {
	result := Relationships{GoalID: value.GoalID, CanEdit: value.CanEdit, CompletionBlocked: value.CompletionBlocked, Prerequisites: make([]Prerequisite, 0, len(value.Prerequisites)), Successors: make([]Target, 0, len(value.Successors)), NextCursor: value.NextCursor}
	if value.CanEdit && value.Revision != nil {
		revision := strconv.FormatInt(*value.Revision, 10)
		result.Revision = &revision
	}
	for _, entry := range value.Prerequisites {
		item := Prerequisite{}
		if value.CanEdit {
			item.EdgeID = entry.EdgeID
		}
		if entry.Target != nil {
			visible := target(*entry.Target)
			item.Target = &visible
		}
		result.Prerequisites = append(result.Prerequisites, item)
	}
	for _, entry := range value.Successors {
		result.Successors = append(result.Successors, target(entry))
	}
	return result
}

func MapReceipt(value taskcore.GoalDependencyReceipt) Receipt {
	return Receipt{GoalID: value.GoalID, Revision: strconv.FormatInt(value.Revision, 10), Changed: value.Changed}
}
