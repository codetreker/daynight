package tasksearch

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
)

type Request struct {
	TagFilter          store.TagFilter
	Type               model.TaskType
	Parent             *string
	Query              string
	AssignedTo         *string
	Status             *model.TaskStatus
	Ready, AllowAgents *bool
	CompatiblePlatform *model.TaskPlatform
	Limit              int
	Cursor             *string
}
type Context struct {
	TaskID string `json:"taskId"`
	Title  string `json:"title"`
}
type Match struct {
	Fields             []string `json:"fields"`
	DescriptionSnippet *string  `json:"descriptionSnippet"`
}
type Item struct {
	Tags        []model.TagReference `json:"-"`
	ID          string               `json:"id"`
	Type        model.TaskType       `json:"type"`
	ParentID    *string              `json:"parentId"`
	ProjectID   string               `json:"projectId"`
	Title       string               `json:"title"`
	Status      model.TaskStatus     `json:"status"`
	AssignedTo  *string              `json:"assignedTo"`
	CancelledAt *time.Time           `json:"cancelledAt"`
	UpdatedAt   time.Time            `json:"updatedAt"`
	Context     *Context             `json:"context"`
	Match       Match                `json:"match"`
}
type Page struct {
	ProjectID  string  `json:"projectId"`
	Total      int64   `json:"total"`
	Items      []Item  `json:"items"`
	NextCursor *string `json:"nextCursor"`
	NodeCount  int64   `json:"-"`
}

type cursorScope struct {
	TagFilterIdentity  string                     `json:"tagFilter"`
	Type               model.TaskType             `json:"type"`
	Parent             *string                    `json:"parent"`
	Version            int                        `json:"version"`
	UserID             string                     `json:"userId"`
	ProjectID          string                     `json:"projectId"`
	QueryHash          string                     `json:"queryHash"`
	AssignedTo         model.TaskAssignmentFilter `json:"assignedTo"`
	Status             *model.TaskStatus          `json:"status"`
	Ready              *bool                      `json:"ready"`
	AllowAgents        *bool                      `json:"allowAgents"`
	CompatiblePlatform *model.TaskPlatform        `json:"compatiblePlatform"`
}
type cursor struct {
	Scope    cursorScope              `json:"scope"`
	Fence    store.TaskSearchFence    `json:"fence"`
	Position store.TaskSearchPosition `json:"position"`
}

func invalidCursor() error {
	return &model.Fault{Code: "invalid_input", Message: "Cursor is invalid for this search."}
}
func decodeCursor(encoded string, scope cursorScope) (cursor, error) {
	if len(encoded) > transport.MaxEncodedCursorBytes {
		return cursor{}, invalidCursor()
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return cursor{}, invalidCursor()
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	var value cursor
	if d.Decode(&value) != nil || d.Decode(new(any)) != io.EOF {
		return cursor{}, invalidCursor()
	}
	canonical, err := json.Marshal(value)
	if err != nil || !bytes.Equal(canonical, raw) {
		return cursor{}, invalidCursor()
	}
	expected, _ := json.Marshal(scope)
	actual, _ := json.Marshal(value.Scope)
	id, err := model.CanonicalID(value.Position.ID)
	epoch, epochErr := model.CanonicalID(value.Fence.Epoch)
	if err != nil || id != value.Position.ID || epochErr != nil || epoch != value.Fence.Epoch || value.Position.UpdatedAt.IsZero() || !bytes.Equal(expected, actual) || !decimal(value.Fence.Count) || !decimal(value.Fence.VersionSum) {
		return cursor{}, invalidCursor()
	}
	return value, nil
}

func decimal(value string) bool {
	if value == "" || len(value) > 1 && value[0] == '0' {
		return false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}
func encodeCursor(value cursor) (string, error) {
	b, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func Search(ctx context.Context, reader store.TaskSearchReader, principal model.Principal, projectID string, request Request) (Page, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return Page{}, err
	}
	var err error
	projectID, err = model.CanonicalID(projectID)
	if err != nil {
		return Page{}, err
	}
	userID, _ := model.CanonicalID(principal.UserID)
	if request.Limit < 1 || request.Limit > 100 {
		return Page{}, &model.Fault{Code: "invalid_input", Message: "Limit must be between 1 and 100."}
	}
	if request.Status != nil && !request.Status.Valid() {
		return Page{}, &model.Fault{Code: "invalid_input", Message: "Task status is invalid."}
	}
	if request.CompatiblePlatform != nil && !request.CompatiblePlatform.Valid() {
		return Page{}, &model.Fault{Code: "invalid_input", Message: "Compatible platform must be windows, linux or macos."}
	}
	kind, parent, err := taskcore.ResourceFilter(request.Type, request.Parent)
	if err != nil {
		return Page{}, err
	}
	assignment, err := taskcore.AssignmentFilter(request.AssignedTo, userID)
	if err != nil {
		return Page{}, err
	}
	filter, err := taskcore.NormalizeTagFilter(request.TagFilter)
	if err != nil {
		return Page{}, err
	}
	ast, err := query.Parse(request.Query)
	if err != nil {
		var syntax *query.Error
		if errors.As(err, &syntax) {
			return Page{}, &model.Fault{Code: "invalid_search_expression", Message: "Invalid search expression.", SearchExpression: &model.SearchExpressionDetails{Reason: syntax.Reason, Position: syntax.Position, Length: syntax.Length}}
		}
		return Page{}, err
	}
	hash := sha256.Sum256([]byte(request.Query))
	scope := cursorScope{Version: 4, TagFilterIdentity: taskcore.TagFilterIdentity(filter), Type: kind, Parent: parent, UserID: userID, ProjectID: projectID, QueryHash: hex.EncodeToString(hash[:]), AssignedTo: assignment, Status: request.Status, Ready: request.Ready, AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform}
	var prior *cursor
	if request.Cursor != nil {
		value, err := decodeCursor(*request.Cursor, scope)
		if err != nil {
			return Page{}, err
		}
		prior = &value
	}
	result := Page{ProjectID: projectID, Items: []Item{}}
	err = reader.ReadTaskSearch(ctx, func(snapshot store.TaskSearchSnapshot) error {
		if _, err := project.RequireProjectRead(ctx, snapshot, principal, projectID); err != nil {
			return err
		}
		fence, err := snapshot.Fence(ctx, projectID)
		if err != nil {
			return err
		}
		if prior != nil && prior.Fence != fence {
			return &model.Fault{Code: "search_changed", Message: "Tasks changed during this search."}
		}
		if err := taskcore.RequireTagFilter(ctx, snapshot, projectID, filter); err != nil {
			return err
		}
		selection := store.TaskSearchQuery{TagFilter: filter, Type: request.Type, Parent: parent, Expression: ast, AssignedTo: assignment, Status: request.Status, Ready: request.Ready, AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform, Limit: request.Limit}
		if prior != nil {
			selection.After = &prior.Position
		}
		rows, err := snapshot.Matches(ctx, projectID, selection)
		if err != nil {
			return err
		}
		result.Total = rows.Total
		parents := make([]string, 0, len(rows.Items))
		seen := make(map[string]bool)
		for _, row := range rows.Items {
			if row.Type == model.TaskTypeTask && row.ParentID != nil && !seen[*row.ParentID] {
				parents = append(parents, *row.ParentID)
				seen[*row.ParentID] = true
			}
		}
		contexts := make(map[string]*Context, len(rows.Items))
		if len(parents) > 0 {
			titles, err := snapshot.Titles(ctx, projectID, parents)
			if err != nil {
				return err
			}
			for _, row := range rows.Items {
				if row.Type == model.TaskTypeTask && row.ParentID != nil {
					title, ok := titles[*row.ParentID]
					if !ok {
						return fmt.Errorf("task %s has invalid parent %s", row.ID, *row.ParentID)
					}
					contexts[row.ID] = &Context{TaskID: *row.ParentID, Title: title}
				}
			}
		}
		for _, row := range rows.Items {
			if err := ctx.Err(); err != nil {
				return err
			}
			evidence, err := query.EvaluateContext(ctx, ast, query.Text{ID: row.ID, Title: row.Title, Description: row.Description})
			if err != nil {
				return err
			}
			fields := []string{}
			if evidence.ID {
				fields = append(fields, "id")
			}
			if evidence.Title {
				fields = append(fields, "title")
			}
			if evidence.Description {
				fields = append(fields, "description")
			}
			snippet, err := query.SnippetContext(ctx, row.Description, evidence)
			if err != nil {
				return err
			}
			result.Items = append(result.Items, Item{ID: row.ID, Type: row.Type, ParentID: row.ParentID, ProjectID: projectID, Title: row.Title, Status: row.Status, AssignedTo: row.AssignedTo, CancelledAt: row.CancelledAt, UpdatedAt: row.UpdatedAt.UTC(), Tags: row.Tags, Context: contexts[row.ID], Match: Match{Fields: fields, DescriptionSnippet: snippet}})
		}
		if rows.HasMore {
			if len(rows.Items) == 0 {
				return fmt.Errorf("search page has no continuation position")
			}
			last := rows.Items[len(rows.Items)-1]
			encoded, err := encodeCursor(cursor{Scope: scope, Fence: fence, Position: store.TaskSearchPosition{ExactIDPriority: last.ExactIDPriority, TitlePriority: last.TitlePriority, UpdatedAt: last.UpdatedAt, ID: last.ID}})
			if err != nil {
				return err
			}
			result.NextCursor = &encoded
		}
		return ctx.Err()
	})
	if err != nil {
		return Page{}, err
	}
	if err = ctx.Err(); err != nil {
		return Page{}, err
	}
	return result, nil
}
