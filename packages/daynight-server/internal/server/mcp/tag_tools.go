package mcp

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	tagservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

//go:embed tag_tools.json
var tagToolsJSON []byte

type tagOperations interface {
	List(context.Context, model.Principal, string, tagservice.ListInput) (tagservice.Page, error)
	Get(context.Context, model.Principal, string, string) (tagservice.Item, error)
	Create(context.Context, model.Principal, string, string) (tagservice.WriteResult, error)
	Rename(context.Context, model.Principal, string, string, int64, string) (tagservice.WriteResult, error)
	Delete(context.Context, model.Principal, string, string, int64, bool) (tagservice.WriteResult, error)
}

type tagInput struct {
	ProjectID string `json:"projectId"`
	TagID     string `json:"tagId"`
	Name      string `json:"name"`
	IfVersion string `json:"ifVersion"`
	Confirm   bool   `json:"confirm"`
	Query     string `json:"query"`
	Limit     int    `json:"limit"`
	Cursor    string `json:"cursor"`
}

type tagUsage struct {
	Tasks int64 `json:"tasks"`
	Goals int64 `json:"goals"`
}

type tagData struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"projectId"`
	Name      string    `json:"name"`
	Version   string    `json:"version"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Usage     tagUsage  `json:"usage"`
}

func mapTag(item tagservice.Item) tagData {
	t := item.Tag
	return tagData{ID: t.ID, ProjectID: t.ProjectID, Name: t.Name, Version: Decimal(t.Version), CreatedAt: t.CreatedAt.UTC(), UpdatedAt: t.UpdatedAt.UTC(), Usage: tagUsage{Tasks: item.Usage.Tasks, Goals: item.Usage.Goals}}
}

// RegisterTagTools exposes the project catalog through the shared MCP wrapper.
func RegisterTagTools(e *Entry, tags tagOperations) error {
	if e == nil || tags == nil {
		return fmt.Errorf("tag tool dependencies are required")
	}
	var tools []*sdk.Tool
	if err := json.Unmarshal(tagToolsJSON, &tools); err != nil {
		return fmt.Errorf("decode tag tools: %w", err)
	}
	for _, tool := range tools {
		name := tool.Name
		handler := func(ctx context.Context, actor RequestActor, in tagInput) (ToolResult, error) {
			return tagTool(ctx, actor, name, in, tags)
		}
		register := RegisterTypedTool[tagInput]
		if name == "tag_list" || name == "tag_show" {
			register = registerTypedReadTool[tagInput]
		}
		if err := register(e, tool, BudgetControl, handler, "projectId", "tagId", "name", "ifVersion", "query", "cursor"); err != nil {
			return fmt.Errorf("register %s: %w", name, err)
		}
	}
	return nil
}

func tagTool(ctx context.Context, actor RequestActor, name string, in tagInput, tags tagOperations) (ToolResult, error) {
	refs := map[string]any{"projectId": in.ProjectID}
	if in.TagID != "" {
		refs["tagId"] = in.TagID
	}
	switch name {
	case "tag_list":
		page, err := tags.List(ctx, actor.Principal, in.ProjectID, tagservice.ListInput{Query: in.Query, Limit: in.Limit, Cursor: in.Cursor})
		if err != nil {
			return ToolResult{Refs: refs}, err
		}
		items := make([]tagData, 0, len(page.Items))
		for _, item := range page.Items {
			items = append(items, mapTag(item))
		}
		return ToolResult{Data: map[string]any{"items": items, "catalogEpoch": page.CatalogEpoch, "nextCursor": page.NextCursor}, Refs: refs}, nil
	case "tag_show":
		item, err := tags.Get(ctx, actor.Principal, in.ProjectID, in.TagID)
		if err != nil {
			return ToolResult{Refs: refs}, err
		}
		return ToolResult{Data: mapTag(item), Refs: refs}, nil
	case "tag_create", "tag_rename", "tag_delete":
		preflight := ToolResult{WriteOutcome: "not_committed", Phase: "prepare", Refs: refs}
		var version int64
		if name != "tag_create" {
			var err error
			version, err = ParseVersion(in.IfVersion)
			if err != nil {
				return preflight, err
			}
		}
		// Enforce the equivalent REST body limit without constraining raw names
		// before the shared service trims and validates them.
		bodySize := len(`{"name":}`) + threadJSONStringSize(in.Name)
		if name == "tag_rename" {
			bodySize += len(`,"version":`) + len(in.IfVersion)
		}
		if name != "tag_delete" && bodySize > httpx.MaxJSONBody {
			return preflight, &model.Fault{Code: "invalid_input", Message: "Request body must be valid JSON within the 1 MiB limit."}
		}
		var result tagservice.WriteResult
		var err error
		switch name {
		case "tag_create":
			result, err = tags.Create(ctx, actor.Principal, in.ProjectID, in.Name)
		case "tag_rename":
			result, err = tags.Rename(ctx, actor.Principal, in.ProjectID, in.TagID, version, in.Name)
		case "tag_delete":
			result, err = tags.Delete(ctx, actor.Principal, in.ProjectID, in.TagID, version, in.Confirm)
		}
		if name == "tag_create" && result.TagID != "" {
			if result.Outcome == store.TransactionCommitted {
				refs["tagId"] = result.TagID
			} else {
				refs["candidateTagId"] = result.TagID
			}
		}
		out := ToolResult{SuccessMetadata: true, Phase: result.Phase, Refs: refs}
		switch result.Outcome {
		case store.TransactionCommitted:
			out.WriteOutcome = "confirmed"
		case store.TransactionNotCommitted:
			out.WriteOutcome = "not_committed"
		case store.TransactionUnknown:
			out.WriteOutcome = "unknown"
		}
		if err != nil {
			if result.Outcome == store.TransactionNotCommitted && !result.CleanupFailed && safeTagNameConflict(err) {
				return out, &model.Fault{Code: "tag_name_conflict", Message: "A tag with this name already exists."}
			}
			return out, err
		}
		if name == "tag_delete" {
			out.Data = map[string]any{"projectId": result.ProjectID, "tagId": result.TagID, "deleted": result.Deleted}
			out.Outcome = "changed"
		} else {
			out.Data = mapTag(result.Item)
			if name == "tag_create" {
				out.Outcome = "changed"
			}
		}
		return out, nil
	default:
		return ToolResult{}, fmt.Errorf("unknown tag tool %q", name)
	}
}

// Only the specific unique-index refusal with reliable rollback may be exposed
// as a name conflict; an unknown completion or a joined failure remains opaque.
func safeTagNameConflict(err error) bool {
	var transactions, databases, markers int
	valid := true
	var visit func(error)
	visit = func(current error) {
		if current == nil {
			return
		}
		if current == store.ErrTagNameConflict {
			markers++
		}
		switch e := current.(type) {
		case *store.TransactionError:
			transactions++
			if e.Phase != "operation" || e.Outcome != store.TransactionNotCommitted || e.CleanupFailed || e.CommitAttempted {
				valid = false
			}
		case *store.ThreadTransactionError:
			valid = false
		case *store.Error:
			databases++
			if !e.DatabaseFailure || e.SQLState != "23505" {
				valid = false
			}
		}
		if joined, ok := current.(interface{ Unwrap() []error }); ok {
			children := joined.Unwrap()
			if len(children) != 2 || children[0] != store.ErrTagNameConflict {
				valid = false
			} else if _, ok := children[1].(*store.Error); !ok {
				valid = false
			}
			for _, child := range children {
				visit(child)
			}
		} else {
			visit(errors.Unwrap(current))
		}
	}
	visit(err)
	// Project transaction completion can wrap the same database failure once
	// more; both wrappers must retain the unique-violation facts.
	return valid && transactions == 1 && (databases == 1 || databases == 2) && markers == 1
}
