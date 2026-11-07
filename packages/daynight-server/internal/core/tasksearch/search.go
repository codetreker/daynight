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

const MaxNodes int64 = 20000
const MaxEdges int64 = 100000

type Request struct {
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
	ID          string           `json:"id"`
	ProjectID   string           `json:"projectId"`
	Title       string           `json:"title"`
	Status      model.TaskStatus `json:"status"`
	AssignedTo  *string          `json:"assignedTo"`
	CancelledAt *time.Time       `json:"cancelledAt"`
	UpdatedAt   time.Time        `json:"updatedAt"`
	Context     *Context         `json:"context"`
	Match       Match            `json:"match"`
}
type Page struct {
	ProjectID  string  `json:"projectId"`
	Total      int64   `json:"total"`
	Items      []Item  `json:"items"`
	NextCursor *string `json:"nextCursor"`
	NodeCount  int64   `json:"-"`
}

type cursorScope struct {
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
	assignment, err := taskcore.AssignmentFilter(request.AssignedTo, userID)
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
	scope := cursorScope{Version: 1, UserID: userID, ProjectID: projectID, QueryHash: hex.EncodeToString(hash[:]), AssignedTo: assignment, Status: request.Status, Ready: request.Ready, AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform}
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
		selection := store.TaskSearchQuery{Expression: ast, AssignedTo: assignment, Status: request.Status, Ready: request.Ready, AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform, Limit: request.Limit}
		if prior != nil {
			selection.After = &prior.Position
		}
		rows, err := snapshot.Matches(ctx, projectID, selection)
		if err != nil {
			return err
		}
		result.Total = rows.Total
		ids := make([]string, 0, len(rows.Items))
		for _, row := range rows.Items {
			ids = append(ids, row.ID)
		}
		contexts := map[string]*Context{}
		if len(ids) > 0 {
			size, err := snapshot.ContextSize(ctx, projectID, ids)
			if err != nil {
				return err
			}
			result.NodeCount = size.NodeCount
			if size.NodeCount > MaxNodes || size.EdgeCount > MaxEdges {
				return &model.Fault{Code: "search_context_limit_exceeded", Message: "Search task context exceeds its limit.", GraphLimit: &model.GraphLimitDetails{NodeCount: size.NodeCount, EdgeCount: size.EdgeCount, MaxNodes: MaxNodes, MaxEdges: MaxEdges}}
			}
			graph, err := snapshot.ContextGraph(ctx, projectID, ids)
			if err != nil {
				return err
			}
			representatives, err := componentRepresentatives(ctx, graph, ids)
			if err != nil {
				return err
			}
			wanted := make([]string, 0, len(representatives))
			seen := map[string]bool{}
			for _, id := range representatives {
				if id != "" && !seen[id] {
					seen[id] = true
					wanted = append(wanted, id)
				}
			}
			titles, err := snapshot.Titles(ctx, projectID, wanted)
			if err != nil {
				return err
			}
			for id, representative := range representatives {
				if representative != "" {
					title, ok := titles[representative]
					if !ok {
						return fmt.Errorf("missing search context title")
					}
					contexts[id] = &Context{TaskID: representative, Title: title}
				}
			}
		}
		for _, row := range rows.Items {
			if err := ctx.Err(); err != nil {
				return err
			}
			evidence, err := query.EvaluateContext(ctx, ast, row.Title, row.Description)
			if err != nil {
				return err
			}
			if !evidence.Matches || evidence.Title != row.TitlePriority {
				return fmt.Errorf("search evidence differs from database result")
			}
			fields := []string{}
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
			result.Items = append(result.Items, Item{ID: row.ID, ProjectID: projectID, Title: row.Title, Status: row.Status, AssignedTo: row.AssignedTo, CancelledAt: row.CancelledAt, UpdatedAt: row.UpdatedAt.UTC(), Context: contexts[row.ID], Match: Match{Fields: fields, DescriptionSnippet: snippet}})
		}
		if rows.HasMore {
			if len(rows.Items) == 0 {
				return fmt.Errorf("search page has no continuation position")
			}
			last := rows.Items[len(rows.Items)-1]
			encoded, err := encodeCursor(cursor{Scope: scope, Fence: fence, Position: store.TaskSearchPosition{TitlePriority: last.TitlePriority, UpdatedAt: last.UpdatedAt, ID: last.ID}})
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
