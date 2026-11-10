package prompt

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/prompt"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type database interface {
	store.PromptSnapshotReader
	store.PromptWriter
}
type versionDecision func(model.PromptResource, int64, string) (int64, bool, error)
type Prompts struct {
	store         database
	decideVersion versionDecision
}

func New(db database) *Prompts { return &Prompts{store: db, decideVersion: core.Next} }
func invalid() error           { return &model.Fault{Code: "invalid_input", Message: "Prompt input is invalid."} }
func notFound(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return &model.Fault{Code: "not_found", Message: "Prompt resource was not found.", Cause: err}
	}
	return err
}
func normalize(principal model.Principal, scope model.PromptScope, id string) (string, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return "", err
	}
	if scope != model.PromptScopeUser && scope != model.PromptScopeProject && scope != model.PromptScopeWorker {
		return "", invalid()
	}
	canonical, err := model.CanonicalID(id)
	if err != nil {
		return "", err
	}
	if scope == model.PromptScopeUser && canonical != principal.UserID {
		return "", invalid()
	}
	return canonical, nil
}
func read(ctx context.Context, dao store.PromptReader, user string, scope model.PromptScope, id string) (model.PromptResource, error) {
	m, err := dao.PromptMetadata(ctx, user, scope, id)
	if err != nil {
		return model.PromptResource{}, err
	}
	value := model.PromptResource{Scope: scope, ScopeID: id, Revision: strconv.FormatInt(m.Revision, 10), UpdatedAt: m.UpdatedAt}
	if m.Revision != 0 {
		value.Text, err = dao.PromptText(ctx, user, scope, id)
		if err == nil {
			err = storedTextError(value.Text)
		}
	}
	return value, err
}
func authorizeRead(ctx context.Context, snapshot store.PromptSnapshot, principal model.Principal, scope model.PromptScope, id string) error {
	switch scope {
	case model.PromptScopeProject:
		_, err := snapshot.ProjectAccess(ctx, principal, id)
		return notFound(err)
	case model.PromptScopeWorker:
		return notFound(snapshot.PromptWorkerExists(ctx, principal.UserID, id))
	default:
		return nil
	}
}
func (p *Prompts) Get(ctx context.Context, principal model.Principal, scope model.PromptScope, id string) (model.PromptResource, error) {
	id, err := normalize(principal, scope, id)
	if err != nil {
		return model.PromptResource{}, err
	}
	var value model.PromptResource
	err = p.store.ReadPromptSnapshot(ctx, func(snapshot store.PromptSnapshot) error {
		if err := authorizeRead(ctx, snapshot, principal, scope, id); err != nil {
			return err
		}
		var err error
		value, err = read(ctx, snapshot, principal.UserID, scope, id)
		return err
	})
	return value, err
}
func (p *Prompts) Put(ctx context.Context, principal model.Principal, scope model.PromptScope, id, expectedUserID, revision, text string) (model.PromptResource, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return model.PromptResource{}, err
	}
	user, err := model.CanonicalID(expectedUserID)
	if err != nil || user != expectedUserID {
		return model.PromptResource{}, invalid()
	}
	if user != principal.UserID {
		return model.PromptResource{}, &model.Fault{Code: "identity_mismatch", Message: "The prompt belongs to another user."}
	}
	id, err = normalize(principal, scope, id)
	if err != nil {
		return model.PromptResource{}, err
	}
	expected, err := core.Revision(revision)
	if err != nil {
		return model.PromptResource{}, err
	}
	if err = core.ValidateText(text); err != nil {
		return model.PromptResource{}, err
	}
	var result model.PromptResource
	completion, err := p.store.WritePrompt(ctx, func(tx store.PromptWriteScope) error {
		switch scope {
		case model.PromptScopeProject:
			if err := tx.LockPromptProject(ctx, principal, id); err != nil {
				return notFound(err)
			}
		case model.PromptScopeWorker:
			if err := tx.PromptWorkerExists(ctx, principal.UserID, id); err != nil {
				return notFound(err)
			}
		}
		current, err := tx.PromptResource(ctx, principal.UserID, scope, id)
		if err != nil {
			return err
		}
		if err := storedTextError(current.Text); err != nil {
			return err
		}
		next, changed, err := p.decideVersion(current, expected, text)
		if err != nil {
			return err
		}
		if !changed {
			result = current
			return nil
		}
		if expected == 0 {
			result, err = tx.CreatePrompt(ctx, principal.UserID, scope, id, text)
		} else {
			result, err = tx.UpdatePrompt(ctx, principal.UserID, scope, id, next, expected, text)
		}
		return err
	})
	if err != nil {
		var tx *store.TransactionError
		var fault *model.Fault
		if errors.As(err, &tx) && tx.Phase == "operation" && !tx.CleanupFailed && tx.Outcome == store.TransactionNotCommitted && errors.As(err, &fault) {
			return model.PromptResource{}, fault
		}
		return model.PromptResource{}, fmt.Errorf("save prompt: %w", err)
	}
	if completion.Outcome != store.TransactionCommitted {
		return model.PromptResource{}, fmt.Errorf("save prompt: transaction did not confirm commit")
	}
	return result, nil
}

// Batch obtains all selected resources in one repeatable, read-only snapshot.
func (p *Prompts) Batch(ctx context.Context, principal model.Principal, workerID string, selectors []model.PromptSelector) ([]model.PromptResult, error) {
	return Batch(ctx, p.store, principal, workerID, selectors)
}

func Batch(ctx context.Context, reader store.PromptSnapshotReader, principal model.Principal, workerID string, selectors []model.PromptSelector) ([]model.PromptResult, error) {
	if err := model.RequirePrincipal(principal); err != nil {
		return nil, err
	}
	workerID, err := model.CanonicalID(workerID)
	if err != nil {
		return nil, err
	}
	if len(selectors) > 3 {
		return nil, invalid()
	}
	seen := map[model.PromptKey]bool{}
	for _, selector := range selectors {
		key := selector.Key
		if key.Scope == model.PromptScopeProject {
			id, err := model.CanonicalID(key.ProjectID)
			if err != nil || id != key.ProjectID {
				return nil, invalid()
			}
		} else if (key.Scope != model.PromptScopeUser && key.Scope != model.PromptScopeWorker) || key.ProjectID != "" {
			return nil, invalid()
		}
		if seen[key] {
			return nil, invalid()
		}
		seen[key] = true
		if selector.KnownRevision != nil {
			if _, err := core.Revision(*selector.KnownRevision); err != nil {
				return nil, err
			}
		}
	}
	results := make([]model.PromptResult, 0, len(selectors))
	err = reader.ReadPromptSnapshot(ctx, func(snapshot store.PromptSnapshot) error {
		for _, selector := range selectors {
			key := selector.Key
			id := principal.UserID
			if key.Scope == model.PromptScopeProject {
				id = key.ProjectID
			}
			if key.Scope == model.PromptScopeWorker {
				id = workerID
			}
			if err := authorizeRead(ctx, snapshot, principal, key.Scope, id); err != nil {
				var f *model.Fault
				if errors.As(err, &f) && f.Code == "not_found" {
					results = append(results, model.PromptResult{Key: key, Status: "unavailable"})
					continue
				}
				return err
			}
			m, err := snapshot.PromptMetadata(ctx, principal.UserID, key.Scope, id)
			if err != nil {
				return err
			}
			revision := strconv.FormatInt(m.Revision, 10)
			if selector.KnownRevision != nil && *selector.KnownRevision == revision {
				results = append(results, model.PromptResult{Key: key, Status: "unchanged", Revision: revision})
				continue
			}
			value := model.PromptResource{Scope: key.Scope, ScopeID: id, Revision: revision, UpdatedAt: m.UpdatedAt}
			if m.Revision != 0 {
				value.Text, err = snapshot.PromptText(ctx, principal.UserID, key.Scope, id)
				if err != nil {
					return err
				}
				if err := storedTextError(value.Text); err != nil {
					return err
				}
			}
			results = append(results, model.PromptResult{Key: key, Status: "value", Value: &value})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return results, nil
}

// Stored values must satisfy the same text contract as new writes. A corrupt
// stored value is an internal failure, not a refusal of the caller's input.
func storedTextError(text string) error {
	if core.ValidateText(text) != nil {
		return fmt.Errorf("stored prompt text is invalid")
	}
	return nil
}
