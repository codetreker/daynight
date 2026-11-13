package tag

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	project "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/tag"
	protocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/tag"
	"github.com/google/uuid"
)

type database interface {
	store.ProjectWriter
	store.SnapshotReader
}
type Tags struct{ store database }

func New(db database) *Tags { return &Tags{store: db} }

type Item struct {
	Tag   model.Tag
	Usage model.TagUsage
}
type ListInput struct {
	Query  string
	Limit  int
	Cursor string
}
type Page struct {
	Items        []Item
	CatalogEpoch string
	NextCursor   *string
}
type WriteResult struct {
	Item             Item
	ProjectID, TagID string
	Deleted          bool
	Phase            string
	Outcome          store.TransactionOutcome
	CleanupFailed    bool
}

func identity(p model.Principal, projectID string) (model.Principal, string, error) {
	if err := model.RequirePrincipal(p); err != nil {
		return p, "", err
	}
	id, err := model.CanonicalID(projectID)
	if err != nil {
		return p, "", err
	}
	p.UserID, _ = model.CanonicalID(p.UserID)
	p.CredentialID, _ = model.CanonicalID(p.CredentialID)
	return p, id, nil
}
func tagID(id string) (string, error) { return model.CanonicalID(id) }
func readItem(ctx context.Context, dao store.TagReader, projectID, id string) (Item, error) {
	item, err := dao.Tag(ctx, projectID, id)
	if err != nil {
		return Item{}, core.Lookup(err)
	}
	usage, err := dao.TagUsage(ctx, projectID, id)
	if err != nil {
		return Item{}, err
	}
	return Item{Tag: item, Usage: usage}, nil
}
func (s *Tags) Get(ctx context.Context, p model.Principal, projectID, id string) (Item, error) {
	p, projectID, err := identity(p, projectID)
	if err != nil {
		return Item{}, err
	}
	id, err = tagID(id)
	if err != nil {
		return Item{}, err
	}
	var result Item
	err = s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		if _, err := project.RequireProjectRead(ctx, scope.ProjectDAO(), p, projectID); err != nil {
			return err
		}
		result, err = readItem(ctx, scope.TagDAO(), projectID, id)
		return err
	})
	if err != nil {
		return Item{}, err
	}
	return result, nil
}
func (s *Tags) List(ctx context.Context, p model.Principal, projectID string, input ListInput) (Page, error) {
	p, projectID, err := identity(p, projectID)
	if err != nil {
		return Page{}, err
	}
	if input.Limit == 0 {
		input.Limit = 50
	}
	if input.Limit < 1 || input.Limit > 100 || !utf8.ValidString(input.Query) || strings.ContainsRune(input.Query, 0) {
		return Page{}, core.Fault("invalid_input", "Invalid tag list query or limit.", nil)
	}
	query := core.Fold(input.Query)
	var result Page
	err = s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		if _, err := project.RequireProjectRead(ctx, scope.ProjectDAO(), p, projectID); err != nil {
			return err
		}
		dao := scope.TagDAO()
		epoch, err := dao.TagCatalogEpoch(ctx, projectID)
		if err != nil {
			return err
		}
		cursor := core.Cursor{Version: 1, ProjectID: projectID, UserID: p.UserID, CredentialID: p.CredentialID, Kind: p.Kind, Query: query, Limit: input.Limit, Epoch: epoch}
		var after *store.TagPosition
		if input.Cursor != "" {
			after, err = core.DecodeCursor(input.Cursor, cursor)
			if err != nil {
				return err
			}
		}
		page, err := dao.Tags(ctx, projectID, store.TagQuery{NameContains: query, After: after, Limit: input.Limit})
		if err != nil {
			return err
		}
		result = Page{Items: make([]Item, 0, len(page.Items)), CatalogEpoch: epoch}
		for _, item := range page.Items {
			usage, err := dao.TagUsage(ctx, projectID, item.ID)
			if err != nil {
				return err
			}
			result.Items = append(result.Items, Item{Tag: item, Usage: usage})
		}
		if page.HasMore {
			if len(page.Items) == 0 {
				return errors.New("tag page has no continuation position")
			}
			last := page.Items[len(page.Items)-1]
			cursor.NameKey, cursor.ID = last.NameKey, last.ID
			encoded := core.EncodeCursor(cursor)
			result.NextCursor = &encoded
		}
		return nil
	})
	if err != nil {
		return Page{}, err
	}
	return result, nil
}
func (s *Tags) Resolve(ctx context.Context, p model.Principal, projectID string, ids []string) ([]model.TagReference, error) {
	p, projectID, err := identity(p, projectID)
	if err != nil {
		return nil, err
	}
	unique := make(map[string]struct{}, len(ids))
	canonical := make([]string, 0, len(ids))
	for _, id := range ids {
		id, err = tagID(id)
		if err != nil {
			return nil, err
		}
		if _, ok := unique[id]; !ok {
			unique[id] = struct{}{}
			canonical = append(canonical, id)
		}
	}
	var result []model.TagReference
	err = s.store.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		if _, err := project.RequireProjectRead(ctx, scope.ProjectDAO(), p, projectID); err != nil {
			return err
		}
		items, err := scope.TagDAO().ResolveTags(ctx, projectID, canonical)
		if err != nil {
			return err
		}
		if len(items) != len(canonical) {
			return core.Fault("tag_not_found", "One or more tags were not found.", nil)
		}
		result = make([]model.TagReference, 0, len(items))
		for _, item := range items {
			result = append(result, model.TagReference{ID: item.ID, Name: item.Name})
		}
		if _, err := protocol.EncodeResolve(io.Discard, result); err != nil {
			var violation *limit.Violation
			if errors.As(err, &violation) {
				return core.Fault("resource_limit_exceeded", "Tag resolution exceeds the encoded resource limit.", err)
			}
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Tags) Create(ctx context.Context, p model.Principal, projectID, name string) (WriteResult, error) {
	result := WriteResult{Phase: "prepare", Outcome: store.TransactionNotCommitted}
	p, projectID, err := identity(p, projectID)
	if err != nil {
		return result, err
	}
	name, key, err := core.Name(name)
	if err != nil {
		return result, err
	}
	id, err := uuid.NewRandom()
	if err != nil {
		return result, fmt.Errorf("generate tag ID: %w", err)
	}
	return s.write(ctx, p, projectID, "", func(scope store.ProjectWriteScope, result *WriteResult) error {
		observed, err := scope.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		result.Phase = "write"
		item, err := scope.TagDAO().InsertTag(ctx, model.Tag{ID: id.String(), ProjectID: projectID, Name: name, NameKey: key, CreatedAt: observed})
		if err != nil {
			return core.Unique(err)
		}
		if err := scope.ProjectDAO().RotateTagCatalogEpoch(ctx); err != nil {
			return err
		}
		result.Item = Item{Tag: item}
		result.TagID = item.ID
		return nil
	})
}
func (s *Tags) Rename(ctx context.Context, p model.Principal, projectID, id string, version int64, name string) (WriteResult, error) {
	result := WriteResult{Phase: "prepare", Outcome: store.TransactionNotCommitted}
	p, projectID, err := identity(p, projectID)
	if err != nil {
		return result, err
	}
	id, err = tagID(id)
	if err != nil {
		return result, err
	}
	if err = core.Version(version); err != nil {
		return result, err
	}
	name, key, err := core.Name(name)
	if err != nil {
		return result, err
	}
	return s.write(ctx, p, projectID, id, func(scope store.ProjectWriteScope, result *WriteResult) error {
		dao := scope.TagDAO()
		item, err := dao.Tag(ctx, id)
		if err != nil {
			return core.Lookup(err)
		}
		if err = core.CheckVersion(item, version); err != nil {
			return err
		}
		usage, err := dao.TagUsage(ctx, id)
		if err != nil {
			return err
		}
		if item.Name == name {
			result.Item = Item{Tag: item, Usage: usage}
			return nil
		}
		if item.Version == math.MaxInt64 {
			return core.Fault("version_exhausted", "Tag version is exhausted.", nil)
		}
		observed, err := scope.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		result.Phase = "write"
		item, err = dao.UpdateTag(ctx, id, version, name, key, observed)
		if err != nil {
			return core.Unique(core.Lookup(err))
		}
		if _, err = scope.TaskTagDAO().TouchTaggedTasks(ctx, id, observed); err != nil {
			return err
		}
		if err = scope.ProjectDAO().RotateTagCatalogEpoch(ctx); err != nil {
			return err
		}
		result.Item = Item{Tag: item, Usage: usage}
		return nil
	})
}
func (s *Tags) Delete(ctx context.Context, p model.Principal, projectID, id string, version int64, confirm bool) (WriteResult, error) {
	result := WriteResult{Phase: "prepare", Outcome: store.TransactionNotCommitted}
	p, projectID, err := identity(p, projectID)
	if err != nil {
		return result, err
	}
	id, err = tagID(id)
	if err != nil {
		return result, err
	}
	if err = core.Version(version); err != nil {
		return result, err
	}
	if !confirm {
		return result, core.Fault("confirmation_required", "Tag deletion requires confirmation.", nil)
	}
	return s.write(ctx, p, projectID, id, func(scope store.ProjectWriteScope, result *WriteResult) error {
		dao := scope.TagDAO()
		item, err := dao.Tag(ctx, id)
		if err != nil {
			return core.Lookup(err)
		}
		if err = core.CheckVersion(item, version); err != nil {
			return err
		}
		observed, err := scope.TaskDAO().ObservedAt(ctx)
		if err != nil {
			return err
		}
		result.Phase = "write"
		if _, err = scope.TaskTagDAO().TouchTaggedTasks(ctx, id, observed); err != nil {
			return err
		}
		if err = scope.TaskTagDAO().ClearTagAssociations(ctx, id); err != nil {
			return err
		}
		if err = dao.DeleteTag(ctx, id, version); err != nil {
			return core.Lookup(err)
		}
		if err = scope.ProjectDAO().RotateTagCatalogEpoch(ctx); err != nil {
			return err
		}
		result.Deleted = true
		return nil
	})
}
func (s *Tags) write(ctx context.Context, p model.Principal, projectID, id string, op func(store.ProjectWriteScope, *WriteResult) error) (WriteResult, error) {
	result := WriteResult{ProjectID: projectID, TagID: id, Phase: "query", Outcome: store.TransactionNotCommitted}
	locked := false
	completion, err := s.store.WriteProject(ctx, projectID, func(scope store.ProjectWriteScope) error {
		locked = true
		if _, err := project.RequireProjectWrite(ctx, scope.ProjectDAO(), p); err != nil {
			return err
		}
		return op(scope, &result)
	})
	result.Outcome = completion.Outcome
	if err != nil {
		var failure *store.TransactionError
		if errors.As(err, &failure) {
			result.Outcome = failure.Outcome
			result.CleanupFailed = failure.CleanupFailed
			if failure.CommitAttempted {
				result.Phase = "commit"
			}
		}
		if !locked && errors.Is(err, model.ErrNotFound) && failure != nil && failure.Phase == "operation" && failure.Outcome == store.TransactionNotCommitted && !failure.CleanupFailed {
			err = project.ProjectNotFound(err)
		}
		result.Item = Item{}
		result.Deleted = false
		return result, fmt.Errorf("write tag: %w", err)
	}
	if completion.Outcome != store.TransactionCommitted {
		result.Item = Item{}
		result.Deleted = false
		return result, errors.New("tag transaction did not confirm commit")
	}
	result.Phase = "commit"
	return result, nil
}
