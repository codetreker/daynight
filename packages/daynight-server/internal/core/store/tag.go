package store

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// ErrTagWriteConflict means a conditional tag write matched no row.
var ErrTagWriteConflict = errors.New("tag write condition not met")

// ErrTagNameConflict identifies a collision on the project-local name key.
var ErrTagNameConflict = errors.New("tag name already exists")

type TagPosition struct {
	NameKey string
	ID      string
}

type TagQuery struct {
	// NameContains is an already-normalized literal substring of NameKey.
	NameContains string
	After        *TagPosition
	Limit        int
}

type TagPage struct {
	Items   []model.Tag
	HasMore bool
}

// TagReader is bound to the calling snapshot.
type TagReader interface {
	TagCatalogEpoch(context.Context, string) (string, error)
	Tags(context.Context, string, TagQuery) (TagPage, error)
	Tag(context.Context, string, string) (model.Tag, error)
	TagUsage(context.Context, string, string) (model.TagUsage, error)
	ResolveTags(context.Context, string, []string) ([]model.Tag, error)
}

// TagWriteDAO is bound to the Project write transaction and its locked Project.
type TagWriteDAO interface {
	Tag(context.Context, string) (model.Tag, error)
	TagUsage(context.Context, string) (model.TagUsage, error)
	ResolveTags(context.Context, []string) ([]model.Tag, error)
	InsertTag(context.Context, model.Tag) (model.Tag, error)
	UpdateTag(context.Context, string, int64, string, string, time.Time) (model.Tag, error)
	DeleteTag(context.Context, string, int64) error
}

// TaskTagWriteDAO operates on associations in the Project write transaction.
type TaskTagWriteDAO interface {
	TaskTags(context.Context, string) ([]model.TagReference, error)
	ReplaceTaskTags(context.Context, string, []string) error
	TouchTaggedTasks(context.Context, string, time.Time) (int64, error)
	ClearTagAssociations(context.Context, string) error
}
