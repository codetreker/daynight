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
	searchmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
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
	scope := cursorScope{Version: 2, UserID: userID, ProjectID: projectID, QueryHash: hex.EncodeToString(hash[:]), AssignedTo: assignment, Status: request.Status, Ready: request.Ready, AllowAgents: request.AllowAgents, CompatiblePlatform: request.CompatiblePlatform}
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
		var draft []Item
		var positions []store.TaskSearchPosition
		itemBytes := 0
		total, hasMore, err := snapshot.MatchesEach(ctx, projectID, selection, func(total int64, row store.TaskSearchRow) (bool, error) {
			if row.TitleOversized {
				if len(draft) == 0 {
					return false, &model.Fault{Code: "resource_limit_exceeded", Message: "Search item exceeds the page budget."}
				}
				return false, nil
			}
			var evidence query.Evidence
			var snippet *string
			var err error
			if row.Hits != nil {
				hits := make(map[searchmodel.Atom]query.Hit, len(row.Hits))
				for _, hit := range row.Hits {
					if _, exists := hits[hit.Atom]; exists {
						return false, fmt.Errorf("duplicate search evidence atom")
					}
					hits[hit.Atom] = query.Hit{ID: hit.ID, Title: hit.Title, Description: hit.Description}
				}
				evidence, err = query.EvaluateHits(ctx, ast, row.ID, hits)
				if err == nil && len(evidence.DescriptionTerms) != 0 {
					for _, hit := range row.Hits {
						if hit.Description && hit.Atom.Term == evidence.DescriptionTerms[0] {
							snippet = hit.Snippet
							break
						}
					}
					if snippet == nil {
						return false, fmt.Errorf("missing search description snippet")
					}
				}
			} else {
				evidence, err = query.EvaluateContext(ctx, ast, query.Text{ID: row.ID, Title: row.Title, Description: row.Description})
				if err == nil {
					snippet, err = query.SnippetContext(ctx, row.Description, evidence)
				}
			}
			if err != nil {
				return false, err
			}
			if !evidence.Matches || evidence.Title != row.TitlePriority || evidence.ExactID != row.ExactIDPriority {
				return false, fmt.Errorf("search evidence differs from database result")
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
			item := Item{ID: row.ID, ProjectID: projectID, Title: row.Title, Status: row.Status, AssignedTo: row.AssignedTo, CancelledAt: row.CancelledAt, UpdatedAt: row.UpdatedAt.UTC(), Match: Match{Fields: fields, DescriptionSnippet: snippet}}
			encoded, err := json.Marshal(item)
			if err != nil {
				return false, err
			}
			empty, err := json.Marshal(Page{ProjectID: projectID, Total: total, Items: []Item{}})
			if err != nil {
				return false, err
			}
			candidateBytes := itemBytes + len(encoded)
			if len(draft) > 0 {
				candidateBytes++
			}
			if len(empty)+candidateBytes+1 > MaxPageResponseJSONBytes {
				if len(draft) == 0 {
					return false, &model.Fault{Code: "resource_limit_exceeded", Message: "Search item exceeds the page budget."}
				}
				return false, nil
			}
			itemBytes = candidateBytes
			draft = append(draft, item)
			positions = append(positions, store.TaskSearchPosition{ExactIDPriority: row.ExactIDPriority, TitlePriority: row.TitlePriority, UpdatedAt: row.UpdatedAt, ID: row.ID})
			return true, nil
		})
		if err != nil {
			return err
		}
		result.Total = total
		if hasMore && len(draft) == 0 {
			return fmt.Errorf("search page has no continuation position")
		}
		// A byte-limited page must not fail because an excluded later item's
		// component exceeds the graph limit. Admit components one candidate at
		// a time and cache their members in this repeatable-read snapshot.
		representatives := map[string]string{}
		titles := map[string]string{}
		var nodeCount, edgeCount int64
		for i, item := range draft {
			if err := ctx.Err(); err != nil {
				return err
			}
			representative, known := representatives[item.ID]
			if !known {
				size, err := snapshot.ContextSize(ctx, projectID, []string{item.ID})
				if err != nil {
					return err
				}
				if nodeCount+size.NodeCount > MaxNodes || edgeCount+size.EdgeCount > MaxEdges {
					if len(result.Items) > 0 {
						rep, valid, err := snapshot.ContextRepresentative(ctx, projectID, item.ID)
						if err != nil {
							return err
						}
						if valid {
							candidate := item
							oversized := false
							if rep != "" {
								found, err := snapshot.Titles(ctx, projectID, []string{rep})
								if err != nil {
									return err
								}
								title, ok := found[rep]
								if !ok {
									return fmt.Errorf("missing search context title")
								}
								if title == "\x00" {
									oversized = true
								} else {
									candidate.Context = &Context{TaskID: rep, Title: title}
								}
							}
							if !oversized {
								prospective := result
								prospective.Items = append(append([]Item(nil), result.Items...), candidate)
								prospective.NextCursor = nil
								if i < len(draft)-1 || hasMore {
									next, err := encodeCursor(cursor{Scope: scope, Fence: fence, Position: positions[i]})
									if err != nil {
										return err
									}
									prospective.NextCursor = &next
								}
								raw, err := json.Marshal(prospective)
								if err != nil {
									return err
								}
								oversized = len(raw)+1 > MaxPageResponseJSONBytes
							}
							if oversized {
								break
							}
						}
					}
					return &model.Fault{Code: "search_context_limit_exceeded", Message: "Search task context exceeds its limit.", GraphLimit: &model.GraphLimitDetails{NodeCount: nodeCount + size.NodeCount, EdgeCount: edgeCount + size.EdgeCount, MaxNodes: MaxNodes, MaxEdges: MaxEdges}}
				}
				graph, err := snapshot.ContextGraph(ctx, projectID, []string{item.ID})
				if err != nil {
					return err
				}
				seeds := make([]string, 0, len(graph.Nodes))
				for _, node := range graph.Nodes {
					seeds = append(seeds, node.ID)
				}
				projected, err := componentRepresentatives(ctx, graph, seeds)
				if err != nil {
					return err
				}
				representative, known = projected[item.ID]
				if !known {
					return fmt.Errorf("search context missing matching task")
				}
				for id, rep := range projected {
					representatives[id] = rep
				}
				nodeCount += size.NodeCount
				edgeCount += size.EdgeCount
			}
			if representative != "" {
				title, ok := titles[representative]
				if !ok {
					found, err := snapshot.Titles(ctx, projectID, []string{representative})
					if err != nil {
						return err
					}
					title, ok = found[representative]
					if !ok {
						return fmt.Errorf("missing search context title")
					}
				}
				if title == "\x00" {
					if len(result.Items) == 0 {
						return &model.Fault{Code: "resource_limit_exceeded", Message: "Search item exceeds the page budget."}
					}
					break
				}
				item.Context = &Context{TaskID: representative, Title: title}
			}
			result.Items = append(result.Items, item)
			result.NextCursor = nil
			if i < len(draft)-1 || hasMore {
				encoded, err := encodeCursor(cursor{Scope: scope, Fence: fence, Position: positions[i]})
				if err != nil {
					return err
				}
				result.NextCursor = &encoded
			}
			encoded, err := json.Marshal(result)
			if err != nil {
				return err
			}
			if len(encoded)+1 > MaxPageResponseJSONBytes {
				result.Items = result.Items[:len(result.Items)-1]
				if len(result.Items) == 0 {
					return &model.Fault{Code: "resource_limit_exceeded", Message: "Search item exceeds the page budget."}
				}
				previous, err := encodeCursor(cursor{Scope: scope, Fence: fence, Position: positions[i-1]})
				if err != nil {
					return err
				}
				result.NextCursor = &previous
				break
			}
			result.NodeCount = nodeCount
			if item.Context != nil {
				titles[item.Context.TaskID] = item.Context.Title
			}
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
