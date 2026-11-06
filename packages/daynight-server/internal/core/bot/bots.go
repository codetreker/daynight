package bot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/query"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func invalidInput(message string) error { return &model.Fault{Code: "invalid_input", Message: message} }

// CreateBot is the storage kernel input. Its configuration must already have
// been resolved by the caller; creation does not select a Worker or defaults.
type CreateBot struct {
	ID, Name              string
	Overrides             model.BotOverrides
	ResolvedConfiguration model.BotConfiguration
	Resolution            *CreationResolution
	ResolutionError       error
}

type BotPage struct {
	Items      []model.Bot
	NextCursor *string
}

func botForbidden() error {
	return &model.Fault{Code: "forbidden", Message: "Bot and Worker must belong to the authenticated user."}
}

func botConflict(message string) error {
	return &model.Fault{Code: "resource_conflict", Message: message}
}

func botCredentialError(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return model.Unauthenticated(err)
	}
	return err
}

func botOwner(bot model.Bot, principal model.Principal) error {
	if bot.OwnerUserID != principal.UserID {
		return botForbidden()
	}
	return nil
}

func botWorkerError(err error) error {
	if errors.Is(err, model.ErrNotFound) {
		return botForbidden()
	}
	return err
}

func NormalizeBotRequest(input CreateBot) (CreateBot, string, error) {
	id, err := model.CanonicalID(input.ID)
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
		id, err := model.CanonicalID(*input.Overrides.WorkerID)
		if err != nil {
			return input, "", err
		}
		input.Overrides.WorkerID = &id
	}
	if input.Overrides.Cwd != nil && !botAbsolutePath(*input.Overrides.Cwd) {
		return input, "", invalidInput("Bot directory must be an absolute path without control characters.")
	}
	if input.Overrides.Provider != nil && !model.WorkerAgent(*input.Overrides.Provider).Valid() {
		return input, "", invalidInput("Bot provider must be codex, claude, or copilot.")
	}
	if err := NormalizeOverrides(input.Overrides); err != nil {
		return input, "", err
	}
	data, err := json.Marshal(struct {
		Name      string             `json:"name"`
		Overrides model.BotOverrides `json:"overrides"`
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

func normalizeBotConfiguration(input CreateBot) (model.BotConfiguration, error) {
	configuration := input.ResolvedConfiguration
	id, err := model.CanonicalID(configuration.WorkerID)
	if err != nil {
		return configuration, err
	}
	configuration.WorkerID = id
	if !botAbsolutePath(configuration.Cwd) {
		return configuration, invalidInput("Resolved Bot directory must be an absolute path without control characters.")
	}
	if !model.WorkerAgent(configuration.Provider).Valid() {
		return configuration, invalidInput("Resolved Bot provider must be codex, claude, or copilot.")
	}
	if configuration.Model != nil && (!utf8.ValidString(*configuration.Model) || strings.TrimSpace(*configuration.Model) == "" || strings.ContainsRune(*configuration.Model, 0)) {
		return configuration, invalidInput("Resolved Bot model must be nonempty Unicode without NUL.")
	}
	if err := validateSelection(configuration); err != nil {
		return configuration, err
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
		(input.Overrides.Provider != nil && *input.Overrides.Provider != configuration.Provider) ||
		(input.Overrides.Model != nil && (configuration.Model == nil || *input.Overrides.Model != *configuration.Model)) ||
		(input.Overrides.ReasoningEffort != nil && (configuration.ReasoningEffort == nil || *input.Overrides.ReasoningEffort != *configuration.ReasoningEffort)) {
		return configuration, invalidInput("Resolved Bot configuration must preserve explicit overrides.")
	}
	return configuration, nil
}

// Create applies the creation rules within the caller's write transaction.
func Create(ctx context.Context, tx store.BotWriteDAO, principal model.Principal, input CreateBot, fingerprint string, resolve bool) (model.Bot, error) {
	if err := botCredentialError(tx.Credential(ctx, principal)); err != nil {
		return model.Bot{}, err
	}
	if err := tx.LockCreation(ctx, input.ID); err != nil {
		return model.Bot{}, err
	}
	current, err := tx.Bot(ctx, input.ID)
	if errors.Is(err, model.ErrNotFound) {
		if input.ResolutionError != nil {
			return model.Bot{}, input.ResolutionError
		}
		if resolve {
			input.ResolvedConfiguration, err = resolveBotCreation(ctx, tx, principal, input)
			if err != nil {
				return model.Bot{}, err
			}
		}
		configuration, err := normalizeBotConfiguration(input)
		if err != nil {
			return model.Bot{}, err
		}
		if err := botWorkerError(tx.Worker(ctx, principal.UserID, configuration.WorkerID)); err != nil {
			return model.Bot{}, err
		}
		if err := tx.InsertBot(ctx, model.Bot{ID: input.ID, OwnerUserID: principal.UserID, WorkerID: configuration.WorkerID, Name: input.Name, RequestFingerprint: fingerprint, RequestedOverrides: input.Overrides, ResolvedConfiguration: configuration}); err != nil {
			return model.Bot{}, err
		}
		current, err = tx.Bot(ctx, input.ID)
		if err != nil {
			return model.Bot{}, err
		}
	} else if err != nil {
		return model.Bot{}, err
	}
	if err := botOwner(current, principal); err != nil {
		return model.Bot{}, err
	}
	if current.RequestFingerprint != fingerprint {
		return model.Bot{}, botConflict("Bot ID already belongs to a different creation request.")
	}
	return current, botCredentialError(tx.Credential(ctx, principal))
}

func Get(ctx context.Context, snapshot store.SnapshotScope, principal model.Principal, id string) (model.Bot, error) {
	if _, err := snapshot.CredentialDAO().Credential(ctx, principal); err != nil {
		return model.Bot{}, botCredentialError(err)
	}
	result, err := snapshot.BotDAO().Bot(ctx, id)
	if errors.Is(err, model.ErrNotFound) {
		return model.Bot{}, &model.Fault{Code: "not_found", Message: "Bot was not found.", Cause: err}
	}
	if err != nil {
		return model.Bot{}, err
	}
	return result, botOwner(result, principal)
}

func List(ctx context.Context, snapshot store.SnapshotScope, principal model.Principal, workerID *string, page store.Page) (store.BotPage, error) {
	if _, err := snapshot.CredentialDAO().Credential(ctx, principal); err != nil {
		return store.BotPage{}, botCredentialError(err)
	}
	if workerID != nil {
		if err := botWorkerError(snapshot.BotDAO().BotWorker(ctx, principal.UserID, *workerID)); err != nil {
			return store.BotPage{}, err
		}
	}
	return snapshot.BotDAO().Bots(ctx, principal.UserID, workerID, page)
}

func ListPage(principal model.Principal, workerID *string, request model.PageRequest) (store.Page, error) {
	return query.ListPage(request, query.ListScope{Kind: "bots", WorkerUserID: &principal.UserID, WorkerID: workerID})
}
func ListResult(principal model.Principal, workerID *string, records store.BotPage) (BotPage, error) {
	result := BotPage{Items: records.Items}
	if records.HasMore {
		last := records.Items[len(records.Items)-1]
		cursor, err := query.EncodeListCursor(query.ListScope{Kind: "bots", WorkerUserID: &principal.UserID, WorkerID: workerID}, last.CreatedAt, last.ID)
		if err != nil {
			return BotPage{}, err
		}
		result.NextCursor = &cursor
	}
	return result, nil
}

func ResultError(operation string, err error) error {
	var transaction *store.TransactionError
	if errors.As(err, &transaction) && transaction.Phase == "operation" && !transaction.CleanupFailed && transaction.Outcome == store.TransactionNotCommitted {
		if fault, ok := transaction.Cause.(*model.Fault); ok {
			return fault
		}
	}
	return &model.BotOperationError{Operation: operation, Cause: err}
}
