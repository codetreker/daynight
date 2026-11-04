package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type Bots struct{ store *store.Store }

func NewBots(database *store.Store) *Bots { return &Bots{store: database} }

// CreateBot is the storage kernel input. Its configuration must already have
// been resolved by the caller; creation does not select a Worker or defaults.
type CreateBot struct {
	ID, Name              string
	Overrides             core.BotOverrides
	ResolvedConfiguration core.BotConfiguration
}

type DeleteBot struct {
	Version    int64
	DeletionID string
}

type BotPage struct {
	Items      []core.Bot
	NextCursor *string
}

func botForbidden() error {
	return &Fault{Code: "forbidden", Message: "Bot and Worker must belong to the authenticated user."}
}

func botConflict(message string) error { return &Fault{Code: "resource_conflict", Message: message} }

func botCredentialError(err error) error {
	if errors.Is(err, core.ErrNotFound) {
		return unauthenticated(err)
	}
	return err
}

func botOwner(bot core.Bot, principal core.Principal) error {
	if bot.OwnerUserID != principal.UserID {
		return botForbidden()
	}
	return nil
}

func botWorkerError(err error) error {
	if errors.Is(err, core.ErrNotFound) {
		return botForbidden()
	}
	return err
}

func normalizeBotRequest(input CreateBot) (CreateBot, string, error) {
	id, err := CanonicalID(input.ID)
	if err != nil {
		return input, "", err
	}
	input.ID = id
	if !utf8.ValidString(input.Name) || strings.ContainsFunc(input.Name, unicode.IsControl) {
		return input, "", invalidInput("Bot name must be valid Unicode without control characters.")
	}
	input.Name = strings.TrimSpace(input.Name)
	if count := utf8.RuneCountInString(input.Name); count < 1 || count > 40 {
		return input, "", invalidInput("Bot name must contain 1 to 40 characters.")
	}
	if input.Overrides.WorkerID != nil {
		id, err := CanonicalID(*input.Overrides.WorkerID)
		if err != nil {
			return input, "", err
		}
		input.Overrides.WorkerID = &id
	}
	if input.Overrides.Cwd != nil && !botAbsolutePath(*input.Overrides.Cwd) {
		return input, "", invalidInput("Bot directory must be an absolute path without control characters.")
	}
	if input.Overrides.Provider != nil && !core.WorkerAgent(*input.Overrides.Provider).Valid() {
		return input, "", invalidInput("Bot provider must be codex, claude, or copilot.")
	}
	data, err := json.Marshal(struct {
		Name      string            `json:"name"`
		Overrides core.BotOverrides `json:"overrides"`
	}{input.Name, input.Overrides})
	if err != nil {
		return input, "", err
	}
	digest := sha256.Sum256(data)
	return input, hex.EncodeToString(digest[:]), nil
}

func botAbsolutePath(value string) bool {
	if !utf8.ValidString(value) || strings.ContainsFunc(value, unicode.IsControl) {
		return false
	}
	if strings.HasPrefix(value, "/") {
		return true
	}
	if len(value) >= 3 && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) && value[1] == ':' && (value[2] == '\\' || value[2] == '/') {
		return true
	}
	if strings.HasPrefix(value, `\\`) {
		parts := strings.Split(strings.TrimPrefix(value, `\\`), `\`)
		return len(parts) >= 2 && parts[0] != "" && parts[1] != ""
	}
	return false
}

func normalizeBotConfiguration(input CreateBot) (core.BotConfiguration, error) {
	configuration := input.ResolvedConfiguration
	id, err := CanonicalID(configuration.WorkerID)
	if err != nil {
		return configuration, err
	}
	configuration.WorkerID = id
	if !botAbsolutePath(configuration.Cwd) {
		return configuration, invalidInput("Resolved Bot directory must be an absolute path without control characters.")
	}
	if !core.WorkerAgent(configuration.Provider).Valid() {
		return configuration, invalidInput("Resolved Bot provider must be codex, claude, or copilot.")
	}
	if configuration.Model != nil && (!utf8.ValidString(*configuration.Model) || strings.TrimSpace(*configuration.Model) == "" || strings.ContainsRune(*configuration.Model, 0)) {
		return configuration, invalidInput("Resolved Bot model must be nonempty Unicode without NUL.")
	}
	if configuration.Args == nil {
		configuration.Args = []string{}
	}
	for _, arg := range configuration.Args {
		if !utf8.ValidString(arg) || strings.ContainsRune(arg, 0) {
			return configuration, invalidInput("Resolved Bot arguments must be Unicode without NUL.")
		}
	}
	if (input.Overrides.WorkerID != nil && *input.Overrides.WorkerID != id) ||
		(input.Overrides.Cwd != nil && *input.Overrides.Cwd != configuration.Cwd) ||
		(input.Overrides.Provider != nil && *input.Overrides.Provider != configuration.Provider) {
		return configuration, invalidInput("Resolved Bot configuration must preserve explicit overrides.")
	}
	return configuration, nil
}

// Create returns the original frozen definition for an identical normalized
// request. Retries never replace its settings with newly resolved defaults.
func (s *Bots) Create(ctx context.Context, principal core.Principal, input CreateBot) (core.Bot, error) {
	return s.create(ctx, principal, input, false)
}

func (s *Bots) create(ctx context.Context, principal core.Principal, input CreateBot, resolve bool) (core.Bot, error) {
	if err := requirePrincipal(principal); err != nil {
		return core.Bot{}, err
	}
	input, fingerprint, err := normalizeBotRequest(input)
	if err != nil {
		return core.Bot{}, err
	}
	var result core.Bot
	err = s.store.WriteBot(ctx, func(tx *store.BotTx) error {
		if err := botCredentialError(tx.Credential(ctx, principal)); err != nil {
			return err
		}
		if err := tx.LockCreation(ctx, input.ID); err != nil {
			return err
		}
		current, err := tx.Bot(ctx, input.ID)
		if errors.Is(err, core.ErrNotFound) {
			if resolve {
				input.ResolvedConfiguration, err = resolveBotCreation(ctx, tx, principal, input)
				if err != nil {
					return err
				}
			}
			configuration, err := normalizeBotConfiguration(input)
			if err != nil {
				return err
			}
			if err := botWorkerError(tx.Worker(ctx, principal.UserID, configuration.WorkerID)); err != nil {
				return err
			}
			if err := tx.InsertBot(ctx, core.Bot{ID: input.ID, OwnerUserID: principal.UserID, WorkerID: configuration.WorkerID,
				Name: input.Name, RequestFingerprint: fingerprint, RequestedOverrides: input.Overrides, ResolvedConfiguration: configuration}); err != nil {
				return err
			}
			current, err = tx.Bot(ctx, input.ID)
			if err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		if err := botOwner(current, principal); err != nil {
			return err
		}
		if current.RequestFingerprint != fingerprint {
			return botConflict("Bot ID already belongs to a different creation request.")
		}
		result = current
		return botCredentialError(tx.Credential(ctx, principal))
	})
	if err != nil {
		return core.Bot{}, botResultError("create", err)
	}
	return result, nil
}

func (s *Bots) Get(ctx context.Context, principal core.Principal, id string) (core.Bot, error) {
	if err := requirePrincipal(principal); err != nil {
		return core.Bot{}, err
	}
	id, err := CanonicalID(id)
	if err != nil {
		return core.Bot{}, err
	}
	var result core.Bot
	err = s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		if _, err := snapshot.Credential(ctx, principal); err != nil {
			return botCredentialError(err)
		}
		var err error
		result, err = snapshot.Bot(ctx, id)
		if errors.Is(err, core.ErrNotFound) {
			return &Fault{Code: "not_found", Message: "Bot was not found.", Cause: err}
		}
		if err != nil {
			return err
		}
		return botOwner(result, principal)
	})
	if err != nil {
		return core.Bot{}, botResultError("get", err)
	}
	return result, nil
}

func (s *Bots) List(ctx context.Context, principal core.Principal, request PageRequest) (BotPage, error) {
	return s.list(ctx, principal, nil, request)
}

func (s *Bots) ListWorker(ctx context.Context, principal core.Principal, workerID string, request PageRequest) (BotPage, error) {
	id, err := CanonicalID(workerID)
	if err != nil {
		return BotPage{}, err
	}
	return s.list(ctx, principal, &id, request)
}

func (s *Bots) list(ctx context.Context, principal core.Principal, workerID *string, request PageRequest) (BotPage, error) {
	if err := requirePrincipal(principal); err != nil {
		return BotPage{}, err
	}
	scope := listScope{Kind: "bots", WorkerUserID: &principal.UserID, WorkerID: workerID}
	page, err := listPage(request, scope)
	if err != nil {
		return BotPage{}, err
	}
	var records store.BotPage
	err = s.store.ReadSnapshot(ctx, func(snapshot *store.Snapshot) error {
		if _, err := snapshot.Credential(ctx, principal); err != nil {
			return botCredentialError(err)
		}
		if workerID != nil {
			if err := botWorkerError(snapshot.BotWorker(ctx, principal.UserID, *workerID)); err != nil {
				return err
			}
		}
		var err error
		records, err = snapshot.Bots(ctx, principal.UserID, workerID, page)
		return err
	})
	if err != nil {
		return BotPage{}, botResultError("list", err)
	}
	result := BotPage{Items: records.Items}
	if records.HasMore {
		last := records.Items[len(records.Items)-1]
		cursor, err := encodeListCursor(scope, last.CreatedAt, last.ID)
		if err != nil {
			return BotPage{}, err
		}
		result.NextCursor = &cursor
	}
	return result, nil
}

// Delete records an intent without claiming cleanup completion. Bound Sessions
// require their deletion barrier and are refused by this definition-only path.
func (s *Bots) Delete(ctx context.Context, principal core.Principal, id string, input DeleteBot) (core.Bot, error) {
	if err := requirePrincipal(principal); err != nil {
		return core.Bot{}, err
	}
	id, err := CanonicalID(id)
	if err != nil {
		return core.Bot{}, err
	}
	input.DeletionID, err = CanonicalID(input.DeletionID)
	if err != nil {
		return core.Bot{}, err
	}
	if input.Version < 1 {
		return core.Bot{}, invalidInput("Bot version must be positive.")
	}
	var result core.Bot
	err = s.store.WriteBot(ctx, func(tx *store.BotTx) error {
		if err := botCredentialError(tx.Credential(ctx, principal)); err != nil {
			return err
		}
		current, err := tx.Bot(ctx, id)
		if errors.Is(err, core.ErrNotFound) {
			return &Fault{Code: "not_found", Message: "Bot was not found.", Cause: err}
		}
		if err != nil {
			return err
		}
		if err := botOwner(current, principal); err != nil {
			return err
		}
		if current.Deletion != nil {
			if current.Deletion.DeletionID != input.DeletionID || current.Deletion.RequestedVersion != input.Version {
				return botConflict("Bot deletion belongs to a different request.")
			}
			result = current
			return botCredentialError(tx.Credential(ctx, principal))
		}
		if current.Version != input.Version {
			return &Fault{Code: "version_conflict", Message: "Bot version has changed."}
		}
		if current.SessionID != nil {
			return botConflict("A bound Bot requires the Session deletion barrier.")
		}
		if current.Version == math.MaxInt64 {
			return &Fault{Code: "version_exhausted", Message: "Bot version cannot advance."}
		}
		result, err = tx.DeleteBot(ctx, id, input.Version, core.BotDeletion{DeletionID: input.DeletionID, RequestedVersion: input.Version,
			WorkerCleanup: core.BotCleanupResult{State: "pending"}, ServerCleanup: core.BotCleanupResult{State: "pending"}})
		if err != nil {
			return err
		}
		return botCredentialError(tx.Credential(ctx, principal))
	})
	if err != nil {
		return core.Bot{}, botResultError("delete", err)
	}
	return result, nil
}

// BotOperationError preserves storage and transaction failures without turning
// an embedded business refusal into a confirmed rejection after failed cleanup.
type BotOperationError struct {
	Operation string
	Cause     error
}

func (e *BotOperationError) Error() string { return fmt.Sprintf("%s bot: %v", e.Operation, e.Cause) }
func (e *BotOperationError) Unwrap() error { return e.Cause }

func botResultError(operation string, err error) error {
	var transaction *store.TransactionError
	if errors.As(err, &transaction) && transaction.Phase == "operation" && !transaction.CleanupFailed && transaction.Outcome == store.TransactionNotCommitted {
		if fault, ok := transaction.Cause.(*Fault); ok {
			return fault
		}
	}
	return &BotOperationError{Operation: operation, Cause: err}
}
