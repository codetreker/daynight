package projection

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"slices"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

const (
	MaxGraphNodes          = 1000
	MaxGraphEdges          = 5000
	TitlePreviewCharacters = 160
	MaxAssigneeResolution  = 100
)

func GraphRoot(found, deleted bool) *model.Fault {
	if !found {
		return &model.Fault{Code: "not_found", Message: "Task was not found.", Cause: model.ErrNotFound}
	}
	if deleted {
		return &model.Fault{Code: "task_deleted", Message: "Task was deleted.", Cause: model.ErrTaskDeleted}
	}
	return nil
}

func GraphLimit(nodeCount, edgeCount int64) *model.Fault {
	if nodeCount <= MaxGraphNodes && edgeCount <= MaxGraphEdges {
		return nil
	}
	return &model.Fault{Code: "graph_limit_exceeded", Message: "Task graph exceeds the supported size.", GraphLimit: &model.GraphLimitDetails{NodeCount: nodeCount, EdgeCount: edgeCount, MaxNodes: MaxGraphNodes, MaxEdges: MaxGraphEdges}}
}

func SummarizeGraph(tasks []model.GraphTask) model.TaskGraphSummary {
	summary := model.TaskGraphSummary{Total: int64(len(tasks))}
	for _, task := range tasks {
		switch task.Status {
		case model.TaskTodo:
			summary.Todo++
			if task.Ready {
				summary.Ready++
			} else {
				summary.Blocked++
			}
		case model.TaskInProgress:
			summary.InProgress++
		case model.TaskDone:
			summary.Done++
		case model.TaskCancelled:
			summary.Cancelled++
		}
	}
	return summary
}

func ValidateSync(epoch string, since *time.Time) error {
	if epoch != "" {
		canonical, err := model.CanonicalID(epoch)
		if err != nil || canonical != epoch {
			return invalid("Epoch must be a canonical UUID.")
		}
	} else if since != nil {
		return invalid("Since requires an epoch.")
	}
	return nil
}

func SyncWindow(requested, current string, since *time.Time, overlap time.Duration) (string, *time.Time) {
	if requested != current {
		return "snapshot", nil
	}
	if since == nil {
		return "delta", nil
	}
	boundary := since.Add(-overlap)
	return "delta", &boundary
}

func AssigneeUserIDs(userIDs []string) ([]string, error) {
	if userIDs == nil {
		return nil, nil
	}
	if len(userIDs) < 1 || len(userIDs) > MaxAssigneeResolution {
		return nil, invalid("Task assignee resolution requires between 1 and 100 user IDs.")
	}
	canonical := make([]string, len(userIDs))
	for index, userID := range userIDs {
		value, err := model.CanonicalID(userID)
		if err != nil {
			return nil, err
		}
		canonical[index] = value
	}
	slices.Sort(canonical)
	for index := 1; index < len(canonical); index++ {
		if canonical[index] == canonical[index-1] {
			return nil, invalid("Task assignee user IDs must not repeat.")
		}
	}
	return canonical, nil
}

func invalid(message string) error { return &model.Fault{Code: "invalid_input", Message: message} }

func AssigneeProfile(fact model.TaskAssigneeFact) (model.TaskAssignee, error) {
	if fact.ProfileID == nil || *fact.ProfileID != fact.UserID {
		return model.TaskAssignee{}, fmt.Errorf("task assignee profile is missing or inconsistent")
	}
	return model.TaskAssignee{UserID: fact.UserID, Version: AssigneeContentVersion(fact.UserID, fact.Name, fact.AvatarURL), Name: fact.Name, AvatarURL: fact.AvatarURL, HasProjectAccess: fact.HasProjectAccess}, nil
}

func AssigneeContentVersion(userID string, name, avatarURL *string) string {
	values := []*string{&userID, name, avatarURL}
	size := len(values) * 9
	for _, value := range values {
		if value != nil {
			size += len(*value)
		}
	}
	content := make([]byte, 0, size)
	for _, value := range values {
		if value == nil {
			content = append(content, 0)
		} else {
			content = append(content, 1)
			content = binary.BigEndian.AppendUint64(content, uint64(len(*value)))
			content = append(content, *value...)
		}
	}
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}

func Catalogue(facts []model.TaskAssigneeFact) (model.TaskAssignees, error) {
	result := model.TaskAssignees{Items: []model.TaskAssignee{}, UnresolvedUserIDs: []string{}}
	for _, fact := range facts {
		person, err := AssigneeProfile(fact)
		if err != nil {
			return model.TaskAssignees{}, err
		}
		result.Items = append(result.Items, person)
	}
	return result, nil
}

func ResolveAssignees(userIDs []string, facts []model.TaskAssigneeFact) (model.TaskAssignees, error) {
	result := model.TaskAssignees{Items: []model.TaskAssignee{}, UnresolvedUserIDs: []string{}}
	expected := make(map[string]bool, len(userIDs))
	for _, id := range userIDs {
		expected[id] = false
	}
	for _, fact := range facts {
		seen, exists := expected[fact.UserID]
		if !exists || seen {
			return model.TaskAssignees{}, fmt.Errorf("task assignee resolution contains an unexpected or duplicate user")
		}
		expected[fact.UserID] = true
		if !fact.Qualified {
			if fact.HasProjectAccess || fact.ProfileID != nil || fact.Name != nil || fact.AvatarURL != nil {
				return model.TaskAssignees{}, fmt.Errorf("task assignee resolution contains an unqualified profile")
			}
			result.UnresolvedUserIDs = append(result.UnresolvedUserIDs, fact.UserID)
			continue
		}
		person, err := AssigneeProfile(fact)
		if err != nil {
			return model.TaskAssignees{}, err
		}
		result.Items = append(result.Items, person)
	}
	for _, seen := range expected {
		if !seen {
			return model.TaskAssignees{}, fmt.Errorf("task assignee resolution is incomplete")
		}
	}
	return result, nil
}

func AssigneeVersions(people []model.TaskAssignee) []model.TaskAssigneeVersion {
	result := make([]model.TaskAssigneeVersion, 0, len(people))
	for _, person := range people {
		result = append(result, model.TaskAssigneeVersion{UserID: person.UserID, Version: person.Version, HasProjectAccess: person.HasProjectAccess})
	}
	return result
}
