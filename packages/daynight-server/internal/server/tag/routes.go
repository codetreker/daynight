package tag

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	tagprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/tag"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
	tagservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/tag"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/jsonunicode"
)

type operations[A any] interface {
	List(context.Context, A, string, tagservice.ListInput) (tagservice.Page, error)
	Get(context.Context, A, string, string) (tagservice.Item, error)
	Create(context.Context, A, string, string, *string) (tagservice.WriteResult, error)
	Update(context.Context, A, string, string, int64, *string, *string) (tagservice.WriteResult, error)
	Delete(context.Context, A, string, string, int64, bool) (tagservice.WriteResult, error)
	Resolve(context.Context, A, string, []string) ([]model.TagReference, error)
	ResolveColors(context.Context, A, string, []string, *string) (tagservice.ColorPage, error)
}

type Operations = operations[model.Principal]
type ScopedOperations = operations[model.CredentialAuthorization]

type Authentication interface {
	Require(httpx.AuthenticatedHandler) http.HandlerFunc
}

type AuthorizedHandler = func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)

type ScopedAuthentication interface {
	RequireAuthorization(AuthorizedHandler) http.HandlerFunc
}

type handler[A any] struct {
	operations operations[A]
	principal  func(A) model.Principal
	logger     *slog.Logger
}

// RegisterRoutes mounts the authenticated project tag catalog endpoints.
func RegisterRoutes(mux httpx.RouteRegistrar, ops Operations, auth Authentication, logger *slog.Logger) {
	registerRoutes(mux, ops, func(next func(http.ResponseWriter, *http.Request, model.Principal)) http.HandlerFunc {
		return auth.Require(httpx.AuthenticatedHandler(next))
	}, func(p model.Principal) model.Principal { return p }, logger)
}

// RegisterScopedRoutes requires an explicitly authenticated policy snapshot.
// Production selects this registration only when scoped credentials are enabled.
func RegisterScopedRoutes(mux httpx.RouteRegistrar, ops ScopedOperations, auth ScopedAuthentication, logger *slog.Logger) {
	registerRoutes(mux, ops, func(next func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc {
		return auth.RequireAuthorization(func(w http.ResponseWriter, r *http.Request, a model.CredentialAuthorization) {
			if err := a.Validate(); err != nil {
				writeError(w, r, logger, "authorization", err)
				return
			}
			next(w, r, a)
		})
	}, func(a model.CredentialAuthorization) model.Principal { return a.Principal }, logger)
}

func registerRoutes[A any](mux httpx.RouteRegistrar, ops operations[A], authenticate func(func(http.ResponseWriter, *http.Request, A)) http.HandlerFunc, principal func(A) model.Principal, logger *slog.Logger) {
	h := &handler[A]{operations: ops, principal: principal, logger: logger}
	methodNotAllowed := func(allowed string) func(http.ResponseWriter, *http.Request, A) {
		return func(w http.ResponseWriter, r *http.Request, a A) {
			httpx.ResourceMethodNotAllowed(logger, allowed)(w, r, principal(a))
		}
	}
	rejectMethod := func(allowed string) http.HandlerFunc {
		return httpx.MethodRejection(authenticate(methodNotAllowed(allowed)))
	}

	mux.HandleFunc("GET /api/v1/projects/{projectId}/tags", authenticate(h.list))
	mux.HandleFunc("POST /api/v1/projects/{projectId}/tags", authenticate(h.create))
	mux.HandleFunc("/api/v1/projects/{projectId}/tags", rejectMethod("GET, HEAD, POST"))
	mux.HandleFunc("POST /api/v1/projects/{projectId}/tags/resolve", authenticate(h.resolve))
	mux.HandleFunc("POST /api/v1/projects/{projectId}/tags/colors/resolve", authenticate(h.resolveColors))
	mux.HandleFunc("/api/v1/projects/{projectId}/tags/colors/resolve", rejectMethod("POST"))
	for _, method := range []string{"GET", "PATCH", "DELETE"} {
		mux.HandleFunc(method+" /api/v1/projects/{projectId}/tags/resolve", rejectMethod("POST"))
	}
	mux.HandleFunc("GET /api/v1/projects/{projectId}/tags/{tagId}", authenticate(h.get))
	mux.HandleFunc("PATCH /api/v1/projects/{projectId}/tags/{tagId}", authenticate(h.rename))
	mux.HandleFunc("DELETE /api/v1/projects/{projectId}/tags/{tagId}", authenticate(h.delete))
	mux.HandleFunc("/api/v1/projects/{projectId}/tags/{tagId}", httpx.MethodRejection(authenticate(func(w http.ResponseWriter, r *http.Request, principal A) {
		allowed := "GET, HEAD, PATCH, DELETE"
		if r.PathValue("tagId") == "resolve" {
			allowed = "POST"
		}
		methodNotAllowed(allowed)(w, r, principal)
	})))
}

func tagResponse(item tagservice.Item) api.Tag {
	t := item.Tag
	return api.Tag{ID: t.ID, ProjectID: t.ProjectID, Name: t.Name, Version: t.Version, CreatedAt: t.CreatedAt.UTC(), UpdatedAt: t.UpdatedAt.UTC(), Usage: api.TagUsage{Tasks: item.Usage.Tasks, Goals: item.Usage.Goals}}
}

func (h *handler[A]) resource(w http.ResponseWriter, r *http.Request, p A, withTag bool) (string, string, *slog.Logger, error) {
	w.Header().Set("Cache-Control", "no-store")
	logger := h.logger.With("user_id", h.principal(p).UserID)
	projectID, err := model.CanonicalID(r.PathValue("projectId"))
	if err != nil {
		return "", "", logger, err
	}
	logger = logger.With("project_id", projectID)
	if !withTag {
		return projectID, "", logger, nil
	}
	tagID, err := model.CanonicalID(r.PathValue("tagId"))
	if err != nil {
		return "", "", logger, err
	}
	return projectID, tagID, logger.With("tag_id", tagID), nil
}

func (h *handler[A]) list(w http.ResponseWriter, r *http.Request, p A) {
	projectID, _, logger, err := h.resource(w, r, p, false)
	if err == nil {
		var valuesErr error
		values, e := httpx.QueryValues(r, "query", "limit", "cursor")
		valuesErr = e
		if valuesErr == nil {
			page, e := httpx.PageValues(values)
			valuesErr = e
			if valuesErr == nil {
				query := values.Get("query")
				if !utf8.ValidString(query) {
					valuesErr = httpx.InvalidInput("query must contain valid Unicode text")
				} else {
					cursor := ""
					if page.Cursor != nil {
						cursor = *page.Cursor
					}
					result, e := h.operations.List(r.Context(), p, projectID, tagservice.ListInput{Query: query, Limit: page.Limit, Cursor: cursor})
					if e == nil {
						out := api.TagPage{Items: make([]api.Tag, 0, len(result.Items)), CatalogEpoch: result.CatalogEpoch, NextCursor: result.NextCursor}
						for _, item := range result.Items {
							out.Items = append(out.Items, tagResponse(item))
						}
						httpx.WriteJSON(w, r, logger, http.StatusOK, out)
						return
					}
					valuesErr = e
				}
			}
		}
		err = valuesErr
	}
	writeError(w, r, logger, "list", err)
}

func (h *handler[A]) get(w http.ResponseWriter, r *http.Request, p A) {
	projectID, tagID, logger, err := h.resource(w, r, p, true)
	if err == nil {
		_, err = httpx.QueryValues(r)
	}
	if err == nil {
		var item tagservice.Item
		item, err = h.operations.Get(r.Context(), p, projectID, tagID)
		if err == nil {
			httpx.WriteJSON(w, r, logger, http.StatusOK, tagResponse(item))
			return
		}
	}
	writeError(w, r, logger, "get", err)
}

func (h *handler[A]) create(w http.ResponseWriter, r *http.Request, p A) {
	projectID, _, logger, err := h.resource(w, r, p, false)
	if err == nil {
		_, err = httpx.QueryValues(r)
	}
	var name string
	var color *string
	if err == nil {
		fields, e := httpx.DecodeObject(w, r, "name", "color")
		err = e
		if err == nil {
			if !jsonunicode.Valid(fields["name"]) {
				err = httpx.InvalidInput("name must contain valid Unicode text")
			} else {
				name, err = httpx.RequiredString(fields, "name")
			}
			if err == nil {
				color, err = optionalText(fields, "color")
			}
		}
	}
	if err == nil {
		var result tagservice.WriteResult
		result, err = h.operations.Create(r.Context(), p, projectID, name, color)
		if err == nil {
			logger = logger.With("tag_id", result.Item.Tag.ID, "tx_outcome", string(result.Outcome), "phase", result.Phase)
			logger.InfoContext(r.Context(), "tag created", "component", "tag", "request_id", httpx.RequestID(r.Context()))
			w.Header().Set("Location", "/api/v1/projects/"+projectID+"/tags/"+result.Item.Tag.ID)
			httpx.WriteMutationJSON(w, r, logger, "tag", http.StatusCreated, tagResponse(result.Item))
			return
		}
		writeMutationError(w, r, logger, "create", result, err)
		return
	}
	writeError(w, r, logger, "create", err)
}

func (h *handler[A]) rename(w http.ResponseWriter, r *http.Request, p A) {
	projectID, tagID, logger, err := h.resource(w, r, p, true)
	if err == nil {
		_, err = httpx.QueryValues(r)
	}
	var version int64
	var name, color *string
	if err == nil {
		fields, e := httpx.DecodeObject(w, r, "version", "name", "color")
		err = e
		if err == nil {
			version, err = httpx.VersionInput(fields)
		}
		if err == nil {
			name, err = optionalText(fields, "name")
		}
		if err == nil {
			color, err = optionalText(fields, "color")
		}
		if err == nil && name == nil && color == nil {
			err = httpx.InvalidInput("at least one of name or color is required")
		}
	}
	if err == nil {
		var result tagservice.WriteResult
		result, err = h.operations.Update(r.Context(), p, projectID, tagID, version, name, color)
		if err == nil {
			logger = logger.With("tx_outcome", string(result.Outcome), "phase", result.Phase)
			logger.InfoContext(r.Context(), "tag updated", "component", "tag", "request_id", httpx.RequestID(r.Context()))
			httpx.WriteMutationJSON(w, r, logger, "tag", http.StatusOK, tagResponse(result.Item))
			return
		}
		writeMutationError(w, r, logger, "rename", result, err)
		return
	}
	writeError(w, r, logger, "rename", err)
}

func optionalText(fields map[string]json.RawMessage, key string) (*string, error) {
	if !jsonunicode.Valid(fields[key]) {
		return nil, httpx.InvalidInput(key + " must contain valid Unicode text")
	}
	return httpx.OptionalString(fields, key)
}

func (h *handler[A]) delete(w http.ResponseWriter, r *http.Request, p A) {
	projectID, tagID, logger, err := h.resource(w, r, p, true)
	if err == nil {
		_, err = httpx.QueryValues(r)
	}
	var version int64
	if err == nil {
		fields, e := httpx.DecodeObject(w, r, "version", "confirm")
		err = e
		if err == nil {
			version, err = httpx.VersionInput(fields)
		}
		if err == nil {
			var confirm *bool
			confirm, err = httpx.OptionalBool(fields, "confirm")
			if err == nil && (confirm == nil || !*confirm) {
				err = &model.Fault{Code: "confirmation_required", Message: "Tag deletion requires explicit confirmation."}
			}
		}
	}
	if err == nil {
		var result tagservice.WriteResult
		result, err = h.operations.Delete(r.Context(), p, projectID, tagID, version, true)
		if err == nil {
			logger = logger.With("tx_outcome", string(result.Outcome), "phase", result.Phase)
			logger.InfoContext(r.Context(), "tag deleted", "component", "tag", "request_id", httpx.RequestID(r.Context()))
			httpx.WriteMutationJSON(w, r, logger, "tag", http.StatusOK, api.TagDeletionReceipt{ProjectID: result.ProjectID, TagID: result.TagID, Deleted: result.Deleted})
			return
		}
		writeMutationError(w, r, logger, "delete", result, err)
		return
	}
	writeError(w, r, logger, "delete", err)
}

func (h *handler[A]) resolve(w http.ResponseWriter, r *http.Request, p A) {
	projectID, _, logger, err := h.resource(w, r, p, false)
	if err == nil {
		_, err = httpx.QueryValues(r)
	}
	var ids *[]string
	if err == nil {
		fields, e := httpx.DecodeObject(w, r, "tagIds")
		err = e
		if err == nil {
			if !jsonunicode.Valid(fields["tagIds"]) {
				err = httpx.InvalidInput("tagIds must contain valid Unicode text")
			} else {
				ids, err = httpx.OptionalStrings(fields, "tagIds")
			}
			if err == nil && ids == nil {
				err = httpx.InvalidInput("tagIds is required and must be an array of strings")
			}
		}
	}
	if err == nil {
		var refs []model.TagReference
		refs, err = h.operations.Resolve(r.Context(), p, projectID, *ids)
		if err == nil {
			var body bytes.Buffer
			_, err = tagprotocol.EncodeResolve(&body, refs)
			if err == nil {
				if r.Context().Err() != nil {
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				n, e := w.Write(body.Bytes())
				if e == nil && n != body.Len() {
					e = io.ErrShortWrite
				}
				if e != nil {
					httpx.LogFailure(logger, r.Context(), "tag", "response", e)
				}
				return
			}
			err = &model.Fault{Code: "resource_limit_exceeded", Message: "Tag resolution response exceeds its encoded resource limit.", Cause: err}
		}
	}
	writeError(w, r, logger, "resolve", err)
}

func (h *handler[A]) resolveColors(w http.ResponseWriter, r *http.Request, p A) {
	projectID, _, logger, err := h.resource(w, r, p, false)
	if err == nil {
		_, err = httpx.QueryValues(r)
	}
	var ids *[]string
	var epoch *string
	if err == nil {
		var fields map[string]json.RawMessage
		fields, err = httpx.DecodeObject(w, r, "tagIds", "catalogEpoch")
		if err == nil {
			if !jsonunicode.Valid(fields["tagIds"]) {
				err = httpx.InvalidInput("tagIds must contain valid Unicode text")
			} else {
				ids, err = httpx.OptionalStrings(fields, "tagIds")
			}
			if err == nil && ids == nil {
				err = httpx.InvalidInput("tagIds is required and must be an array of strings")
			}
		}
		if err == nil {
			epoch, err = optionalText(fields, "catalogEpoch")
		}
	}
	if err == nil {
		var page tagservice.ColorPage
		page, err = h.operations.ResolveColors(r.Context(), p, projectID, *ids, epoch)
		if err == nil {
			response := api.TagColorPage{CatalogEpoch: page.CatalogEpoch, Items: make([]api.TagColorItem, 0, len(page.Items))}
			for _, item := range page.Items {
				out := api.TagColorItem{ID: item.ID, State: "missing"}
				if item.Found {
					out.State, out.Version, out.Color = "found", &item.Version, &item.Color
				}
				response.Items = append(response.Items, out)
			}
			var body bytes.Buffer
			_, err = tagprotocol.EncodeColors(&body, response)
			if err == nil {
				if r.Context().Err() != nil {
					return
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusOK)
				n, e := w.Write(body.Bytes())
				if e == nil && n != body.Len() {
					e = io.ErrShortWrite
				}
				if e != nil {
					httpx.LogFailure(logger, r.Context(), "tag", "response", e)
				}
				return
			}
			err = &model.Fault{Code: "resource_limit_exceeded", Message: "Tag color resolution response exceeds its encoded resource limit.", Cause: err}
		}
	}
	writeError(w, r, logger, "resolve_colors", err)
}

func writeMutationError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, phase string, result tagservice.WriteResult, err error) {
	logger = logger.With("tx_outcome", string(result.Outcome), "tx_phase", result.Phase, "cleanup_failed", result.CleanupFailed)
	facts := operation.CompletionFacts(err)
	if result.Outcome == store.TransactionUnknown || result.Outcome == store.TransactionCommitted || facts.Outcome == store.TransactionUnknown || facts.Outcome == store.TransactionCommitted {
		httpx.LogFailure(logger.With("write_outcome", "unknown"), r.Context(), "tag", phase, err)
		httpx.WriteJSON(w, r, logger, http.StatusServiceUnavailable, api.ErrorResponse{Error: api.Error{Code: "write_outcome_unknown", Message: "The tag write outcome is unknown.", RequestID: httpx.RequestID(r.Context())}})
		return
	}
	if result.Outcome == store.TransactionNotCommitted && !result.CleanupFailed && safeNameConflict(err) {
		httpx.LogFailure(logger, r.Context(), "tag", phase, err)
		httpx.WriteJSON(w, r, logger, http.StatusConflict, api.ErrorResponse{Error: api.Error{Code: "tag_name_conflict", Message: "A tag with this name already exists.", RequestID: httpx.RequestID(r.Context())}})
		return
	}
	if errors.Is(err, store.ErrTagNameConflict) {
		httpx.LogFailure(logger, r.Context(), "tag", phase, err)
		httpx.WriteJSON(w, r, logger, http.StatusInternalServerError, api.ErrorResponse{Error: api.Error{Code: "internal_error", Message: "internal server error", RequestID: httpx.RequestID(r.Context())}})
		return
	}
	writeError(w, r, logger, phase, err)
}

// The DAO marks only the specific unique index. Store wrappers above that
// marker summarize the same failure; the marked branch must contain exactly
// one database error. Additional branches and unreliable completion are unsafe.
func safeNameConflict(err error) bool {
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
			if !errors.Is(e.Cause, store.ErrTagNameConflict) {
				databases++
			}
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
	return valid && transactions == 1 && databases == 1 && markers == 1
}

func writeError(w http.ResponseWriter, r *http.Request, logger *slog.Logger, phase string, err error) {
	if fault, ok := httpx.KnownFault(err); ok && httpx.ErrorKind(err) == fault.Code {
		status := 0
		switch fault.Code {
		case "insufficient_scope":
			httpx.CloseUnreadBody(w, r)
			httpx.LogFailure(logger, r.Context(), "tag", phase, err)
			w.Header().Set("Daynight-Scope-Status", "insufficient_scope")
			httpx.WriteJSON(w, r, logger, http.StatusForbidden, api.ErrorResponse{Error: api.Error{Code: "forbidden", Message: fault.Message, RequestID: httpx.RequestID(r.Context())}})
			return
		case "invalid_tag_name", "invalid_tag_color", "invalid_tag_filter", "confirmation_required":
			status = http.StatusBadRequest
		case "tag_not_found":
			status = http.StatusNotFound
		case "tag_name_conflict", "catalog_changed":
			status = http.StatusConflict
		}
		if status != 0 {
			httpx.CloseUnreadBody(w, r)
			httpx.LogFailure(logger, r.Context(), "tag", phase, err)
			httpx.WriteJSON(w, r, logger, status, api.ErrorResponse{Error: api.Error{Code: fault.Code, Message: fault.Message, RequestID: httpx.RequestID(r.Context())}})
			return
		}
	}
	httpx.WriteError(w, r, logger, "tag", phase, err)
}
